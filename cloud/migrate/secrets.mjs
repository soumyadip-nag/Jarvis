// Gives the Worker the settings it needs from the project's .env, through `wrangler secret bulk`.
// The values go in a temporary file that is deleted straight afterwards, and are never printed.
//     node migrate/secrets.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = Object.fromEntries(
  fs.readFileSync("../.env", "utf8").split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean)
    .map(([, k, v]) => [k, v.trim().replace(/^["']|["']$/g, "")]),
);
// The Worker's name for each setting, and where it comes from in .env.
const wanted = {
  GROQ_API_KEY: "GROQ_API_KEY",
  CLOUDFLARE_ACCOUNT_ID: "CLOUDFLARE_ACCOUNT_ID",
  CLOUDFLARE_API_TOKEN: "CLOUDFLARE_API_TOKEN",
  SERPAPI_KEY: "SERPAPI_KEY",
  JARVIS_PASSCODE: "JARVIS_PASSCODE",
  JARVIS_USERS: "JARVIS_USERS",
  USER_NAME: "Username",
  HONORIFIC: "Honorific",
};
const secrets = {};
for (const [name, source] of Object.entries(wanted)) if (env[source]) secrets[name] = env[source];
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-secrets-")), "secrets.json");
try {
  fs.writeFileSync(file, JSON.stringify(secrets));
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const output = execFileSync(npx, ["wrangler", "secret", "bulk", file], { encoding: "utf8", shell: process.platform === "win32" });
  console.log(output.split("\n").filter((l) => /success|uploaded|error/i.test(l)).join("\n"));
} finally {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}
console.log("set:", Object.keys(secrets).join(", "));
