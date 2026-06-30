import { Action, GameCommand, IllegalActionError } from "./actions.js";
import { mulberry32, nextSeed, shuffleInPlace } from "./rng.js";
import {
  CardInstance,
  GameState,
  InstanceId,
  PHASE_ORDER,
  Phase,
  PlayerId,
  PlayerState,
  Zone,
} from "./types.js";

const DEFAULT_STARTING_LIFE = 40; // Commander
const DEFAULT_OPENING_HAND = 7;
const MAX_PLAYERS = 4;

/** Create an empty game in the lobby state. */
export function createGame(id: string, rngSeed: number): GameState {
  return {
    id,
    version: 0,
    status: "lobby",
    seats: [],
    players: {},
    cards: {},
    battlefield: [],
    stack: [],
    turn: { activePlayerId: null, turnNumber: 0, phase: Phase.Untap, priorityPlayerId: null },
    log: [],
    rngSeed: rngSeed >>> 0,
    nextInstanceSeq: 1,
  };
}

/**
 * The one and only state transition. Pure: returns a NEW state and never
 * mutates its input. Throws IllegalActionError when a command can't be applied;
 * callers (the server) catch this and reject the command without changing state.
 */
export function reduce(prev: GameState, cmd: GameCommand): GameState {
  const state: GameState = structuredClone(prev);
  const { action, actorId } = cmd;

  // Universal guard: the actor must be a known player (except when joining).
  if (action.type !== "join" && !state.players[actorId]) {
    throw new IllegalActionError(`Unknown actor: ${actorId}`);
  }

  const log = applyAction(state, action, actorId);

  state.version += 1;
  if (log) state.log.push({ seq: state.version, actorId, text: log });
  return state;
}

// --- helpers ----------------------------------------------------------------

function player(state: GameState, id: PlayerId): PlayerState {
  const p = state.players[id];
  if (!p) throw new IllegalActionError(`No such player: ${id}`);
  return p;
}

function card(state: GameState, id: InstanceId): CardInstance {
  const c = state.cards[id];
  if (!c) throw new IllegalActionError(`No such card: ${id}`);
  return c;
}

/** The ordered id list backing a (zone, owner). Battlefield/stack are global. */
function zoneList(state: GameState, zone: Zone, ownerId: PlayerId): InstanceId[] {
  switch (zone) {
    case Zone.Battlefield:
      return state.battlefield;
    case Zone.Stack:
      return state.stack;
    case Zone.Library:
      return player(state, ownerId).library;
    case Zone.Hand:
      return player(state, ownerId).hand;
    case Zone.Graveyard:
      return player(state, ownerId).graveyard;
    case Zone.Exile:
      return player(state, ownerId).exile;
    case Zone.Command:
      return player(state, ownerId).command;
  }
}

function removeFromZone(state: GameState, c: CardInstance): void {
  const list = zoneList(state, c.zone, c.ownerId);
  const i = list.indexOf(c.instanceId);
  if (i >= 0) list.splice(i, 1);
}

/** Core movement primitive used by many actions. */
function moveCard(
  state: GameState,
  c: CardInstance,
  toZone: Zone,
  opts: { index?: number; x?: number; y?: number } = {},
): void {
  removeFromZone(state, c);

  const leavingBattlefield = c.zone === Zone.Battlefield && toZone !== Zone.Battlefield;
  c.zone = toZone;

  // Objects shed transient state when they leave the battlefield, and control
  // reverts to the owner everywhere except the battlefield/stack.
  if (leavingBattlefield) {
    c.tapped = false;
    c.flipped = false;
    c.faceDown = false;
    c.counters = {};
    delete c.attachedTo;
    delete c.x;
    delete c.y;
    delete c.annotation;
  }
  if (toZone !== Zone.Battlefield && toZone !== Zone.Stack) {
    c.controllerId = c.ownerId;
  }
  if (toZone === Zone.Battlefield) {
    if (opts.x !== undefined) c.x = opts.x;
    if (opts.y !== undefined) c.y = opts.y;
  }

  // Detach anything that was attached to this card when it changes zone.
  for (const other of Object.values(state.cards)) {
    if (other.attachedTo === c.instanceId) delete other.attachedTo;
  }

  const dest = zoneList(state, toZone, c.ownerId);
  if (opts.index === undefined || opts.index >= dest.length) dest.push(c.instanceId);
  else dest.splice(Math.max(0, opts.index), 0, c.instanceId);
}

function newInstance(state: GameState, scryfallId: string, ownerId: PlayerId, zone: Zone): CardInstance {
  const instanceId = `c${state.nextInstanceSeq++}`;
  const c: CardInstance = {
    instanceId,
    scryfallId,
    ownerId,
    controllerId: ownerId,
    zone,
    tapped: false,
    flipped: false,
    faceDown: false,
    counters: {},
  };
  state.cards[instanceId] = c;
  return c;
}

function withRng<T>(state: GameState, fn: (rng: () => number) => T): T {
  const rng = mulberry32(state.rngSeed);
  const result = fn(rng);
  state.rngSeed = nextSeed(rng);
  return result;
}

function requireActive(state: GameState): void {
  if (state.status !== "active") throw new IllegalActionError("Game is not active.");
}

// --- the action handlers -----------------------------------------------------

/** Applies the action to `state` (mutating the clone) and returns a log line. */
function applyAction(state: GameState, action: Action, actorId: PlayerId): string | null {
  switch (action.type) {
    case "join": {
      if (state.players[action.playerId]) {
        // Re-join / reconnect: just refresh name + mark connected.
        const p = state.players[action.playerId]!;
        p.name = action.name;
        p.connected = true;
        return `${p.name} reconnected.`;
      }
      if (state.seats.length >= MAX_PLAYERS) throw new IllegalActionError("Game is full.");
      if (state.seats.some((id) => state.players[id]!.seat === action.seat)) {
        throw new IllegalActionError(`Seat ${action.seat} is taken.`);
      }
      state.players[action.playerId] = {
        id: action.playerId,
        name: action.name,
        seat: action.seat,
        connected: true,
        life: DEFAULT_STARTING_LIFE,
        commanderDamage: {},
        counters: {},
        manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
        library: [],
        hand: [],
        graveyard: [],
        exile: [],
        command: [],
      };
      state.seats.push(action.playerId);
      state.seats.sort((a, b) => state.players[a]!.seat - state.players[b]!.seat);
      return `${action.name} joined (seat ${action.seat}).`;
    }

    case "leave": {
      const p = player(state, action.playerId);
      p.connected = false;
      return `${p.name} left.`;
    }

    case "set_connected": {
      player(state, action.playerId).connected = action.connected;
      return null;
    }

    case "load_deck": {
      if (state.status !== "lobby") throw new IllegalActionError("Decks load only in the lobby.");
      const p = player(state, action.playerId);
      // Clear any previously loaded deck for this player.
      for (const id of [...p.command, ...p.library]) delete state.cards[id];
      p.command = [];
      p.library = [];
      for (const sid of action.commanders) p.command.push(newInstance(state, sid, p.id, Zone.Command).instanceId);
      for (const sid of action.library) p.library.push(newInstance(state, sid, p.id, Zone.Library).instanceId);
      return `${p.name} loaded a deck (${action.commanders.length} commander, ${action.library.length} cards).`;
    }

    case "start_game": {
      if (state.status === "active") throw new IllegalActionError("Game already started.");
      if (state.seats.length < 2) throw new IllegalActionError("Need at least 2 players.");
      const life = action.startingLife ?? DEFAULT_STARTING_LIFE;
      const hand = action.openingHand ?? DEFAULT_OPENING_HAND;
      for (const id of state.seats) {
        const p = state.players[id]!;
        p.life = life;
        withRng(state, (rng) => shuffleInPlace(p.library, rng));
        drawCards(state, p, hand);
      }
      state.status = "active";
      const first = state.seats[0]!;
      state.turn = { activePlayerId: first, turnNumber: 1, phase: Phase.Untap, priorityPlayerId: first };
      return `Game started. ${state.players[first]!.name} takes turn 1.`;
    }

    case "adjust_life": {
      requireActive(state);
      const p = player(state, action.playerId);
      p.life += action.delta;
      return `${p.name} life ${action.delta >= 0 ? "+" : ""}${action.delta} → ${p.life}.`;
    }

    case "set_life": {
      const p = player(state, action.playerId);
      p.life = action.life;
      return `${p.name} life set to ${action.life}.`;
    }

    case "set_counter": {
      const p = player(state, action.playerId);
      if (action.value === 0) delete p.counters[action.key];
      else p.counters[action.key] = action.value;
      return `${p.name} ${action.key} = ${action.value}.`;
    }

    case "set_commander_damage": {
      const p = player(state, action.playerId);
      if (action.value === 0) delete p.commanderDamage[action.sourceInstanceId];
      else p.commanderDamage[action.sourceInstanceId] = action.value;
      return `${p.name} commander damage updated.`;
    }

    case "set_mana": {
      const p = player(state, action.playerId);
      p.manaPool[action.color] = Math.max(0, action.value);
      return null;
    }

    case "empty_mana": {
      const p = player(state, action.playerId);
      p.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      return null;
    }

    case "move_card": {
      const c = card(state, action.instanceId);
      const opts: { index?: number; x?: number; y?: number } = {};
      if (action.index !== undefined) opts.index = action.index;
      if (action.x !== undefined) opts.x = action.x;
      if (action.y !== undefined) opts.y = action.y;
      const from = c.zone;
      moveCard(state, c, action.toZone, opts);
      return `${actorName(state, actorId)} moved a card ${from} → ${action.toZone}.`;
    }

    case "set_tapped": {
      const c = card(state, action.instanceId);
      c.tapped = action.tapped;
      return null;
    }

    case "adjust_card_counter": {
      const c = card(state, action.instanceId);
      const next = (c.counters[action.key] ?? 0) + action.delta;
      if (next === 0) delete c.counters[action.key];
      else c.counters[action.key] = next;
      return null;
    }

    case "set_card_flags": {
      const c = card(state, action.instanceId);
      if (action.flipped !== undefined) c.flipped = action.flipped;
      if (action.faceDown !== undefined) c.faceDown = action.faceDown;
      return null;
    }

    case "set_card_position": {
      const c = card(state, action.instanceId);
      c.x = action.x;
      c.y = action.y;
      return null;
    }

    case "set_controller": {
      const c = card(state, action.instanceId);
      player(state, action.controllerId); // validate target exists
      c.controllerId = action.controllerId;
      return `${actorName(state, actorId)} changed a card's controller.`;
    }

    case "attach": {
      const c = card(state, action.instanceId);
      if (action.toInstanceId === null) {
        delete c.attachedTo;
      } else {
        card(state, action.toInstanceId); // validate
        if (action.toInstanceId === c.instanceId) throw new IllegalActionError("Cannot attach to self.");
        c.attachedTo = action.toInstanceId;
      }
      return null;
    }

    case "annotate": {
      const c = card(state, action.instanceId);
      if (action.text) c.annotation = action.text;
      else delete c.annotation;
      return null;
    }

    case "draw": {
      const p = player(state, action.playerId);
      const n = drawCards(state, p, action.count);
      return `${p.name} drew ${n} card${n === 1 ? "" : "s"}.`;
    }

    case "shuffle": {
      const p = player(state, action.playerId);
      withRng(state, (rng) => shuffleInPlace(p.library, rng));
      return `${p.name} shuffled their library.`;
    }

    case "mulligan": {
      const p = player(state, action.playerId);
      // London mulligan, manual bottoming: return hand to library, reshuffle, redraw 7.
      for (const id of [...p.hand]) moveCard(state, state.cards[id]!, Zone.Library);
      withRng(state, (rng) => shuffleInPlace(p.library, rng));
      drawCards(state, p, action.handSize ?? DEFAULT_OPENING_HAND);
      return `${p.name} mulliganed.`;
    }

    case "untap_all": {
      requireActive(state);
      const p = player(state, action.playerId);
      for (const id of state.battlefield) {
        const c = state.cards[id]!;
        if (c.controllerId === action.playerId) c.tapped = false;
      }
      return `${p.name} untapped their permanents.`;
    }

    case "set_phase": {
      requireActive(state);
      state.turn.phase = action.phase;
      return `Phase → ${action.phase}.`;
    }

    case "advance_phase": {
      requireActive(state);
      const i = PHASE_ORDER.indexOf(state.turn.phase);
      if (i === PHASE_ORDER.length - 1) return endTurn(state);
      state.turn.phase = PHASE_ORDER[i + 1]!;
      state.turn.priorityPlayerId = state.turn.activePlayerId;
      return `Phase → ${state.turn.phase}.`;
    }

    case "pass_priority": {
      requireActive(state);
      const order = state.seats;
      const cur = state.turn.priorityPlayerId ?? state.turn.activePlayerId;
      const idx = cur ? order.indexOf(cur) : -1;
      state.turn.priorityPlayerId = order[(idx + 1) % order.length] ?? null;
      return null;
    }

    case "end_turn": {
      requireActive(state);
      return endTurn(state);
    }

    case "roll_die": {
      const result = withRng(state, (rng) => 1 + Math.floor(rng() * action.sides));
      return `${player(state, action.playerId).name} rolled a d${action.sides}: ${result}.`;
    }

    case "flip_coin": {
      const heads = withRng(state, (rng) => rng() < 0.5);
      return `${player(state, action.playerId).name} flipped: ${heads ? "heads" : "tails"}.`;
    }
  }
}

function drawCards(state: GameState, p: PlayerState, count: number): number {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const topId = p.library[0];
    if (!topId) break; // empty library — manual mode does not auto-lose
    moveCard(state, state.cards[topId]!, Zone.Hand);
    drawn++;
  }
  return drawn;
}

function endTurn(state: GameState): string {
  const order = state.seats;
  const cur = state.turn.activePlayerId;
  const idx = cur ? order.indexOf(cur) : -1;
  const nextId = order[(idx + 1) % order.length]!;

  // Untap step: untap all permanents the new active player controls.
  for (const id of state.battlefield) {
    const c = state.cards[id]!;
    if (c.controllerId === nextId) c.tapped = false;
  }
  // Empty mana pools at turn change (manual convenience).
  for (const id of order) state.players[id]!.manaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

  const wrapped = idx + 1 >= order.length;
  state.turn = {
    activePlayerId: nextId,
    turnNumber: state.turn.turnNumber + (wrapped ? 1 : 0),
    phase: Phase.Untap,
    priorityPlayerId: nextId,
  };
  return `Turn passes to ${state.players[nextId]!.name}.`;
}

function actorName(state: GameState, actorId: PlayerId): string {
  return state.players[actorId]?.name ?? actorId;
}
