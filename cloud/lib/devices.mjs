// Command queue between devices, and "last seen" presence.
import { store, newId } from "./store.mjs";

const ONLINE_MS = 90_000;

export async function touch(device) {
  const s = store();
  const key = `devices/${device}`;
  const info = (await s.get(key)) || {};
  if (!info.lastSeen || Date.now() - info.lastSeen > 30_000) {
    await s.setJSON(key, { lastSeen: Date.now() });
  }
}

export async function isOnline(device) {
  const info = await store().get(`devices/${device}`);
  return !!info && Date.now() - info.lastSeen < ONLINE_MS;
}

export async function status() {
  const out = {};
  for (const d of ["phone", "laptop"]) {
    const info = await store().get(`devices/${d}`);
    out[d] = { lastSeen: info?.lastSeen || null, online: !!info && Date.now() - info.lastSeen < ONLINE_MS };
  }
  return out;
}

export async function enqueue(device, action) {
  const cmd = { id: newId(), ts: Date.now(), ...action };
  await store().setJSON(`commands/${device}/${cmd.id}`, cmd);
  return cmd;
}

export async function pending(device) {
  const s = store();
  const { blobs } = await s.list({ prefix: `commands/${device}/` });
  const cmds = (await Promise.all(blobs.map((b) => s.get(b.key)))).filter(Boolean);
  // Drop stale commands (older than a day) so a laptop that was off for a week doesn't suddenly open 20 tabs.
  const fresh = [];
  for (const c of cmds) {
    if (Date.now() - c.ts > 86400_000) await s.delete(`commands/${device}/${c.id}`);
    else fresh.push(c);
  }
  return fresh.sort((a, b) => a.ts - b.ts);
}

export async function done(device, id) {
  await store().delete(`commands/${device}/${id}`);
}
