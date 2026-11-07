// Which AI answers when the first choice can't, and how shared limits are split.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-llm-"));
process.env.JARVIS_PASSCODE = "owner-pass";
process.env.GROQ_API_KEY = "test";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
process.env.CLOUDFLARE_API_TOKEN = "test";
delete process.env.JARVIS_USERS;

const { chat, ShareUsedError } = await import("../lib/llm.mjs");
const { findUser, runAsUser } = await import("../lib/users.mjs");

const MAIN = "openai/gpt-oss-120b";
const SMALL = "openai/gpt-oss-20b";
const BACKUP = "@cf/openai/gpt-oss-120b";
const answer = (content, usage = { total_tokens: 100, prompt_tokens: 50, completion_tokens: 50 }) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage }));
const limited = () => new Response("Rate limit reached", { status: 429 });

let sent;
/** Each model's behaviour; anything not listed answers normally. */
let behaviour;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body, init });
  const respond = behaviour[body.model];
  return respond ? respond() : answer(`Hello from ${body.model}`);
};
test.after(() => { globalThis.fetch = realFetch; });

const realNow = Date.now;
beforeEach(() => {
  sent = [];
  behaviour = {};
  delete process.env.JARVIS_USERS;
  Date.now = realNow;
  fs.rmSync(process.env.JARVIS_LOCAL_STORE, { recursive: true, force: true });
  fs.mkdirSync(process.env.JARVIS_LOCAL_STORE, { recursive: true });
});
test.after(() => { Date.now = realNow; });

const ask = (options = {}) => chat({ messages: [{ role: "user", content: "Hi" }], ...options });
const models = () => sent.map((s) => s.body.model);

test("the main model answers when it can, with little hidden reasoning and a time limit", async () => {
  assert.equal((await ask()).content, `Hello from ${MAIN}`);
  assert.deepEqual(models(), [MAIN]);
  assert.equal(sent[0].body.reasoning_effort, "low");
  assert.ok(sent[0].init.signal);
});

test("when Groq's models are limited, Cloudflare answers on its own URL and key", async () => {
  behaviour = { [MAIN]: limited, [SMALL]: limited };
  assert.equal((await ask()).content, `Hello from ${BACKUP}`);
  assert.deepEqual(models(), [MAIN, SMALL, BACKUP]);
  assert.match(sent[2].url, /accounts\/acct\/ai\/v1\/chat\/completions/);
});

const failures = {
  "a made-up tool": () => new Response('{"error":{"code":"tool_use_failed"}}', { status: 400 }),
  "an outage": () => new Response("down", { status: 503 }),
  "a rejected key": () => new Response("no", { status: 401 }),
  "an empty reply": () => answer(""),
  "leaked reasoning": () => answer("<|channel|>analysis We should say hello.<|end|>"),
  "nonsense": () => new Response("not json"),
  "being too slow": () => { throw new DOMException("timed out", "TimeoutError"); },
  "no connection": () => { throw new TypeError("fetch failed"); },
};
for (const [name, failure] of Object.entries(failures)) {
  test(`the next model is tried after ${name}`, async () => {
    behaviour = { [MAIN]: failure };
    assert.equal((await ask()).content, `Hello from ${SMALL}`);
  });
}

test("a tool call with no text counts as an answer", async () => {
  const toolCall = { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } };
  behaviour = { [MAIN]: () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCall] } }] })) };
  assert.deepEqual((await ask()).tool_calls, [toolCall]);
  assert.deepEqual(models(), [MAIN]);
});

test("a mistake in the request isn't tried elsewhere", async () => {
  behaviour = { [MAIN]: () => new Response("bad request", { status: 400 }) };
  await assert.rejects(ask(), /Groq openai\/gpt-oss-120b 400/);
  assert.deepEqual(models(), [MAIN]);
});

test("work that can be skipped doesn't use the backup", async () => {
  behaviour = { [SMALL]: limited };
  await assert.rejects(ask({ model: SMALL, backup: false }), (e) => e.status === 429);
  assert.deepEqual(models(), [SMALL]);
});

test("a bad reply from the backup gets a second try", async () => {
  let tries = 0;
  behaviour = {
    [MAIN]: limited,
    [SMALL]: limited,
    [BACKUP]: () => (++tries === 1 ? answer("<|channel|>analysis Thinking.<|end|>") : answer("A clean reply")),
  };
  assert.equal((await ask()).content, "A clean reply");
});

test("with everything limited, the error says it was a limit", async () => {
  behaviour = { [MAIN]: limited, [SMALL]: limited, [BACKUP]: limited };
  await assert.rejects(ask(), (e) => e.status === 429);
});

test("without a Cloudflare account, it stops after Groq", async () => {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    behaviour = { [MAIN]: limited, [SMALL]: limited };
    await assert.rejects(ask(), (e) => e.status === 429);
    assert.deepEqual(models(), [MAIN, SMALL]);
  } finally {
    process.env.CLOUDFLARE_ACCOUNT_ID = account;
  }
});

test("the backup stops at its daily allowance, leaving the rest for images", async () => {
  behaviour = { [MAIN]: limited, [SMALL]: limited };
  const big = { prompt_tokens: 100_000, completion_tokens: 40_000 }; // about 5,900 Neurons, over the 5,000
  behaviour[BACKUP] = () => answer("Backup", big);
  assert.equal((await ask()).content, "Backup");
  sent = [];
  await assert.rejects(ask(), (e) => e instanceof ShareUsedError && e.daily);
  assert.deepEqual(models(), [MAIN, SMALL]); // nothing more went to Cloudflare
});

test("the backup's allowance resets each day", async () => {
  behaviour = { [MAIN]: limited, [SMALL]: limited, [BACKUP]: () => answer("Backup", { prompt_tokens: 100_000, completion_tokens: 40_000 }) };
  const day = Date.UTC(2030, 0, 1);
  Date.now = () => day;
  await ask();
  await assert.rejects(ask(), ShareUsedError);
  Date.now = () => day + 86_400_000;
  assert.equal((await ask()).content, "Backup");
});

test("Groq's daily limit is split equally, and one person using theirs doesn't affect the other", async () => {
  process.env.JARVIS_USERS = JSON.stringify([{ id: "sam", name: "Sam", passcode: "sam-pass" }]);
  const sam = findUser("sam");
  const owner = findUser(null);
  behaviour = { [MAIN]: () => answer("Big", { total_tokens: 60_000 }), [SMALL]: () => answer("Big small", { total_tokens: 60_000 }), [BACKUP]: limited };

  // A new minute each time, so only the daily limit is in play. Each person's share is 100,000 a model.
  let minute = Date.UTC(2030, 0, 1);
  Date.now = () => (minute += 60_000);
  await runAsUser(sam, () => ask());
  await runAsUser(sam, () => ask()); // 120,000: Sam is over on the main model
  sent = [];
  assert.equal((await runAsUser(sam, () => ask())).content, "Big small");
  assert.deepEqual(models(), [SMALL]);
  await runAsUser(sam, () => ask()); // now over on the smaller one too

  sent = [];
  await assert.rejects(runAsUser(sam, () => ask()), (e) => e instanceof ShareUsedError && e.daily);
  assert.ok(!models().includes(MAIN) && !models().includes(SMALL));

  sent = [];
  assert.equal((await runAsUser(owner, () => ask())).content, "Big");
  assert.deepEqual(models(), [MAIN]);
});

test("someone on their own has no shares to keep to", async () => {
  behaviour = { [MAIN]: () => answer("Big", { total_tokens: 300_000 }) };
  await ask();
  sent = [];
  await ask();
  assert.deepEqual(models(), [MAIN]);
});
