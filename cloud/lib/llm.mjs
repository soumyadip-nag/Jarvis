// Groq (OpenAI-compatible) chat with tool calling, and Cohere embeddings.
import { store } from "./store.mjs";
import { allUsers, shareOf } from "./users.mjs";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";

export const MODEL = () => process.env.GROQ_MODEL || "openai/gpt-oss-120b";
export const FAST_MODEL = () => process.env.GROQ_FAST_MODEL || "openai/gpt-oss-20b";

// Groq's free tier allows about this many tokens a minute for each model, shared by everyone on the key.
const TOKENS_PER_MINUTE = () => Number(process.env.GROQ_TOKENS_PER_MINUTE) || 8000;

export class ShareUsedError extends Error {
  constructor(seconds) {
    super("This person's share of the AI for this minute is used up.");
    this.seconds = seconds;
  }
}

const usageKey = (model) => `usage/groq/${model.replace(/[^a-z0-9-]+/gi, "-")}`;
const thisMinute = () => Math.floor(Date.now() / 60_000);

async function tokensUsedThisMinute(model) {
  const usage = await store().get(usageKey(model));
  return usage?.minute === thisMinute() ? usage.tokens : 0;
}

async function recordTokens(model, tokens) {
  const used = await tokensUsedThisMinute(model);
  await store().setJSON(usageKey(model), { minute: thisMinute(), tokens: used + tokens });
}

export async function chat({ messages, tools, model = MODEL(), json = false, maxTokens = 1024, temperature = 0.6 }) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set on the server.");
  // With more than one person, nobody may use more than their equal share of the per-minute limit.
  const sharing = allUsers().length > 1;
  if (sharing && (await tokensUsedThisMinute(model)) >= shareOf(TOKENS_PER_MINUTE())) {
    if (model !== FAST_MODEL()) return chat({ messages, tools, model: FAST_MODEL(), json, maxTokens, temperature });
    throw new ShareUsedError(60 - Math.floor(Date.now() / 1000) % 60);
  }
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // The free tier limits tokens per minute for each model, so a busy minute can fall back to the smaller one.
  if (res.status === 429 && model !== FAST_MODEL()) {
    console.warn(`Groq rate limit on ${model}; using ${FAST_MODEL()}`);
    return chat({ messages, tools, model: FAST_MODEL(), json, maxTokens, temperature });
  }
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (sharing) await recordTokens(model, data.usage?.total_tokens || 0);
  return data.choices[0].message;
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
