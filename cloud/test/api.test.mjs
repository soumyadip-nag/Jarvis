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

// ── mock LLM: decides tool calls from the last user message
const realFetch = globalThis.fetch;
const toolCall = (name, args) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});
const say = (content) => ({ choices: [{ message: { role: "assistant", content } }] });
const seenPrompts = [];

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
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

test("brute force is locked out", async () => {
  for (let i = 0; i < 9; i++) await call("POST", "login", { body: { passcode: "guess" + i, device: "phone" } });
  const res = await call("POST", "login", { body: { passcode: process.env.JARVIS_PASSCODE, device: "phone" } });
  assert.equal(res.status, 429);
});

test.after(() => { globalThis.fetch = realFetch; });
