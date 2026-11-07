// Web search through SerpAPI. The free plan allows 250 searches a month, so stop at 250/30 a day.
import { store } from "./store.mjs";
import { shareOf } from "./users.mjs";

export const SEARCH_DAILY_CAP = Math.floor(250 / 30); // 8, split equally between everyone

function localDate(ms, tz) {
  const format = (timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(new Date(ms));
  try { return format(tz || "UTC"); } catch { return format("UTC"); }
}

/** Counts a search before it is sent, so the cap can't be exceeded even if a request fails. */
async function takeSearch(now, tz) {
  const key = `search/usage/${localDate(now, tz)}`;
  const used = (await store().get(key))?.count || 0;
  if (used >= shareOf(SEARCH_DAILY_CAP)) return false;
  await store().setJSON(key, { count: used + 1 });
  return true;
}

/** Returns text for the model. Never includes the API key. */
export async function webSearch(query, tz, now = Date.now()) {
  if (!(await takeSearch(now, tz))) {
    return `Not searched: today's limit of ${shareOf(SEARCH_DAILY_CAP)} web searches has been reached, and it resets tomorrow. ` +
      "Tell the user plainly. If you answer from what you already know, say it may be out of date.";
  }
  const url = `https://serpapi.com/search.json?engine=google&num=5&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    return "Search failed: the search service did not respond. Tell the user the search did not work; do not guess at current facts.";
  }
  if (!res.ok) return `Search failed (${res.status}). Tell the user the search did not work; do not guess at current facts.`;
  const data = await res.json();
  const parts = [];
  const box = data.answer_box;
  if (box) parts.push(`Answer: ${box.answer || box.snippet || box.result || ""}`.trim());
  if (data.knowledge_graph?.description) parts.push(`About: ${data.knowledge_graph.description}`);
  for (const r of (data.organic_results || []).slice(0, 5)) parts.push(`- ${r.title}: ${r.snippet || ""}`);
  return parts.join("\n") || "No results.";
}
