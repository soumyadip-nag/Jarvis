// Copies everything Jarvis stores on Netlify into a local file, for loading into Cloudflare D1.
// Reads only; Netlify isn't changed. Needs NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in the project's .env.
//     node migrate/export-netlify.mjs ../Data/netlify-export.json
import fs from "node:fs";
import { getStore } from "@netlify/blobs";

const env = Object.fromEntries(
  fs.readFileSync("../.env", "utf8").split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.trim().replace(/^["']|["']$/g, "")]),
);
const out = process.argv[2] || "../Data/netlify-export.json";
const store = getStore({ name: "jarvis", siteID: env.NETLIFY_SITE_ID, token: env.NETLIFY_AUTH_TOKEN });

const { blobs } = await store.list();
const items = {};
let failed = 0;
for (const { key } of blobs) {
  try {
    items[key] = await store.get(key, { type: "json" });
  } catch (e) {
    failed++;
    console.warn(`couldn't read ${key}: ${e.message}`);
  }
}
fs.writeFileSync(out, JSON.stringify(items));
const groups = {};
for (const key of Object.keys(items)) {
  const group = key.startsWith("users/") ? `users/${key.split("/")[1]}/${key.split("/")[2]}` : key.split("/")[0];
  groups[group] = (groups[group] || 0) + 1;
}
console.log(`exported ${Object.keys(items).length} items (${failed} failed) to ${out}`);
console.log(groups);
