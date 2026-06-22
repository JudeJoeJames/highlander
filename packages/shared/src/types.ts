/**
 * Core game-state model for Highlander (Commander/EDH).
 *
 * Design notes
 * ------------
 * - This model is *manual-first*: it faithfully represents where every object
 *   is and what state it carries, but it does NOT enforce MTG rules. Players
 *   move cards, tap, and adjust life themselves (Cockatrice / Tabletop-Sim
 *   style). Rules *assists* can be layered on later without changing this shape.
 * - The state is a plain, JSON-serializable value. The reducer (`reduce`) is the
 *   only thing allowed to change it, and it is a pure function of
 *   (state, command). Determinism matters: the same command stream replays to
 *   the same state on every machine, which is what keeps clients in sync and
 *   makes reconnection a simple snapshot.
 * - Randomness (shuffles) is driven by `rngSeed` stored *in* the state, so it
 *   stays deterministic across replays. The reducer advances the seed itself.
 * - Hidden information (libraries, hands, face-down cards) is NOT solved here.
 *   The server holds this full canonical state and sends each player a redacted
 *   view (see `redaction.ts`). Clients never receive cards they shouldn't see.
 */

export type GameId = string;
export type PlayerId = string;
/** Unique identity of a single physical card object within one game. */
export type InstanceId = string;
/** Scryfall card id — resolved client-side into image + oracle text. */
export type ScryfallId = string;

/** Zones a card object can occupy. */
export enum Zone {
  Library = "library",
  Hand = "hand",
  Battlefield = "battlefield",
  Graveyard = "graveyard",
  Exile = "exile",
  Command = "command",
  Stack = "stack",
}

/** Per-player ordered zones (the others — battlefield/stack — are global). */
export const PERSONAL_ZONES = [
  Zone.Library,
  Zone.Hand,
  Zone.Graveyard,
  Zone.Exile,
  Zone.Command,
] as const;

/** Turn structure. Order is significant — see `PHASE_ORDER`. */
export enum Phase {
  Untap = "untap",
  Upkeep = "upkeep",
  Draw = "draw",
  PrecombatMain = "precombat_main",
  BeginCombat = "begin_combat",
  DeclareAttackers = "declare_attackers",
  DeclareBlockers = "declare_blockers",
  CombatDamage = "combat_damage",
  EndCombat = "end_combat",
  PostcombatMain = "postcombat_main",
  End = "end",
  Cleanup = "cleanup",
}

export const PHASE_ORDER: readonly Phase[] = [
  Phase.Untap,
  Phase.Upkeep,
  Phase.Draw,
  Phase.PrecombatMain,
  Phase.BeginCombat,
  Phase.DeclareAttackers,
  Phase.DeclareBlockers,
  Phase.CombatDamage,
  Phase.EndCombat,
  Phase.PostcombatMain,
  Phase.End,
  Phase.Cleanup,
];

/** Mana colors plus colorless, used for the (manual) mana pool. */
export type ManaColor = "W" | "U" | "B" | "R" | "G" | "C";
export const MANA_COLORS: readonly ManaColor[] = ["W", "U", "B", "R", "G", "C"];

/**
 * A single card object. Lives in exactly one zone at a time. When masked for
 * an opponent's view, `hidden` is true and `scryfallId` is blanked.
 */
export interface CardInstance {
  instanceId: InstanceId;
  scryfallId: ScryfallId;
  /** The deck this card belongs to. Personal zones are keyed by owner. */
  ownerId: PlayerId;
  /** Who currently controls it. Differs from owner only on the battlefield/stack. */
  controllerId: PlayerId;
  zone: Zone;

  // Battlefield / object state -------------------------------------------------
  tapped: boolean;
  flipped: boolean;
  faceDown: boolean;
  /** Freeform counters, e.g. { "+1/+1": 2, "loyalty": 3 }. */
  counters: Record<string, number>;
  /** Aura/Equipment/fortification target, if attached. */
  attachedTo?: InstanceId;
  /** Normalized battlefield position [0..1], for board layout. */
  x?: number;
  y?: number;
  /** Free text shown on the stack or as a note (manual mode). */
  annotation?: string;

  /** Set only in redacted views sent to players who may not see this card. */
  hidden?: boolean;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  /** Seat index = turn order, 0..3. */
  seat: number;
  connected: boolean;

  life: number;
  /** Commander damage taken, keyed by the dealing commander's instanceId. */
  commanderDamage: Record<InstanceId, number>;
  /** Poison, energy, experience, etc. */
  counters: Record<string, number>;
  manaPool: Record<ManaColor, number>;

  // Ordered personal zones. Index 0 of `library` is the TOP of the library.
  library: InstanceId[];
  hand: InstanceId[];
  graveyard: InstanceId[];
  exile: InstanceId[];
  command: InstanceId[];
}

export interface LogEntry {
  /** Equals the state `version` at which this entry was appended. */
  seq: number;
  actorId: PlayerId;
  text: string;
}

export interface TurnState {
  activePlayerId: PlayerId | null;
  turnNumber: number;
  phase: Phase;
  /** Whose priority it is (manual passing). */
  priorityPlayerId: PlayerId | null;
}

export interface GameState {
  id: GameId;
  /** Monotonic counter, +1 per successfully applied command. */
  version: number;
  status: "lobby" | "active" | "finished";

  /** Turn order by seat. */
  seats: PlayerId[];
  players: Record<PlayerId, PlayerState>;

  /** Master registry of every card object in the game. */
  cards: Record<InstanceId, CardInstance>;
  /** Global zones (cards carry their own controllerId). */
  battlefield: InstanceId[];
  stack: InstanceId[];

  turn: TurnState;
  log: LogEntry[];

  /** Deterministic RNG state, advanced by the reducer on each random op. */
  rngSeed: number;
  /** Source of deterministic instance ids. */
  nextInstanceSeq: number;
}
