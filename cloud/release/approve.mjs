// Approves the phone app update that GitHub published, so phones will offer and install it.
//
// Updates need two keys: GitHub builds and publishes the APK (to the public jarvis-updates repo), and this records
// that exact file's version and SHA-256 on the Jarvis server, in D1. The app only offers an approved version and
// only installs a file with the approved fingerprint, so someone with only the GitHub account can't reach the phone.
// Writing to D1 needs this laptop's Cloudflare login (wrangler).
//
//   node release/approve.mjs          shows the latest build, its test results and its fingerprint
//   node release/approve.mjs --yes    approves it
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RELEASE = "https://github.com/RaGnaRoK260404/jarvis-updates/releases/download/apk-latest/";
const DATABASE = "jarvis";

async function get(name) {
  const res = await fetch(RELEASE + name);
  if (!res.ok) throw new Error(`Couldn't download ${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const { versionCode } = JSON.parse((await get("version.json")).toString());
if (!Number.isInteger(versionCode)) throw new Error("version.json has no versionCode");
const apk = await get("jarvis.apk");
const sha256 = createHash("sha256").update(apk).digest("hex");

// What the build itself reported: the tests, and installing over the previous version.
const build = (await get("build.log").catch(() => Buffer.from(""))).toString();
const smoke = (await get("smoke.log").catch(() => Buffer.from(""))).toString();
const passed = (build.match(/ PASSED/g) || []).length;
const failed = (build.match(/ FAILED/g) || []).length;
console.log(`Version ${versionCode}, ${(apk.length / 1e6).toFixed(1)} MB`);
console.log(`SHA-256 ${sha256}`);
console.log(`Unit tests: ${passed} passed, ${failed} failed`);
console.log(`Upgrade over the previous version: ${/UPGRADE OVER PREVIOUS BUILD: OK/.test(smoke) ? "OK" : "NOT CONFIRMED"}`);

if (!process.argv.includes("--yes")) {
  console.log("\nNothing approved yet. Run again with --yes to approve this exact file.");
  process.exit(0);
}
if (failed || !passed) throw new Error("Not approving: the build's tests didn't all pass.");

const value = JSON.stringify({ versionCode, sha256, approvedAt: new Date().toISOString() });
const sql = path.join(os.tmpdir(), `jarvis-approve-${process.pid}.sql`);
fs.writeFileSync(sql, `INSERT INTO kv (key, value) VALUES ('release/approved', '${value}') ` +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value;\n");
try {
  execFileSync("npx", ["wrangler", "d1", "execute", DATABASE, "--remote", "--yes", `--file=${sql}`], {
    cwd: path.join(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32",
  });
} finally {
  fs.rmSync(sql, { force: true });
}
console.log(`\nApproved version ${versionCode}. Phones will offer it the next time they check (within an hour, or on opening the app).`);
