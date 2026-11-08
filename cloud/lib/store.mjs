// Storage: Cloudflare D1 when running as a Worker (see worker.mjs), Netlify Blobs on Netlify, and a JSON-file
// store for local tests (JARVIS_LOCAL_STORE=dir). All three keep JSON values under string keys.
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

let d1 = null;
const tableReady = new WeakMap(); // for each database: the table has been created

/** The Worker hands over its D1 database binding with every request. */
export function useD1(database) {
  d1 = database;
}

/**
 * Keys and JSON values in one D1 table. A listing also returns the values, and keeps them for the get() calls that
 * usually follow, because D1 allows a limited number of queries for each request.
 */
function d1Store(db) {
  if (!tableReady.has(db)) tableReady.set(db, db.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run());
  const listed = new Map();
  const ready = () => tableReady.get(db);
  return {
    async get(key) {
      if (listed.has(key)) {
        const value = listed.get(key);
        listed.delete(key);
        return value;
      }
      await ready();
      const row = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(key).first();
      return row ? JSON.parse(row.value) : null;
    },
    async setJSON(key, value) {
      await ready();
      listed.delete(key);
      await db.prepare("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key, JSON.stringify(value)).run();
    },
    async delete(key) {
      await ready();
      listed.delete(key);
      await db.prepare("DELETE FROM kv WHERE key = ?1").bind(key).run();
    },
    async list({ prefix = "" } = {}) {
      await ready();
      const { results } = await db.prepare("SELECT key, value FROM kv WHERE key >= ?1 AND key < ?2 ORDER BY key")
        .bind(prefix, prefix + "\uffff").all();
      for (const row of results) listed.set(row.key, JSON.parse(row.value));
      return { blobs: results.map((row) => ({ key: row.key })) };
    },
  };
}

let localStore;
/**
 * The whole store, for what isn't anyone's own data, such as login attempts.
 * Netlify's connection is rebuilt each time: its token only lasts for the request, but a server can stay up for
 * many requests, so keeping one would fail everything with "Token expired" once it ran out.
 */
export function globalStore() {
  if (d1 || globalThis.__JARVIS_TEST_D1) return d1Store(d1 || globalThis.__JARVIS_TEST_D1(process.env.JARVIS_LOCAL_STORE));
  if (process.env.JARVIS_LOCAL_STORE) {
    localStore ||= fileStore(process.env.JARVIS_LOCAL_STORE);
    return localStore;
  }
  const blobs = getStore({ name: "jarvis", consistency: "strong" });
  return {
    get: (key) => blobs.get(key, { type: "json" }),
    setJSON: (key, value) => blobs.setJSON(key, value),
    delete: (key) => blobs.delete(key),
    list: (opts) => blobs.list(opts),
  };
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
