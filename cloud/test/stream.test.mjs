// Replies streamed to the phone sentence by sentence, as they're written.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-stream-"));
process.env.JARVIS_PASSCODE = "owner-pass";
process.env.JARVIS_SECRET = "test-secret";
process.env.USER_NAME = "Ushnish";
process.env.GROQ_API_KEY = "test";
delete process.env.JARVIS_USERS;
delete process.env.CLOUDFLARE_ACCOUNT_ID;

/** A provider's streamed reply, cut into pieces at awkward places, as networks do. */
function streamed(pieces, { toolCall } = {}) {
  const chunks = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  if (toolCall) chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: toolCall }] } }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ choices: [], x_groq: { usage: { total_tokens: 20 } } })}\n\ndata: [DONE]\n\n`);
  const text = chunks.join("");
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

let replies;
const asked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.response_format) return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] }));
  asked.push({ model: body.model, stream: !!body.stream });
  const next = replies.shift();
  return typeof next === "function" ? next(body) : next;
};
test.after(() => { globalThis.fetch = realFetch; });

const { default: handler } = await import("../netlify/functions/api.mjs");

async function call(method, route, { token, body, stream } = {}) {
  const req = new Request(`https://jarvis.test/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(stream ? { Accept: "text/event-stream" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handler(req, { ip: "1.1.1.1", waitUntil: () => {} });
}
const token = (await (await call("POST", "login", { body: { passcode: "owner-pass", device: "phone" } })).json()).token;

/** The events the phone receives, in order. */
async function events(text) {
  const res = await call("POST", "chat", { token, body: { text }, stream: true });
  assert.match(res.headers.get("content-type"), /event-stream/);
  const raw = await res.text();
  return raw.split("\n\n").filter(Boolean).map((block) => ({
    name: block.match(/^event: (.*)$/m)[1],
    data: JSON.parse(block.match(/^data: (.*)$/m)[1]),
  }));
}

beforeEach(() => { asked.length = 0; });

test("each sentence is sent as soon as it's finished, then the whole reply", async () => {
  replies = [streamed(["Good eve", "ning, sir. The time is", " 8:30 pm", ". Anything else?"])];
  const got = await events("what time is it");
  assert.deepEqual(got.filter((e) => e.name === "sentence").map((e) => e.data.text), ["Good evening, sir.", "The time is 8:30 pm.", "Anything else?"]);
  const done = got.at(-1);
  assert.equal(done.name, "done");
  assert.equal(done.data.reply.content, "Good evening, sir. The time is 8:30 pm. Anything else?");
  assert.deepEqual(asked, [{ model: "openai/gpt-oss-120b", stream: true }]);
});

test("leaked reasoning is never sent, and the next model answers", async () => {
  replies = [streamed(["<|channel|>analysis", " We should greet."]), streamed(["Hello, sir."])];
  const got = await events("hello");
  assert.deepEqual(got.filter((e) => e.name === "sentence").map((e) => e.data.text), ["Hello, sir."]);
  assert.ok(!JSON.stringify(got).includes("channel"));
  assert.deepEqual(asked.map((a) => a.model), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("reasoning written as plain text stops the sentences, as cleanReply does", async () => {
  replies = [streamed(["Paris is the capital. ", "We need to check the tool output. More text."])];
  const got = await events("capital of france");
  assert.deepEqual(got.filter((e) => e.name === "sentence").map((e) => e.data.text), ["Paris is the capital."]);
});

test("a streamed tool call still runs, and Jarvis's fixed words come in the finished reply", async () => {
  replies = [streamed([], { toolCall: { name: "ai_call", arguments: '{"contact":"Kohen","goal":"Ask if he is free"}' } })];
  const got = await events("call Kohen and ask if he's free");
  assert.equal(got.filter((e) => e.name === "sentence").length, 0);
  const done = got.at(-1).data;
  assert.match(done.reply.content, /can't make that call|One moment/);
});

test("without asking for a stream, the reply comes back whole as before", async () => {
  replies = [new Response(JSON.stringify({ choices: [{ message: { content: "Hello, sir." } }] }))];
  const res = await call("POST", "chat", { token, body: { text: "hello" } });
  assert.equal((await res.json()).reply.content, "Hello, sir.");
  assert.deepEqual(asked, [{ model: "openai/gpt-oss-120b", stream: false }]);
});

test("a stream that breaks part way keeps what was already said", async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  replies = [new Response(new ReadableStream({
    pull(controller) {
      // The first piece arrives, then the connection drops.
      if (pulls++ === 0) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "The answer is 42. And" } }] })}\n\n`));
      else controller.error(new Error("connection lost"));
    },
  }), { headers: { "Content-Type": "text/event-stream" } })];
  const got = await events("meaning of life");
  assert.deepEqual(got.filter((e) => e.name === "sentence").map((e) => e.data.text), ["The answer is 42.", "And"]);
  assert.equal(got.at(-1).data.reply.content, "The answer is 42. And");
});
