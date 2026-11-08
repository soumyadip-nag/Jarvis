// The phone's settings and replies by voice, and who has messaged (senders and counts only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-phone-"));
process.env.JARVIS_PASSCODE = "owner-pass";
process.env.JARVIS_SECRET = "test-secret";
process.env.USER_NAME = "Ushnish";
process.env.GROQ_API_KEY = "test";

const toolCall = (name, args) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { total_tokens: 10 },
});
const say = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 10 } });
let lastPrompt = [];
let lastTools = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.response_format) return new Response(JSON.stringify(say('{"memories":[]}')));
  lastPrompt = body.messages;
  lastTools = (body.tools || []).map((t) => t.function.name);
  const last = body.messages.at(-1);
  if (last.role === "tool") return new Response(JSON.stringify(say("Done.")));
  const text = last.content;
  if (text.includes("torch")) return new Response(JSON.stringify(toolCall("phone_control", { control: "torch_on" })));
  if (text.includes("timer")) return new Response(JSON.stringify(toolCall("phone_control", { control: "timer", seconds: 600, label: "Pasta" })));
  if (text.includes("alarm")) return new Response(JSON.stringify(toolCall("phone_control", { control: "alarm", hour: 6, minute: 5 })));
  if (text.includes("explode")) return new Response(JSON.stringify(toolCall("phone_control", { control: "self_destruct" })));
  if (text.includes("reply to Rahul")) return new Response(JSON.stringify(toolCall("reply_message", { to: "Rahul", text: "On my way", app: "whatsapp" })));
  if (text.includes("reply to someone")) return new Response(JSON.stringify(toolCall("reply_message", { to: "Kohen", text: "Hi" })));
  return new Response(JSON.stringify(say("Very good.")));
};
test.after(() => { globalThis.fetch = realFetch; });

const { default: handler } = await import("../netlify/functions/api.mjs");
const { phoneControlConfirmation } = await import("../lib/brain.mjs");

async function call(method, route, { token, body } = {}) {
  const req = new Request(`https://jarvis.test/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req, { ip: "1.1.1.2", waitUntil: () => {} });
  return { status: res.status, data: await res.json() };
}
const login = async (device) => (await call("POST", "login", { body: { passcode: "owner-pass", device } })).data.token;
const chat = (token, text, extra = {}) => call("POST", "chat", { token, body: { text, ...extra } });
const commands = async (token) => (await call("GET", "sync?since=0", { token })).data.commands;

const phone = await login("phone");
const laptop = await login("laptop");

test("a setting is changed on the phone, with a fixed confirmation", async () => {
  const { data } = await chat(phone, "turn the torch on");
  assert.deepEqual(data.actions.map((a) => [a.type, a.control, !!a.queued]), [["phone_control", "torch_on", false]]);
  assert.equal(data.reply.content, "Torch on, sir.");
});

test("timers and alarms carry their numbers", async () => {
  let { data } = await chat(phone, "set a timer for pasta");
  assert.deepEqual([data.actions[0].seconds, data.actions[0].name], [600, "Pasta"]);
  assert.equal(data.reply.content, "Timer set for 10 minutes, sir.");
  ({ data } = await chat(phone, "alarm for six oh five"));
  assert.deepEqual([data.actions[0].hour, data.actions[0].minute], [6, 5]);
  assert.equal(data.reply.content, "Alarm set for 06:05, sir.");
});

test("an unknown control does nothing", async () => {
  const { data } = await chat(phone, "explode the phone");
  assert.equal(data.actions.length, 0);
});

test("a reply goes to the person named, and says what was sent", async () => {
  const { data } = await chat(phone, "reply to Rahul on WhatsApp saying on my way");
  assert.deepEqual(data.actions.map((a) => [a.type, a.to, a.text, a.app]), [["reply_message", "Rahul", "On my way", "whatsapp"]]);
  assert.equal(data.reply.content, 'Sent to Rahul, sir: "On my way"');
});

test("no reply to someone the user didn't name", async () => {
  const { data } = await chat(phone, "reply to someone saying hi");
  assert.equal(data.actions.length, 0);
});

test("asked from the laptop, it's queued for the phone", async () => {
  await commands(phone); // puts the phone online
  const { data } = await chat(laptop, "turn the torch on");
  assert.equal(data.actions[0].queued, true);
  const queued = await commands(phone);
  assert.deepEqual(queued.map((c) => [c.type, c.control]), [["phone_control", "torch_on"]]);
});

test("who has messaged reaches the AI from the phone only, and isn't saved", async () => {
  const inbox = "- 3 on WhatsApp from Rahul, newest 5 min ago\n";
  await chat(phone, "who messaged me", { notifications: inbox });
  assert.ok(lastPrompt.some((m) => m.role === "system" && m.content.includes("3 on WhatsApp from Rahul")));
  await chat(laptop, "who messaged me", { notifications: inbox });
  assert.ok(!lastPrompt.some((m) => m.content.includes("3 on WhatsApp from Rahul")));
  const { data } = await call("GET", "sync?since=0", { token: phone });
  assert.ok(!JSON.stringify(data.messages).includes("3 on WhatsApp"));
});

test("confirmations", () => {
  assert.equal(phoneControlConfirmation("volume", { level: 140 }), "Volume at 100 percent");
  assert.equal(phoneControlConfirmation("timer", { seconds: 45 }), "Timer set for 45 seconds");
  assert.equal(phoneControlConfirmation("nope"), null);
});

test("a locked phone gets nothing personal and can't send or act", async () => {
  await chat(phone, "remember that my locker code is 4321"); // some history to keep out
  const inbox = "- 2 on WhatsApp from Mom, newest 3 min ago\n";
  const { data } = await chat(phone, "reply to Rahul saying hi", { notifications: inbox, locked: true });
  assert.equal(data.actions.length, 0);
  assert.ok(lastTools.includes("phone_control"));
  assert.deepEqual(lastTools.filter((t) => !["get_weather", "phone_control", "web_search", "generate_image"].includes(t)), []);
  assert.ok(lastPrompt.some((m) => m.role === "system" && m.content.includes("The phone is LOCKED")));
  assert.ok(!JSON.stringify(lastPrompt).includes("locker code"), "no chat history");
  assert.ok(!JSON.stringify(lastPrompt).includes("from Mom"), "no messages");
  assert.equal(data.user.content, "🔒 reply to Rahul saying hi");
});

test("simple controls still work when locked", async () => {
  const { data } = await chat(phone, "turn the torch on", { locked: true });
  assert.deepEqual(data.actions.map((a) => a.control), ["torch_on"]);
});

test("a voice the phone didn't recognise gets the same limits, with its own note", async () => {
  const inbox = "- 2 on WhatsApp from Mom, newest 3 min ago\n";
  const { data } = await chat(phone, "reply to Rahul saying hi", { notifications: inbox, guest: true });
  assert.equal(data.actions.length, 0);
  assert.ok(!lastTools.includes("reply_message"));
  assert.ok(lastPrompt.some((m) => m.role === "system" && m.content.includes("did not recognise this voice")));
  assert.ok(!lastPrompt.some((m) => m.content.includes("The phone is LOCKED")));
  assert.ok(!JSON.stringify(lastPrompt).includes("locker code"), "no chat history");
  assert.ok(!JSON.stringify(lastPrompt).includes("from Mom"), "no messages");
  assert.equal(data.user.content, "❔ reply to Rahul saying hi");
});

test("only a real true counts as locked", async () => {
  await chat(phone, "who messaged me", { locked: "no" });
  assert.ok(lastTools.includes("reply_message"));
});

test("the approved app update is shown to signed-in devices only", async () => {
  assert.deepEqual((await call("GET", "release", { token: phone })).data, {});
  const { globalStore } = await import("../lib/store.mjs");
  await globalStore().setJSON("release/approved", { versionCode: 17, sha256: "a".repeat(64), approvedAt: "2026-11-09" });
  assert.deepEqual((await call("GET", "release", { token: phone })).data, { versionCode: 17, sha256: "a".repeat(64) });
  assert.equal((await call("GET", "release")).status, 401);
});
