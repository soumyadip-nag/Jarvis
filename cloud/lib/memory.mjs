// Long-term memory shared by every device.
//
// * Every message is archived forever (messages.mjs).
// * After each exchange, a small model extracts lasting facts ("Prefers tea", "Sister is called Ria",
//   "Exam on 12 Dec") and stores them here with an embedding.
// * Before answering, the most relevant memories are recalled and given to the model.
import { store, newId } from "./store.mjs";
import { chat, embed, FAST_MODEL } from "./llm.mjs";

const INDEX = "memory/index";
const DUPLICATE_SIMILARITY = 0.9;

async function load() {
  return (await store().get(INDEX)) || [];
}
async function save(items) {
  await store().setJSON(INDEX, items);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9']{3,}/g) || []);
function keywordScore(query, text) {
  const q = words(query), t = words(text);
  if (!q.size) return 0;
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

export async function listMemories() {
  return (await load()).map(({ vec, ...m }) => m).sort((a, b) => b.ts - a.ts);
}

export async function addMemories(texts, source = "auto") {
  texts = texts.map((t) => String(t).trim()).filter(Boolean);
  if (!texts.length) return [];
  const items = await load();
  const vecs = await embed(texts);
  const added = [];
  texts.forEach((text, i) => {
    const vec = vecs?.[i] || null;
    // Update an existing memory instead of storing a near-duplicate.
    const dup = vec && items.find((m) => m.vec && cosine(m.vec, vec) >= DUPLICATE_SIMILARITY);
    if (dup) {
      Object.assign(dup, { text, vec, ts: Date.now(), source });
      added.push(dup);
    } else if (!items.some((m) => m.text.toLowerCase() === text.toLowerCase())) {
      const m = { id: newId(), text, vec, ts: Date.now(), source };
      items.push(m);
      added.push(m);
    }
  });
  await save(items);
  return added.map(({ vec, ...m }) => m);
}

export async function deleteMemory(id) {
  const items = await load();
  const next = items.filter((m) => m.id !== id);
  await save(next);
  return items.length !== next.length;
}

/** Delete memories that match a description; returns the removed texts. */
export async function forgetMatching(description) {
  const items = await load();
  const [q] = (await embed([description], "search_query")) || [];
  const doomed = items.filter((m) =>
    q && m.vec ? cosine(q, m.vec) >= 0.55 : keywordScore(description, m.text) >= 0.6);
  await save(items.filter((m) => !doomed.includes(m)));
  return doomed.map((m) => m.text);
}

export async function recall(query, k = 8) {
  const items = await load();
  if (!items.length) return [];
  const [q] = (await embed([query], "search_query")) || [];
  return items
    .map((m) => ({ m, score: q && m.vec ? cosine(q, m.vec) : keywordScore(query, m.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((x) => x.score > 0.15)
    .map((x) => x.m.text);
}

const EXTRACT_PROMPT = `You maintain the long-term memory of a personal assistant for ONE user.
From the latest exchange, extract facts worth remembering for future conversations:
personal details, preferences, people in their life, plans, deadlines, events with dates,
projects, habits, opinions, things they asked to remember, and corrections to known facts.
Write each memory as a short, self-contained sentence in the third person ("The user ...").
Resolve relative dates ("tomorrow") into absolute dates using the current date given.
Do NOT store small talk, the assistant's own answers or general knowledge.
Return JSON: {"memories": ["..."]} (empty list if nothing is worth remembering).`;

export async function extractAndStore({ userText, replyText, now, known = [] }) {
  try {
    const request = () => chat({
      model: FAST_MODEL(),
      json: true,
      temperature: 0.1,
      maxTokens: 1000, // includes the model's reasoning, which can use most of a small budget
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        {
          role: "user",
          content: `Current date: ${now}\nAlready known:\n${known.map((k) => "- " + k).join("\n") || "(nothing)"}\n\n` +
            `User said: ${userText}\nAssistant replied: ${replyText}`,
        },
      ],
    });
    const msg = await request().catch(request); // JSON mode occasionally fails; one retry is usually enough
    const parsed = JSON.parse(msg.content || "{}");
    const memories = Array.isArray(parsed.memories) ? parsed.memories.slice(0, 6) : [];
    return await addMemories(memories, "auto");
  } catch (e) {
    console.error("memory extraction failed:", e.message);
    return [];
  }
}
