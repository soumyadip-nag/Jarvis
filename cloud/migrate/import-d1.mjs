// Loads an export from export-netlify.mjs into the Cloudflare D1 database named in wrangler.toml, using the login
// from `wrangler login`. Values are sent as parameters, not written into the SQL, so large images fit.
//     node migrate/import-d1.mjs ../Data/netlify-export.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const toml = fs.readFileSync("wrangler.toml", "utf8");
const databaseId = toml.match(/database_id = "([^"]+)"/)[1];
const env = Object.fromEntries(
  fs.readFileSync("../.env", "utf8").split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean)
    .map(([, k, v]) => [k, v.trim().replace(/^["']|["']$/g, "")]),
);
const accountId = env.CLOUDFLARE_ACCOUNT_ID;

// Wrangler keeps its login here on Windows, macOS and Linux respectively.
const configs = [
  path.join(process.env.APPDATA || "", "xdg.config", ".wrangler", "config", "default.toml"),
  path.join(os.homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
  path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
  path.join(os.homedir(), ".wrangler", "config", "default.toml"),
];
const config = configs.find((p) => fs.existsSync(p));
if (!config) throw new Error("Run `npx wrangler login` first");
const token = fs.readFileSync(config, "utf8").match(/oauth_token = "([^"]+)"/)[1];

async function query(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.result[0];
}

const items = JSON.parse(fs.readFileSync(process.argv[2] || "../Data/netlify-export.json", "utf8"));
await query("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
let done = 0;
for (const [key, value] of Object.entries(items)) {
  await query("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
  if (++done % 50 === 0) console.log(`${done} loaded`);
}
const { results } = await query("SELECT COUNT(*) AS n FROM kv");
console.log(`loaded ${done}; the database now holds ${results[0].n} items`);
