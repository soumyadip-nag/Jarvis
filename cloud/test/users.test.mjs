// Several people on one Jarvis: separate data, separate logins, equal shares.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "owner passcode for tests";
const SAM = "sam passcode for tests";
process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-users-"));
process.env.JARVIS_PASSCODE = OWNER;
process.env.USER_NAME = "Ushnish";
process.env.GROQ_API_KEY = "test";
process.env.SERPAPI_KEY = "test";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
process.env.CLOUDFLARE_API_TOKEN = "test";
const USERS = JSON.stringify([{ id: "sam", name: "Sam Example", honorific: "Sam", passcode: SAM }]);
process.env.JARVIS_USERS = USERS;

const say = (content, tokens = 100) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: tokens } });
const toolCall = (name, args) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { total_tokens: 100 },
});
const prompts = [];
let searches = 0;
let images = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("serpapi")) { searches++; return new Response(JSON.stringify({ organic_results: [{ title: "T", snippet: "S" }] })); }
  if (u.includes("/ai/v1/chat")) return new Response("no backup in this test", { status: 429 });
  if (u.includes("cloudflare")) { images++; return new Response(JSON.stringify({ result: { image: Buffer.from("jpeg").toString("base64") } })); }
  if (u.includes("open-meteo")) throw new Error("not needed");
  const body = JSON.parse(init.body);
  if (body.response_format) {
    const said = body.messages.at(-1).content;
    return new Response(JSON.stringify(say(JSON.stringify({ memories: said.includes("secret plan") ? ["The user has a secret plan."] : [] }))));
  }
  prompts.push(body);
  const last = body.messages.at(-1);
  if (last.role === "tool") return new Response(JSON.stringify(say("Done.")));
  const text = (last.content || "").toLowerCase();
  if (text.includes("draw")) return new Response(JSON.stringify(toolCall("generate_image", { prompt: "a lion" })));
  if (text.includes("on my laptop")) return new Response(JSON.stringify(toolCall("laptop_command", { command: "open spotify" })));
  if (text.includes("big request")) return new Response(JSON.stringify(say("Big answer.", 3000)));
  return new Response(JSON.stringify(say("Very good.")));
};
test.after(() => { globalThis.fetch = realFetch; });

const { default: handler } = await import("../netlify/functions/api.mjs");
const { default: hourly } = await import("../netlify/functions/weather-refresh.mjs");
const { webSearch } = await import("../lib/search.mjs");
const { generateImages } = await import("../lib/images.mjs");
const { runAsUser, findUser, shareOf, allUsers } = await import("../lib/users.mjs");
const { store } = await import("../lib/store.mjs");

const pending = [];
async function call(method, route, { token, body, ip = "1.1.1.1" } = {}) {
  const req = new Request(`https://jarvis.test/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req, { ip, waitUntil: (p) => pending.push(p) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : null };
}
const login = async (passcode, device = "phone") => (await call("POST", "login", { body: { passcode, device } })).data;

const ushnish = await login(OWNER);
const sam = await login(SAM);

test("each passcode signs in as its own person; a wrong one signs in as nobody", async () => {
  assert.equal(ushnish.user.name, "Ushnish");
  assert.equal(sam.user.name, "Sam Example");
  assert.equal(sam.user.honorific, "Sam");
  assert.equal((await call("POST", "login", { body: { passcode: "wrong", device: "phone" }, ip: "9.9.9.9" })).status, 401);
});

test("the passcode is never sent back", async () => {
  assert.ok(!JSON.stringify(sam).includes(SAM));
  const sync = await call("GET", "sync?since=0", { token: sam.token });
  assert.ok(!JSON.stringify(sync.data).includes(SAM));
  assert.equal(sync.data.user.name, "Sam Example");
});

test("chat is private to each person", async () => {
  await call("POST", "chat", { token: ushnish.token, body: { text: "Ushnish private message" } });
  await call("POST", "chat", { token: sam.token, body: { text: "Sam private message" } });
  const seenBy = async (t) => (await call("GET", "sync?since=0", { token: t })).data.messages.map((m) => m.content).join(" | ");
  assert.match(await seenBy(ushnish.token), /Ushnish private/);
  assert.doesNotMatch(await seenBy(ushnish.token), /Sam private/);
  assert.match(await seenBy(sam.token), /Sam private/);
  assert.doesNotMatch(await seenBy(sam.token), /Ushnish private/);
});

test("Jarvis knows who it is talking to, and doesn't see the other person's history", async () => {
  prompts.length = 0;
  await call("POST", "chat", { token: sam.token, body: { text: "Who am I?" } });
  const sent = JSON.stringify(prompts[0].messages);
  assert.match(sent, /assistant of Sam Example/);
  assert.match(sent, /Address the user as \\"Sam\\"/);
  assert.doesNotMatch(sent, /Ushnish/);
});

test("memory is private, including facts learned automatically", async () => {
  await call("POST", "chat", { token: ushnish.token, body: { text: "I have a secret plan" } });
  await Promise.all(pending);
  const memories = async (t) => (await call("GET", "memories", { token: t })).data.memories.map((m) => m.text);
  assert.deepEqual(await memories(ushnish.token), ["The user has a secret plan."]);
  assert.deepEqual(await memories(sam.token), []);
  prompts.length = 0;
  await call("POST", "chat", { token: sam.token, body: { text: "Do I have a secret plan?" } });
  assert.doesNotMatch(JSON.stringify(prompts[0].messages), /The user has a secret plan/);
});

test("images are private: another person's image can't be opened even with its id", async () => {
  const { data } = await call("POST", "chat", { token: ushnish.token, body: { text: "Draw a lion" } });
  const id = data.actions[0].id;
  assert.equal((await call("GET", `images/${id}`, { token: ushnish.token })).status, 200);
  assert.equal((await call("GET", `images/${id}`, { token: sam.token })).status, 404);
});

test("commands only reach the same person's devices", async () => {
  const samLaptop = await login(SAM, "laptop");
  const ushnishLaptop = await login(OWNER, "laptop");
  await call("POST", "chat", { token: sam.token, body: { text: "Open Spotify on my laptop" } });
  assert.equal((await call("GET", "sync", { token: samLaptop.token })).data.commands.length, 1);
  assert.equal((await call("GET", "sync", { token: ushnishLaptop.token })).data.commands.length, 0);
});

test("devices show as online per person", async () => {
  const fresh = await login(SAM, "laptop");
  await call("GET", "sync", { token: fresh.token });
  assert.equal((await call("GET", "sync", { token: ushnish.token })).data.devices.phone.online, true);
});

test("each person's home region is their own", async () => {
  const k = findUser("sam");
  await runAsUser(k, () => store().setJSON("weather/home", { name: "Pune" }));
  assert.equal(await store().get("weather/home"), null);
  assert.equal((await runAsUser(k, () => store().get("weather/home"))).name, "Pune");
  await runAsUser(k, () => store().delete("weather/home"));
});

test("the hourly weather job runs for everyone, and one person's failure doesn't stop the rest", async () => {
  const k = findUser("sam");
  await runAsUser(k, () => store().setJSON("weather/home", { name: "Pune", latitude: 18.5, longitude: 73.8, tz: "Asia/Kolkata" }));
  const log = [];
  const original = console.log;
  console.log = (...a) => log.push(a.join(" "));
  try { await hourly(); } finally { console.log = original; }
  await runAsUser(k, () => store().delete("weather/home"));
  assert.equal(log.filter((l) => l.startsWith("weather refresh")).length, allUsers().length);
});

test("web searches are split equally, and one person using theirs doesn't affect the other", async () => {
  assert.equal(shareOf(8), 4);
  const tz = "Asia/Kolkata";
  const k = findUser("sam");
  searches = 0;
  for (let i = 0; i < 4; i++) assert.match(await runAsUser(k, () => webSearch("q", tz)), /T: S/);
  assert.match(await runAsUser(k, () => webSearch("q", tz)), /limit of 4 web searches/);
  assert.equal(searches, 4);
  assert.match(await webSearch("q", tz), /T: S/);
  assert.equal(searches, 5);
});

test("images are split equally per day", async () => {
  const k = findUser("sam");
  assert.equal(shareOf(170), 85);
  await runAsUser(k, () => store().setJSON(`usage/images/${new Date().toISOString().slice(0, 10)}`, { count: 84 }));
  images = 0;
  const made = await runAsUser(k, () => generateImages("a lion", 4));
  assert.equal(made.length, 1); // only one left in the share
  assert.equal(images, 1);
  await assert.rejects(runAsUser(k, () => generateImages("a lion")), /share of 85 images/);
  assert.equal((await generateImages("a lion")).length, 1); // the owner isn't affected
});

test("Groq tokens are split per minute: over a share uses the smaller model, then waits, without touching the other person", async () => {
  // 4,000 tokens a minute each. Run at a fixed moment so the test can't cross a minute boundary.
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    const big = async (t) => (await call("POST", "chat", { token: t, body: { text: "Big request" } })).data.reply.content;
    prompts.length = 0;
    await big(sam.token); // 3,000
    await big(sam.token); // 6,000: now over on the main model
    assert.equal(prompts[1].model, "openai/gpt-oss-120b");
    await big(sam.token);
    assert.equal(prompts[2].model, "openai/gpt-oss-20b");
    await big(sam.token); // now over on the smaller model too
    prompts.length = 0;
    assert.match(await big(sam.token), /share of the AI for this minute/);
    assert.equal(prompts.length, 0); // nothing was sent to Groq

    prompts.length = 0;
    assert.equal(await big(ushnish.token), "Big answer.");
    assert.equal(prompts[0].model, "openai/gpt-oss-120b");
  } finally {
    Date.now = realNow;
  }
});

test("wrong passcodes lock out that connection, not everyone", async () => {
  for (let i = 0; i < 9; i++) await call("POST", "login", { body: { passcode: "guess" + i, device: "phone" }, ip: "6.6.6.6" });
  assert.equal((await call("POST", "login", { body: { passcode: SAM, device: "phone" }, ip: "6.6.6.6" })).status, 429);
  assert.equal((await call("POST", "login", { body: { passcode: SAM, device: "phone" }, ip: "7.7.7.7" })).status, 200);
});

test("tokens from before multiple users still belong to the owner", async () => {
  const secret = crypto.createHash("sha256").update("jarvis:" + OWNER).digest("hex");
  const payload = Buffer.from(JSON.stringify({ d: "phone", exp: Date.now() + 1000000 })).toString("base64url");
  const old = `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
  assert.equal((await call("GET", "sync", { token: old })).data.user.name, "Ushnish");
});

test("removing someone cuts off their existing sessions", async () => {
  delete process.env.JARVIS_USERS;
  assert.equal((await call("GET", "sync", { token: sam.token })).status, 401);
  assert.equal(shareOf(8), 8);
  process.env.JARVIS_USERS = USERS;
});

test("broken JARVIS_USERS doesn't lock the owner out", async () => {
  process.env.JARVIS_USERS = "{not json";
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await login(OWNER)).user.name, "Ushnish");
  } finally {
    console.error = original;
    process.env.JARVIS_USERS = USERS;
  }
});
