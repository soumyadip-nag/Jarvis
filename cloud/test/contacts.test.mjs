import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneActionToUrl } from "../lib/actions.mjs";
import "../public/contacts.js";

const { rank, bestMatch } = globalThis.JarvisContacts;
const contacts = [
  { name: "Ravi Kumar", tel: "+919800000001" },
  { name: "Ravi Shah", tel: "+919800000002" },
  { name: "Soumyadip Nag", tel: "+919800000003" },
  { name: "Maa", tel: "+919800000004" },
  { name: "Dr. Priya Sen", tel: "+919800000005" },
];
const best = (query) => bestMatch(rank(query, contacts))?.name ?? null;

test("exact, first-name and partial names find the contact", () => {
  assert.equal(best("Soumyadip Nag"), "Soumyadip Nag");
  assert.equal(best("soumyadip"), "Soumyadip Nag");
  assert.equal(best("Priya"), "Dr. Priya Sen");
  assert.equal(best("my maa"), "Maa");
});

test("speech-recognition spelling mistakes still match", () => {
  assert.equal(best("Soumyadeep"), "Soumyadip Nag");
  assert.equal(best("Priyaa Sen"), "Dr. Priya Sen");
});

test("two people with the same first name are not guessed", () => {
  const matches = rank("Ravi", contacts);
  assert.deepEqual(matches.map((m) => m.name).sort(), ["Ravi Kumar", "Ravi Shah"]);
  assert.equal(bestMatch(matches), null);
  assert.equal(best("Ravi Shah"), "Ravi Shah");
});

test("the same person saved twice isn't treated as two people", () => {
  const saved = [
    { name: "Ankita Sen", tel: "+91 98000 00007" },
    { name: "Ankita Sen", tel: "098000-00007" },
    { name: "Ankita", tel: "9800000007" },
  ];
  const matches = rank("Ankita", saved);
  assert.equal(matches.length, 1);
  assert.ok(bestMatch(matches));
  // Two different people with the same name still need asking.
  const twoPeople = [{ name: "Ankita Sen", tel: "9800000007" }, { name: "Ankita Roy", tel: "9800000008" }];
  assert.equal(bestMatch(rank("Ankita", twoPeople)), null);
});

test("a name nobody has finds nothing", () => {
  assert.deepEqual(rank("Zebediah", contacts), []);
  assert.equal(best("Zebediah"), null);
});

test("calls to a name go to the phone's contacts; numbers go straight to the dialler", () => {
  assert.equal(phoneActionToUrl({ action: "call", target: "Ravi" }).contact, "Ravi");
  assert.equal(phoneActionToUrl({ action: "call", target: "Ravi" }).url, undefined);
  assert.equal(phoneActionToUrl({ action: "call", target: "+91 98000 00001" }).url, "tel:+919800000001");
  assert.equal(phoneActionToUrl({ action: "call", target: "" }).url, "tel:");
});
