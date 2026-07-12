import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Action,
  GameCommand,
  GameState,
  Phase,
  Zone,
  createGame,
  reduce,
  viewFor,
} from "../src/index.js";

function apply(state: GameState, actorId: string, action: Action): GameState {
  const cmd: GameCommand = { action, actorId };
  return reduce(state, cmd);
}

function twoPlayerGame(): GameState {
  let s = createGame("g1", 12345);
  s = apply(s, "A", { type: "join", playerId: "A", name: "Ada", seat: 0 });
  s = apply(s, "B", { type: "join", playerId: "B", name: "Boris", seat: 1 });
  const lib = (prefix: string) => Array.from({ length: 20 }, (_, i) => `${prefix}-${i}`);
  s = apply(s, "A", { type: "load_deck", playerId: "A", commanders: ["cmdA"], library: lib("a") });
  s = apply(s, "B", { type: "load_deck", playerId: "B", commanders: ["cmdB"], library: lib("b") });
  return s;
}

test("join + load_deck + start_game deals opening hands and starts turn 1", () => {
  let s = twoPlayerGame();
  s = apply(s, "A", { type: "start_game" });

  assert.equal(s.status, "active");
  assert.equal(s.players["A"]!.life, 40);
  assert.equal(s.players["A"]!.hand.length, 7);
  assert.equal(s.players["A"]!.library.length, 13);
  assert.equal(s.players["A"]!.command.length, 1);
  assert.equal(s.turn.activePlayerId, "A");
  assert.equal(s.turn.turnNumber, 1);
});

test("deterministic shuffle: same seed → same opening hand", () => {
  const a = apply(twoPlayerGame(), "A", { type: "start_game" });
  const b = apply(twoPlayerGame(), "A", { type: "start_game" });
  assert.deepEqual(a.players["A"]!.hand, b.players["A"]!.hand);
});

test("move_card to graveyard resets battlefield state and reverts control", () => {
  let s = apply(twoPlayerGame(), "A", { type: "start_game" });
  const handTop = s.players["A"]!.hand[0]!;
  s = apply(s, "A", { type: "move_card", instanceId: handTop, toZone: Zone.Battlefield, x: 0.5, y: 0.5 });
  s = apply(s, "A", { type: "set_tapped", instanceId: handTop, tapped: true });
  s = apply(s, "B", { type: "set_controller", instanceId: handTop, controllerId: "B" });

  s = apply(s, "A", { type: "move_card", instanceId: handTop, toZone: Zone.Graveyard });
  const c = s.cards[handTop]!;
  assert.equal(c.zone, Zone.Graveyard);
  assert.equal(c.tapped, false);
  assert.equal(c.controllerId, "A", "control reverts to owner off the battlefield");
  assert.ok(s.players["A"]!.graveyard.includes(handTop), "lands in OWNER's graveyard");
});

test("end_turn rotates active player and untaps the new player's permanents", () => {
  let s = apply(twoPlayerGame(), "A", { type: "start_game" });
  const bCard = s.players["B"]!.hand[0]!;
  s = apply(s, "B", { type: "move_card", instanceId: bCard, toZone: Zone.Battlefield });
  s = apply(s, "B", { type: "set_tapped", instanceId: bCard, tapped: true });

  s = apply(s, "A", { type: "end_turn" });
  assert.equal(s.turn.activePlayerId, "B");
  assert.equal(s.cards[bCard]!.tapped, false, "B's permanents untap on B's turn");
});

test("advance_phase walks the phase order and wraps into the next turn", () => {
  let s = apply(twoPlayerGame(), "A", { type: "start_game" });
  assert.equal(s.turn.phase, Phase.Untap);
  // 11 advances reach Cleanup; the 12th wraps to the next player's turn.
  for (let i = 0; i < 11; i++) s = apply(s, "A", { type: "advance_phase" });
  assert.equal(s.turn.phase, Phase.Cleanup);
  s = apply(s, "A", { type: "advance_phase" });
  assert.equal(s.turn.activePlayerId, "B");
  assert.equal(s.turn.phase, Phase.Untap);
});

test("redaction hides libraries from all and hands from opponents", () => {
  const s = apply(twoPlayerGame(), "A", { type: "start_game" });
  const viewForB = viewFor(s, "B");

  for (const id of s.players["A"]!.library) {
    assert.equal(viewForB.cards[id]!.hidden, true, "A's library is hidden from B");
    assert.equal(viewForB.cards[id]!.scryfallId, "");
  }
  for (const id of s.players["A"]!.hand) {
    assert.equal(viewForB.cards[id]!.hidden, true, "A's hand is hidden from B");
  }
  // B can still see their own hand, and the command zone is public.
  for (const id of s.players["B"]!.hand) {
    assert.notEqual(viewForB.cards[id]!.hidden, true);
  }
  const cmdA = s.players["A"]!.command[0]!;
  assert.notEqual(viewForB.cards[cmdA]!.hidden, true, "command zone is public");
});

test("+1/+1 and -1/-1 counters annihilate in pairs", () => {
  let s = apply(twoPlayerGame(), "A", { type: "start_game" });
  const id = s.players["A"]!.hand[0]!;
  s = apply(s, "A", { type: "move_card", instanceId: id, toZone: Zone.Battlefield });
  s = apply(s, "A", { type: "adjust_card_counter", instanceId: id, key: "+1/+1", delta: 3 });
  s = apply(s, "A", { type: "adjust_card_counter", instanceId: id, key: "-1/-1", delta: 1 });
  // One -1/-1 cancels one +1/+1 → net +2/+2, no -1/-1 left.
  assert.equal(s.cards[id]!.counters["+1/+1"], 2);
  assert.equal(s.cards[id]!.counters["-1/-1"], undefined);

  // Adding two more -1/-1 wipes the remaining +2/+2 and leaves nothing.
  s = apply(s, "A", { type: "adjust_card_counter", instanceId: id, key: "-1/-1", delta: 2 });
  assert.equal(s.cards[id]!.counters["+1/+1"], undefined);
  assert.equal(s.cards[id]!.counters["-1/-1"], undefined);
});

test("reduce does not mutate its input (purity)", () => {
  const s = twoPlayerGame();
  const before = structuredClone(s);
  apply(s, "A", { type: "start_game" });
  assert.deepEqual(s, before, "input state is untouched");
});
