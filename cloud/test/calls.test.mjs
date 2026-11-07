// Asking Jarvis to make a call: from either device, through the phone's contacts, to the laptop and back.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-calls-"));
process.env.JARVIS_PASSCODE = "owner-pass";
process.env.JARVIS_SECRET = "test-secret";
process.env.USER_NAME = "Ushnish";
process.env.GROQ_API_KEY = "test";
process.env.JARVIS_USERS = JSON.stringify([{ id: "sam", name: "Sam Example", honorific: "Sam", passcode: "sam-pass" }]);

const toolCall = (name, args) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { total_tokens: 10 },
});
const say = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 10 } });
let lastToolResult = "";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.response_format) return new Response(JSON.stringify(say('{"memories":[]}')));
  const last = body.messages.at(-1);
  if (last.role === "tool") {
    lastToolResult = last.content;
    return new Response(JSON.stringify(say("Understood.")));
  }
  const number = last.content.match(/ring (\+?\d+)/)?.[1];
  const contact = number || last.content.match(/ring (\w+)/)?.[1];
  if (contact) return new Response(JSON.stringify(toolCall("ai_call", { contact, goal: "Ask if they're free" })));
  return new Response(JSON.stringify(say("Very good.")));
};
test.after(() => { globalThis.fetch = realFetch; });

const { default: handler } = await import("../netlify/functions/api.mjs");

async function call(method, route, { token, body } = {}) {
  const req = new Request(`https://jarvis.test/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req, { ip: "1.1.1.1", waitUntil: () => {} });
  return { status: res.status, data: await res.json() };
}
const login = async (passcode, device) => (await call("POST", "login", { body: { passcode, device } })).data.token;
const chat = (token, text) => call("POST", "chat", { token, body: { text } });
const commands = async (token) => (await call("GET", "sync?since=0", { token })).data.commands;
const clear = async (token) => { for (const c of await commands(token)) await call("POST", `commands/${c.id}/done`, { token }); };

const phone = await login("owner-pass", "phone");
const laptop = await login("owner-pass", "laptop"); // signing in doesn't count as online until it syncs

test("the phone is asked to find the name, and no number is invented or sent to the laptop yet", async () => {
  await clear(laptop); // this sync also puts the laptop online
  const { data } = await chat(phone, "ring Kohen and ask if he's free");
  assert.deepEqual(data.actions.map((a) => [a.type, a.name, a.goal, !!a.queued]), [["ai_call", "Kohen", "Ask if they're free", false]]);
  assert.equal((await commands(laptop)).length, 0);
});

test("the phone's chosen number reaches the laptop as a call to make", async () => {
  await clear(laptop);
  assert.equal((await call("POST", "calls", { token: phone, body: { name: "Kohen", number: "+91 98765-43210", goal: "Ask if he's free" } })).status, 200);
  const [cmd] = await commands(laptop);
  assert.deepEqual([cmd.type, cmd.name, cmd.number, cmd.goal], ["ai_call", "Kohen", "+919876543210", "Ask if he's free"]);
  assert.ok(cmd.ts);
});

test("bad call requests are refused", async () => {
  await clear(laptop);
  for (const body of [
    { name: "x", number: "not a number", goal: "g" },
    { name: "x", number: "12", goal: "g" },
    { name: "x", number: "+919876543210" },
    { name: "x", number: "+919876543210", goal: "g".repeat(1001) },
  ]) {
    assert.equal((await call("POST", "calls", { token: phone, body })).status, 400);
  }
  assert.equal((await commands(laptop)).length, 0);
});

test("asked from the laptop with the phone open, the phone looks the name up", async () => {
  await clear(laptop);
  await clear(phone); // puts the phone online
  const { data } = await chat(laptop, "ring Kohen and ask if he's free");
  assert.equal(data.actions[0].queued, true);
  const [cmd] = await commands(phone);
  assert.deepEqual([cmd.type, cmd.name], ["ai_call", "Kohen"]);
  assert.equal(cmd.number, undefined);
  await clear(phone);
});

test("a number given outright goes straight to the laptop", async () => {
  await clear(laptop);
  await chat(phone, "ring +919876543210 and ask if he's free");
  const [cmd] = await commands(laptop);
  assert.equal(cmd.number, "+919876543210");
  await clear(laptop);
});

test("without the laptop running, nothing is queued and the AI is told to say so", async () => {
  // Someone without a laptop signed in: calls use the owner's number, so they must never reach the owner's laptop.
  const samPhone = await login("sam-pass", "phone");
  const { data } = await chat(samPhone, "ring Kohen and ask if he's free");
  assert.equal(data.actions.length, 0);
  assert.match(lastToolResult, /desktop app isn't running/);
  assert.equal((await commands(samPhone)).length, 0);
  await clear(laptop);
  assert.equal((await commands(laptop)).length, 0);
});

test("the report appears in the shared chat for every device, and in the conversation", async () => {
  const { status } = await call("POST", "calls/report", {
    token: laptop, body: { name: "Kohen", report: "He is free at eight.", transcript: "Them: Eight works." },
  });
  assert.equal(status, 200);
  const { data } = await call("GET", "sync?since=0", { token: phone });
  const report = data.messages.at(-1);
  assert.match(report.content, /Call to Kohen: He is free at eight\./);
  assert.match(report.content, /Them: Eight works\./);
  assert.equal(report.device, "laptop");
  assert.equal((await call("POST", "calls/report", { token: laptop, body: { name: "Kohen" } })).status, 400);
});
