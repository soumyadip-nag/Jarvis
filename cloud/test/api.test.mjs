// End-to-end test of the API with a local file store and mocked Groq / Cohere.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-"));
process.env.JARVIS_PASSCODE = "correct horse battery staple";
process.env.GROQ_API_KEY = "test";
process.env.CohereAPIKey = "test";
process.env.SERPAPI_KEY = "test";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
process.env.CLOUDFLARE_API_TOKEN = "test";

// ── mock LLM: decides tool calls from the last user message
const realFetch = globalThis.fetch;
const toolCall = (name, args) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});
const say = (content) => ({ choices: [{ message: { role: "assistant", content } }] });
const seenPrompts = [];
const searches = [];

globalThis.fetch = async (url, init) => {
  if (String(url).includes("serpapi")) {
    searches.push(String(url));
    return new Response(JSON.stringify({ organic_results: [{ title: "Result", snippet: "Something happened" }] }));
  }
  const body = JSON.parse(init.body);
  if (String(url).includes("cloudflare")) {
    if (body.prompt.includes("fail")) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ result: { image: Buffer.from("fake-jpeg").toString("base64") } }));
  }
  if (String(url).includes("cohere")) {
    // crude deterministic "embedding": letter histogram
    const vec = (t) => Array.from({ length: 26 }, (_, i) => (t.toLowerCase().split(String.fromCharCode(97 + i)).length - 1));
    return new Response(JSON.stringify({ embeddings: { int8: body.texts.map(vec) } }));
  }
  if (body.response_format) {
    const user = body.messages.at(-1).content;
    const memories = user.includes("tea") ? ["The user prefers tea over coffee."] : [];
    return new Response(JSON.stringify(say(JSON.stringify({ memories }))));
  }
  seenPrompts.push(body.messages);
  const last = body.messages.at(-1);
  if (last.role === "tool") return new Response(JSON.stringify(say(`Done, sir. (${last.content})`)));
  const text = last.content.toLowerCase();
  if (text.includes("busy minute") && body.model !== "openai/gpt-oss-20b") return new Response("slow down", { status: 429 });
  if (text.includes("search for")) return new Response(JSON.stringify(toolCall("web_search", { query: "news" })));
  if (text.includes("call ravi")) return new Response(JSON.stringify(toolCall("phone_action", { action: "call", target: "Ravi" })));
  if (text.includes("say it twice")) return new Response(JSON.stringify(say("It is raining, sir.It is raining, sir.")));
  if (text.includes("draw a broken")) return new Response(JSON.stringify(toolCall("generate_image", { prompt: "fail" })));
  if (text.includes("draw")) return new Response(JSON.stringify(toolCall("generate_image", { prompt: "a lion", count: 2 })));
  if (text.includes("on my laptop")) return new Response(JSON.stringify(toolCall("laptop_command", { command: "open spotify" })));
  if (text.includes("open youtube")) return new Response(JSON.stringify(toolCall("phone_action", { action: "open_app", target: "YouTube" })));
  return new Response(JSON.stringify(say("Very good, sir.")));
};

const { default: handler } = await import("../netlify/functions/api.mjs");
const pendingWork = [];
const ctx = { waitUntil: (p) => pendingWork.push(p) };

async function call(method, route, { token, body } = {}) {
  const req = new Request(`https://jarvis.test/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req, ctx);
  return { status: res.status, data: await res.json() };
}

let phone, laptop;

test("login rejects a wrong passcode and accepts the right one", async () => {
  assert.equal((await call("POST", "login", { body: { passcode: "nope", device: "phone" } })).status, 401);
  assert.equal((await call("GET", "sync")).status, 401);
  phone = (await call("POST", "login", { body: { passcode: process.env.JARVIS_PASSCODE, device: "phone" } })).data.token;
  laptop = (await call("POST", "login", { body: { passcode: process.env.JARVIS_PASSCODE, device: "laptop" } })).data.token;
  assert.ok(phone && laptop);
});

test("tampered tokens are rejected", async () => {
  const forged = phone.slice(0, -2) + "xx";
  assert.equal((await call("GET", "sync", { token: forged })).status, 401);
});

test("'open youtube' on the phone returns a link for the phone", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "Open YouTube", tz: "Asia/Kolkata" } });
  assert.equal(data.actions.length, 1);
  assert.equal(data.actions[0].url, "https://www.youtube.com");
  assert.equal(data.actions[0].queued, undefined);
});

test("asking the phone to open something on the laptop queues it for the laptop", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "Open Spotify on my laptop" } });
  assert.equal(data.actions[0].queued, true);
  const sync = await call("GET", "sync", { token: laptop });
  assert.equal(sync.data.commands.length, 1);
  assert.equal(sync.data.commands[0].command, "open spotify");
  await call("POST", `commands/${sync.data.commands[0].id}/done`, { token: laptop });
  assert.equal((await call("GET", "sync", { token: laptop })).data.commands.length, 0);
});

test("conversation is shared: the laptop sees messages sent from the phone", async () => {
  const { data } = await call("GET", "sync?since=0", { token: laptop });
  const texts = data.messages.map((m) => `${m.device}:${m.role}:${m.content}`);
  assert.ok(texts.some((t) => t.startsWith("phone:user:Open YouTube")));
  assert.ok(data.devices.phone.online);
});

test("facts are extracted into memory and recalled on the other device", async () => {
  await call("POST", "chat", { token: phone, body: { text: "I always drink tea in the morning" } });
  await Promise.all(pendingWork);
  const mem = await call("GET", "memories", { token: laptop });
  assert.deepEqual(mem.data.memories.map((m) => m.text), ["The user prefers tea over coffee."]);

  await call("POST", "chat", { token: laptop, body: { text: "What should I drink? tea or coffee" } });
  const system = seenPrompts.at(-1).filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(system, /prefers tea/);
  assert.match(system, /from their LAPTOP/);
});

test("memories can be added manually and deleted", async () => {
  const { data } = await call("POST", "memories", { token: phone, body: { text: "My bike is a Royal Enfield." } });
  const id = data.added[0].id;
  assert.equal((await call("DELETE", `memories/${id}`, { token: phone })).data.ok, true);
});

test("generated images appear as actions and are private", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "Draw a lion" } });
  const images = data.actions.filter((a) => a.type === "image");
  assert.equal(images.length, 2);

  const url = `https://jarvis.test/api/images/${images[0].id}`;
  assert.equal((await handler(new Request(url), ctx)).status, 401);
  const res = await handler(new Request(url, { headers: { Authorization: `Bearer ${laptop}` } }), ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "fake-jpeg");
  const bad = new Request("https://jarvis.test/api/images/..%2Fauth", { headers: { Authorization: `Bearer ${laptop}` } });
  assert.equal((await handler(bad, ctx)).status, 404);
});

test("a failed image is reported to the model, not faked", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "Draw a broken thing" } });
  assert.equal(data.actions.length, 0);
  assert.match(data.reply.content, /Tool error/);
});

test("a rate limit on the main model falls back to the smaller one", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "This is a busy minute" } });
  assert.equal(data.reply.content, "Very good, sir.");
});

test("an answer the model repeated word for word is only given once", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "Say it twice" } });
  assert.equal(data.reply.content, "It is raining, sir.");
});

test("web search stops at 8 a day and tells the model why", async () => {
  const { webSearch, SEARCH_DAILY_CAP } = await import("../lib/search.mjs");
  assert.equal(SEARCH_DAILY_CAP, 8);
  const before = searches.length;
  for (let i = 0; i < SEARCH_DAILY_CAP; i++) {
    assert.match(await webSearch("news", "Asia/Kolkata"), /Something happened/);
  }
  assert.equal(searches.length, before + 8);
  assert.match(await webSearch("news", "Asia/Kolkata"), /limit of 8 web searches/);
  assert.equal(searches.length, before + 8); // no ninth call was sent

  const { data } = await call("POST", "chat", { token: phone, body: { text: "Search for the news", tz: "Asia/Kolkata" } });
  assert.match(data.reply.content, /limit of 8 web searches/);
  assert.equal(searches.length, before + 8);

  const tomorrow = Date.now() + 86400_000;
  assert.match(await webSearch("news", "Asia/Kolkata", tomorrow), /Something happened/);
});

test("calling a name sends only the name; the phone does the matching", async () => {
  const { data } = await call("POST", "chat", { token: phone, body: { text: "Call Ravi" } });
  assert.equal(data.actions[0].type, "call_contact");
  assert.equal(data.actions[0].name, "Ravi");
  assert.equal(data.actions[0].url, undefined);
});

test("asked from the laptop, a call is queued for the phone", async () => {
  await call("POST", "chat", { token: laptop, body: { text: "Call Ravi" } });
  const sync = await call("GET", "sync", { token: phone });
  const command = sync.data.commands.find((c) => c.type === "call_contact");
  assert.equal(command.name, "Ravi");
  await call("POST", `commands/${command.id}/done`, { token: phone });
});

test("brute force is locked out", async () => {
  for (let i = 0; i < 9; i++) await call("POST", "login", { body: { passcode: "guess" + i, device: "phone" } });
  const res = await call("POST", "login", { body: { passcode: process.env.JARVIS_PASSCODE, device: "phone" } });
  assert.equal(res.status, 429);
});

test.after(() => { globalThis.fetch = realFetch; });
