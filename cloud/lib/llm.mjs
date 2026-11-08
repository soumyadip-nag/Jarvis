// Chat with tool calling (Groq, then Cloudflare as a backup, both OpenAI-compatible), and Cohere embeddings.
import { store } from "./store.mjs";
import { allUsers, shareOf } from "./users.mjs";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";

export const MODEL = () => process.env.GROQ_MODEL || "openai/gpt-oss-120b";
export const FAST_MODEL = () => process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b";
const BACKUP_MODEL = () => process.env.CLOUDFLARE_CHAT_MODEL || "@cf/openai/gpt-oss-120b";

// Groq's free tier for each model, shared by everyone on the key.
const TOKENS_PER_MINUTE = () => Number(process.env.GROQ_TOKENS_PER_MINUTE) || 8000;
const TOKENS_PER_DAY = () => Number(process.env.GROQ_TOKENS_PER_DAY) || 200000;
// Half of Cloudflare's free 10,000 Neurons a day, so that images, which use the same allowance, keep working.
const BACKUP_NEURONS_PER_DAY = 5000;
const neuronsFor = (usage) => ((usage?.prompt_tokens || 0) * 31818 + (usage?.completion_tokens || 0) * 68182) / 1e6;
const LEAKED_REASONING = /<\|[a-z_]+\|>/; // the model's internal markers, which must never reach the user
const AI_TIMEOUT_MS = 9000; // long enough for a normal reply, and leaves time to try the next provider

export class ShareUsedError extends Error {
  constructor(seconds, daily = false) {
    super("This person's share of the AI is used up.");
    this.seconds = seconds;
    this.daily = daily;
  }
}

const usageKey = (model) => `usage/groq/${model.replace(/[^a-z0-9-]+/gi, "-")}`;
const backupKey = () => `usage/backup/${today()}`;
const thisMinute = () => Math.floor(Date.now() / 60_000);
const today = () => new Date(Date.now()).toISOString().slice(0, 10);

async function usedTokens(model) {
  const usage = await store().get(usageKey(model));
  return {
    minute: usage?.minute === thisMinute() ? usage.tokens : 0,
    day: usage?.day === today() ? usage.dayTokens : 0,
  };
}

async function recordTokens(model, tokens) {
  const used = await usedTokens(model);
  await store().setJSON(usageKey(model), {
    minute: thisMinute(), tokens: used.minute + tokens, day: today(), dayTokens: used.day + tokens,
  });
}

/** Everyone has an equal share of each limit. Returns why this person can't use a provider, or null if they can. */
async function shareProblem({ model, backup }) {
  if (backup) {
    const used = (await store().get(backupKey()))?.neurons || 0;
    return used >= shareOf(BACKUP_NEURONS_PER_DAY) ? new ShareUsedError(0, true) : null;
  }
  if (allUsers().length === 1) return null; // nobody to share with, and Groq enforces the limits itself
  const used = await usedTokens(model);
  if (used.day >= shareOf(TOKENS_PER_DAY())) return new ShareUsedError(0, true);
  if (used.minute >= shareOf(TOKENS_PER_MINUTE())) return new ShareUsedError(60 - Math.floor(Date.now() / 1000) % 60);
  return null;
}

async function recordUsage({ model, backup }, usage) {
  if (backup) {
    const used = (await store().get(backupKey()))?.neurons || 0;
    await store().setJSON(backupKey(), { neurons: used + neuronsFor(usage) });
  } else if (allUsers().length > 1) {
    await recordTokens(model, usage?.total_tokens || 0);
  }
}

const backupReady = () => !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

function send({ url, key, model }, { messages, tools, json, maxTokens, temperature, stream }, signal) {
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (stream) body.stream = true;
  if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
  if (json) body.response_format = { type: "json_object" };
  if (model.includes("gpt-oss")) body.reasoning_effort = "low"; // the hidden reasoning is most of what a short reply costs
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Reads a streamed reply, passing its text on as it arrives, and returns the whole message as a normal reply would.
 * Text is held back from the first "<" until it's clear it isn't the start of leaked reasoning.
 */
async function readStream(res, onText, arrived) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let sent = 0;
  let usage = null;
  const calls = [];
  const release = (all) => {
    const hold = content.indexOf("<", sent);
    const upTo = all ? content.length : hold === -1 ? content.length : hold;
    if (upTo > sent) {
      onText(content.slice(sent, upTo));
      sent = upTo;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrived();
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith("data:") || line === "data: [DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
      usage = chunk.usage || chunk.x_groq?.usage || usage;
      const delta = chunk.choices?.[0]?.delta || {};
      for (const t of delta.tool_calls || []) {
        const call = (calls[t.index ?? 0] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (t.id) call.id = t.id;
        if (t.function?.name) call.function.name += t.function.name;
        if (t.function?.arguments) call.function.arguments += t.function.arguments;
      }
      if (delta.content) {
        content += delta.content;
        if (LEAKED_REASONING.test(content)) {
          throw Object.assign(new Error("leaked its hidden reasoning into the reply"), { partial: content.slice(0, sent) });
        }
        if (!calls.length) release(false);
      }
    }
  }
  if (!calls.length) release(true);
  return { message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) }, usage };
}

/** A request problem would fail everywhere; anything else (limits, outages, a bad reply from the model) may not. */
const worthTryingNext = (status, detail) => status >= 500 || status === 429 || status === 401 || status === 403 || detail.includes("tool_use_failed");

/**
 * The model's message, from the first provider that manages one: the requested Groq model, the smaller one, then
 * Cloudflare. Pass `backup: false` for work that can be skipped, so that it doesn't use up the backup's allowance.
 */
export async function chat({ messages, tools, model = MODEL(), json = false, maxTokens = 1024, temperature = 0.6, backup = true, onText }) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set on the server.");
  const groq = (name) => ({ url: GROQ_URL, key: process.env.GROQ_API_KEY, model: name, label: `Groq ${name}` });
  const providers = [groq(model), ...(model === FAST_MODEL() ? [] : [groq(FAST_MODEL())])];
  if (backup && backupReady()) {
    const cloudflare = {
      url: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
      key: process.env.CLOUDFLARE_API_TOKEN,
      model: BACKUP_MODEL(),
      label: "Cloudflare",
      backup: true,
    };
    providers.push(cloudflare, cloudflare); // twice, as it's the last resort and a bad reply is usually fine next time
  }

  let shareUsed = null;
  let failure = null;
  const failed = (provider, error) => {
    console.warn(`${provider.label} failed, trying the next: ${error.message}`);
    failure = error;
  };
  for (const provider of providers) {
    const problem = await shareProblem(provider);
    if (problem) { shareUsed ||= problem; continue; }
    // A streamed reply has the same time limit to start, and longer to finish.
    const controller = new AbortController();
    const startTimer = setTimeout(() => controller.abort(new Error("timed out")), AI_TIMEOUT_MS);
    const endTimer = setTimeout(() => controller.abort(new Error("timed out")), AI_TIMEOUT_MS * 3);
    const settled = () => { clearTimeout(startTimer); clearTimeout(endTimer); };
    let res;
    try {
      res = await send(provider, { messages, tools, json, maxTokens, temperature, stream: !!onText }, controller.signal);
    } catch (e) { // no connection, or too slow
      settled();
      failed(provider, e);
      continue;
    }
    if (onText && res.ok) {
      let streamed = "";
      try {
        const { message, usage } = await readStream(res, (text) => { streamed += text; onText(text); }, () => clearTimeout(startTimer));
        settled();
        if (!message.content?.trim() && !message.tool_calls?.length) {
          failed(provider, new Error(`${provider.label} returned an empty reply`));
          continue;
        }
        await recordUsage(provider, usage);
        return message;
      } catch (e) {
        settled();
        // Once the user has some of the reply, another model can't carry it on, so keep what they have.
        if (streamed) return { role: "assistant", content: streamed };
        failed(provider, e);
        continue;
      }
    }
    settled();
    if (!res.ok) {
      const detail = await res.text();
      const error = Object.assign(new Error(`${provider.label} ${res.status}: ${detail.slice(0, 300)}`), { status: res.status });
      if (!worthTryingNext(res.status, detail)) throw error;
      failed(provider, error);
      continue;
    }
    const data = await res.json().catch(() => null);
    const message = data?.choices?.[0]?.message;
    if (!message?.content?.trim() && !message?.tool_calls?.length) {
      failed(provider, new Error(`${provider.label} returned an empty reply`));
      continue;
    }
    if (LEAKED_REASONING.test(message.content || "")) {
      failed(provider, new Error(`${provider.label} leaked its hidden reasoning into the reply`));
      continue;
    }
    await recordUsage(provider, data.usage);
    return message;
  }
  throw shareUsed || failure;
}

/** Turns recorded speech into text with Groq's Whisper. */
export async function transcribe(audio, filename = "audio.wav") {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set on the server.");
  const form = new FormData();
  form.append("file", new Blob([audio]), filename);
  form.append("model", process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).text || "";
}

/** Returns int8 vectors (arrays), or null when no Cohere key / on failure. */
export async function embed(texts, inputType = "search_document") {
  if (!process.env.CohereAPIKey || !texts.length) return null;
  try {
    const res = await fetch(COHERE_EMBED_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CohereAPIKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.COHERE_EMBED_MODEL || "embed-english-light-v3.0",
        texts,
        input_type: inputType,
        embedding_types: ["int8"],
      }),
    });
    if (!res.ok) throw new Error(`Cohere ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.embeddings.int8;
  } catch (e) {
    console.error("embed failed:", e.message);
    return null;
  }
}
