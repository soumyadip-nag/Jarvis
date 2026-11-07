// Each person has their own passcode (see users.mjs); signing in gives signed per-device tokens.
import crypto from "node:crypto";
import { globalStore } from "./store.mjs";
import { allUsers, findUser } from "./users.mjs";

const TOKEN_DAYS = 90;
const MAX_FAILS = 8;          // per connection per hour, then locked for the rest of the hour
export const DEVICES = ["phone", "laptop"];

function secret() {
  const pass = process.env.JARVIS_PASSCODE;
  if (!pass) throw new Error("JARVIS_PASSCODE is not set on the server.");
  return process.env.JARVIS_SECRET || crypto.createHash("sha256").update("jarvis:" + pass).digest("hex");
}

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function login(passcode, device, ip = "unknown") {
  if (!DEVICES.includes(device)) return { error: "Unknown device", status: 400 };
  const s = globalStore();
  const key = `auth/fails/${crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16)}`;
  const now = Date.now();
  let fails = (await s.get(key)) || { count: 0, since: now };
  if (now - fails.since > 3600_000) fails = { count: 0, since: now };
  if (fails.count >= MAX_FAILS) return { error: "Too many attempts. Try again later.", status: 429 };

  // Check every passcode, so the time taken doesn't reveal which ones exist.
  let user = null;
  for (const candidate of allUsers()) {
    if (safeEqual(passcode || "", candidate.passcode) && candidate.passcode && !user) user = candidate;
  }
  if (!user) {
    fails.count += 1;
    await s.setJSON(key, fails);
    return { error: "Incorrect passcode.", status: 401 };
  }
  await s.delete(key);
  const payload = b64(JSON.stringify({ d: device, u: user.id, exp: now + TOKEN_DAYS * 86400_000 }));
  return { token: `${payload}.${sign(payload)}`, device, user: { name: user.name, honorific: user.honorific } };
}

/** Returns { device, user }, or null. Removing someone from JARVIS_USERS ends their sessions. */
export function verify(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const { d, u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() > exp || !DEVICES.includes(d)) return null;
    const user = findUser(u);
    return user ? { device: d, user } : null;
  } catch {
    return null;
  }
}
