// Who can use Jarvis, and whose request is being handled.
//
// The owner signs in with JARVIS_PASSCODE, as before. Anyone else is an entry in JARVIS_USERS, a JSON list:
//   [{"id":"sam","name":"Sam Example","honorific":"Sam","passcode":"..."}]
// Each person gets a separate space in the store (see store.mjs) and an equal share of every usage limit.
import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage();

const owner = () => ({
  id: null, // the owner's data stays at the top of the store, where it has always been
  name: process.env.USER_NAME || "the user",
  honorific: process.env.HONORIFIC || "sir",
  passcode: process.env.JARVIS_PASSCODE || "",
});

function otherUsers() {
  if (!process.env.JARVIS_USERS) return [];
  try {
    return JSON.parse(process.env.JARVIS_USERS)
      .filter((u) => /^[a-z0-9-]+$/.test(u.id || "") && u.passcode)
      .map((u) => ({ id: u.id, name: u.name || u.id, honorific: u.honorific || u.name || u.id, passcode: u.passcode }));
  } catch (e) {
    console.error("JARVIS_USERS is not valid JSON, so only the owner can sign in:", e.message);
    return [];
  }
}

export const allUsers = () => [owner(), ...otherUsers()];
export const findUser = (id) => allUsers().find((u) => u.id === (id ?? null)) || null;
export const currentUser = () => current.getStore() || owner();
export const runAsUser = (user, fn) => current.run(user, fn);

/** One person's equal part of a shared limit. Unused shares aren't passed on to anyone else. */
export const shareOf = (total) => Math.max(1, Math.floor(total / allUsers().length));
