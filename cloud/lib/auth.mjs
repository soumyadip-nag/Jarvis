// Single-user auth: one passcode (JARVIS_PASSCODE) -> signed per-device tokens.
import crypto from "node:crypto";
import { store } from "./store.mjs";

const TOKEN_DAYS = 90;
const MAX_FAILS = 8;          // per hour, then locked for the rest of the hour
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

export async function login(passcode, device) {
  if (!DEVICES.includes(device)) return { error: "Unknown device", status: 400 };
  const s = store();
  const now = Date.now();
  let fails = (await s.get("auth/fails")) || { count: 0, since: now };
  if (now - fails.since > 3600_000) fails = { count: 0, since: now };
  if (fails.count >= MAX_FAILS) return { error: "Too many attempts. Try again later.", status: 429 };

  if (!passcode || !safeEqual(passcode, process.env.JARVIS_PASSCODE || "")) {
    fails.count += 1;
    await s.setJSON("auth/fails", fails);
    return { error: "Incorrect passcode.", status: 401 };
  }
  await s.setJSON("auth/fails", { count: 0, since: now });
  const payload = b64(JSON.stringify({ d: device, exp: now + TOKEN_DAYS * 86400_000 }));
  return { token: `${payload}.${sign(payload)}`, device };
}

export function verify(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const { d, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() > exp || !DEVICES.includes(d)) return null;
    return d;
  } catch {
    return null;
  }
}
