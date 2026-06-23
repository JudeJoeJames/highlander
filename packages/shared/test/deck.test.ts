import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCommanderDeck, type DraftDeck, type ResolvedCard } from "../src/index.js";

// Tiny resolved-card fixtures.
const cards: Record<string, ResolvedCard> = {
  cmd: { identifier: "cmd", found: true, name: "Greenlord", typeLine: "Legendary Creature — Elf", colorIdentity: ["G"], commanderLegal: true },
  forest: { identifier: "forest", found: true, name: "Forest", typeLine: "Basic Land — Forest", colorIdentity: ["G"], commanderLegal: true },
  island: { identifier: "island", found: true, name: "Island", typeLine: "Basic Land — Island", colorIdentity: ["U"], commanderLegal: true },
  solring: { identifier: "solring", found: true, name: "Sol Ring", typeLine: "Artifact", colorIdentity: [], commanderLegal: true },
  banned: { identifier: "banned", found: true, name: "Channel", typeLine: "Sorcery", colorIdentity: ["G"], commanderLegal: false },
  rock: { identifier: "rock", found: true, name: "A Rock", typeLine: "Artifact", colorIdentity: [], commanderLegal: true },
};

const deck = (over: Partial<DraftDeck>): DraftDeck => ({ name: "d", commanders: ["cmd"], cards: [{ id: "forest", count: 99 }], ...over });

test("a legal 100-card singleton deck passes", () => {
  const r = validateCommanderDeck(deck({}), cards);
  assert.equal(r.size, 100);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(r.colorIdentity, ["G"]);
});

test("wrong deck size is an error", () => {
  const r = validateCommanderDeck(deck({ cards: [{ id: "forest", count: 50 }] }), cards);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.level === "error" && /100/.test(i.message)));
});

test("basic lands may exceed one copy, real cards may not", () => {
  // 99 Forests is fine (basic); but 2 Sol Rings is not.
  const bad = validateCommanderDeck(deck({ cards: [{ id: "solring", count: 2 }, { id: "forest", count: 97 }] }), cards);
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => /singleton/i.test(i.message)));
});

test("cards outside the commander's color identity are rejected", () => {
  const r = validateCommanderDeck(deck({ cards: [{ id: "island", count: 1 }, { id: "forest", count: 98 }] }), cards);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /color identity/i.test(i.message)));
});

test("banned cards are rejected", () => {
  const r = validateCommanderDeck(deck({ cards: [{ id: "banned", count: 1 }, { id: "forest", count: 98 }] }), cards);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /not legal/i.test(i.message)));
});

test("a non-legendary commander is rejected", () => {
  const r = validateCommanderDeck(deck({ commanders: ["rock"] }), cards);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /can't be a commander/i.test(i.message)));
});
