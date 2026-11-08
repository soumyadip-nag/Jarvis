// Runs the test suite against the D1 storage used on Cloudflare, with a stand-in for D1 built on Node's SQLite:
//     node --import ./test/use-d1.mjs --test test/*.test.mjs     (npm run test:d1)
// Each test file points JARVIS_LOCAL_STORE at a folder and clears it to start afresh, so each folder gets its own
// database, emptied whenever that folder has been cleared.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const databases = new Map();

function fakeD1(folder) {
  const marker = folder && path.join(folder, ".d1");
  let db = databases.get(folder);
  if (!db || (marker && !fs.existsSync(marker))) {
    db = new DatabaseSync(":memory:");
    databases.set(folder, db);
    databases.delete(`${folder}#d1`); // a new database is a new binding, as it would be on Cloudflare
    if (marker) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(marker, "");
    }
  }
  const prepare = (sql) => {
    let params = [];
    const statement = {
      bind: (...values) => { params = values; return statement; },
      first: async () => databases.get(folder).prepare(sql).get(...params) ?? null,
      all: async () => ({ results: databases.get(folder).prepare(sql).all(...params) }),
      run: async () => { databases.get(folder).prepare(sql).run(...params); return { success: true }; },
    };
    return statement;
  };
  return databases.get(`${folder}#d1`) || databases.set(`${folder}#d1`, { prepare }).get(`${folder}#d1`);
}

globalThis.__JARVIS_TEST_D1 = fakeD1;
