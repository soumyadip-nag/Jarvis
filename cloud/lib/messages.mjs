// Conversation log shared by all devices.
// * `messages/<day>/<id>`: permanent archive, one blob per message.
// * `messages/recent`: the last RECENT messages, used for syncing and as conversation context.
import { store, newId } from "./store.mjs";

const RECENT = 60;
const RECENT_KEY = "messages/recent";

export async function addMessage({ role, content, device, actions = [] }) {
  const ts = Date.now();
  const msg = { id: `${ts.toString().padStart(14, "0")}-${newId()}`, role, content, device, actions, ts };
  const s = store();
  const day = new Date(ts).toISOString().slice(0, 10);
  await s.setJSON(`messages/${day}/${msg.id}`, msg);
  const recent = (await s.get(RECENT_KEY)) || [];
  recent.push(msg);
  await s.setJSON(RECENT_KEY, recent.slice(-RECENT));
  return msg;
}

export async function recentMessages() {
  return (await store().get(RECENT_KEY)) || [];
}

export async function messagesSince(since = 0) {
  const recent = await recentMessages();
  return recent.filter((m) => m.ts > since);
}

export async function clearRecent() {
  await store().setJSON(RECENT_KEY, []);
}

/** Simple keyword search across the full archive (for "what did I say about X last month?"). */
export async function searchArchive(query, limit = 8) {
  const s = store();
  const terms = query.toLowerCase().match(/[a-z0-9']{3,}/g) || [];
  if (!terms.length) return [];
  const { blobs } = await s.list({ prefix: "messages/2" }); // day folders start with the year
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 1500);
  const hits = [];
  for (let i = 0; i < keys.length && hits.length < limit; i += 25) {
    const batch = await Promise.all(keys.slice(i, i + 25).map((k) => s.get(k)));
    for (const m of batch) {
      if (!m) continue;
      const text = m.content.toLowerCase();
      if (terms.filter((t) => text.includes(t)).length >= Math.ceil(terms.length / 2)) hits.push(m);
      if (hits.length >= limit) break;
    }
  }
  return hits.map((m) => `[${new Date(m.ts).toISOString().slice(0, 16)} ${m.role} via ${m.device}] ${m.content}`);
}
