// Groq (OpenAI-compatible) chat with tool calling, and Cohere embeddings.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";

export const MODEL = () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
export const FAST_MODEL = () => process.env.GROQ_FAST_MODEL || "llama-3.1-8b-instant";

export async function chat({ messages, tools, model = MODEL(), json = false, maxTokens = 1024, temperature = 0.6 }) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set on the server.");
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message;
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
