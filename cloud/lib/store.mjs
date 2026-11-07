// Storage: Netlify Blobs in production, a JSON-file store for local tests (JARVIS_LOCAL_STORE=dir).
import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";
import { currentUser } from "./users.mjs";

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, encodeURIComponent(key) + ".json");
  return {
    async get(key) {
      try { return JSON.parse(fs.readFileSync(file(key), "utf8")); } catch { return null; }
    },
    async setJSON(key, value) { fs.writeFileSync(file(key), JSON.stringify(value)); },
    async delete(key) { try { fs.unlinkSync(file(key)); } catch {} },
    async list({ prefix = "" } = {}) {
      const keys = fs.readdirSync(dir).map((f) => decodeURIComponent(f.replace(/\.json$/, "")));
      return { blobs: keys.filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })) };
    },
  };
}

let cached;
/** The whole store, for what isn't anyone's own data, such as login attempts. */
export function globalStore() {
  if (cached) return cached;
  if (process.env.JARVIS_LOCAL_STORE) {
    cached = fileStore(process.env.JARVIS_LOCAL_STORE);
  } else {
    const blobs = getStore({ name: "jarvis", consistency: "strong" });
    cached = {
      get: (key) => blobs.get(key, { type: "json" }),
      setJSON: (key, value) => blobs.setJSON(key, value),
      delete: (key) => blobs.delete(key),
      list: (opts) => blobs.list(opts),
    };
  }
  return cached;
}

/** One person's space. The owner's data stays at the top level; everyone else's is under users/<id>/. */
export function store() {
  const base = globalStore();
  const { id } = currentUser();
  if (!id) return base;
  const prefix = `users/${id}/`;
  return {
    get: (key) => base.get(prefix + key),
    setJSON: (key, value) => base.setJSON(prefix + key, value),
    delete: (key) => base.delete(prefix + key),
    list: async (opts = {}) => {
      const { blobs } = await base.list({ ...opts, prefix: prefix + (opts.prefix || "") });
      return { blobs: blobs.map((b) => ({ ...b, key: b.key.slice(prefix.length) })) };
    },
  };
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
