// Storage: Netlify Blobs in production, a JSON-file store for local tests (JARVIS_LOCAL_STORE=dir).
import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";

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
export function store() {
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

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
