// Registers the account's workers.dev name, which Cloudflare needs before a Worker can be published there.
//     node migrate/subdomain.mjs my-jarvis-app1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = Object.fromEntries(
  fs.readFileSync("../.env", "utf8").split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean)
    .map(([, k, v]) => [k, v.trim().replace(/^["']|["']$/g, "")]),
);
const config = [
  path.join(process.env.APPDATA || "", "xdg.config", ".wrangler", "config", "default.toml"),
  path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
].find((p) => fs.existsSync(p));
const token = fs.readFileSync(config, "utf8").match(/oauth_token = "([^"]+)"/)[1];
const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const current = await (await fetch(url, { headers })).json();
if (current.result?.subdomain) {
  console.log(`already registered: ${current.result.subdomain}.workers.dev`);
} else {
  const res = await (await fetch(url, { method: "PUT", headers, body: JSON.stringify({ subdomain: process.argv[2] }) })).json();
  console.log(res.success ? `registered: ${res.result.subdomain}.workers.dev` : `couldn't register: ${JSON.stringify(res.errors).slice(0, 200)}`);
}
