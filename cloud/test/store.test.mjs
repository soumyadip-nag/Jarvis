// Netlify gives each request its own short-lived storage token, so one must never outlive its request.
import assert from "node:assert/strict";
import { test } from "node:test";

// Netlify's own storage only: the D1 run of the suite (test:d1) has no Netlify tokens.
test("each request uses its own storage token, not the first one seen", { skip: !!globalThis.__JARVIS_TEST_D1 }, async () => {
  delete process.env.JARVIS_LOCAL_STORE;
  const { globalStore } = await import("../lib/store.mjs");
  const setToken = (token) => {
    process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
      siteID: "site", token, edgeURL: "https://edge.test", uncachedEdgeURL: "https://uncached.test",
    })).toString("base64");
  };

  const used = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    used.push(new Headers(options.headers).get("authorization"));
    return new Response(null, { status: 404 });
  };
  try {
    setToken("first");
    await globalStore().get("anything");
    setToken("second");
    await globalStore().get("anything");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NETLIFY_BLOBS_CONTEXT;
  }
  assert.deepEqual(used, ["Bearer first", "Bearer second"]);
});
