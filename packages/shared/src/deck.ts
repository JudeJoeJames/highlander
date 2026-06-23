import type { ResolvedCard } from "./cards.js";

/**
 * Deck model + Commander/EDH legality validation. Lives in `shared` so the
 * client can validate live as you build, and the server can re-check on save.
 * Validation needs resolved card data (color identity, type, legality), passed
 * in as a lookup keyed by the same identifiers the deck stores.
 */

export interface DeckEntry {
  /** Card identifier (Scryfall id, or name) — same key used to resolve. */
  id: string;
  count: number;
}

export interface SavedDeck {
  id: string;
  name: string;
  ownerId: string;
  /** 1, or 2 for partners/background. */
  commanders: string[];
  /** The rest of the deck (the "99"), with counts. */
  cards: DeckEntry[];
  createdAt: number;
  updatedAt: number;
}

/** A deck still being edited (no id/timestamps yet). */
export interface DraftDeck {
  id?: string;
  name: string;
  commanders: string[];
  cards: DeckEntry[];
}

const BASIC_LANDS = new Set([
  "plains", "island", "swamp", "mountain", "forest", "wastes",
  "snow-covered plains", "snow-covered island", "snow-covered swamp",
  "snow-covered mountain", "snow-covered forest", "snow-covered wastes",
]);

export function isBasicLandName(name: string): boolean {
  return BASIC_LANDS.has(name.trim().toLowerCase());
}

/** True for cards that explicitly allow any number of copies. */
function allowsAnyNumber(card: ResolvedCard): boolean {
  if (isBasicLandName(card.name)) return true;
  return (card.oracleText ?? "").toLowerCase().includes("a deck can have any number of cards named");
}

export function deckSize(deck: DraftDeck): number {
  return deck.commanders.length + deck.cards.reduce((n, e) => n + e.count, 0);
}

/** Expand a deck into the flat lists the `load_deck` action expects. */
export function toLoadDeck(deck: DraftDeck): { commanders: string[]; library: string[] } {
  const library: string[] = [];
  for (const e of deck.cards) for (let i = 0; i < e.count; i++) library.push(e.id);
  return { commanders: [...deck.commanders], library };
}

export interface DeckValidationIssue {
  level: "error" | "warning";
  message: string;
}

export interface DeckValidationResult {
  ok: boolean;
  size: number;
  /** Combined commander color identity (WUBRG letters). */
  colorIdentity: string[];
  issues: DeckValidationIssue[];
}

function canBeCommander(card: ResolvedCard): boolean {
  const type = (card.typeLine ?? "").toLowerCase();
  const text = (card.oracleText ?? "").toLowerCase();
  return (type.includes("legendary") && type.includes("creature")) || text.includes("can be your commander");
}

/**
 * Validate a deck against the core Commander rules: exactly 100 cards, a legal
 * commander, singleton (except basics / "any number" cards), every card legal
 * in the format, and within the commander's color identity.
 *
 * Not (yet) enforced: full Partner/Background pairing rules, companion, and
 * the handful of cards that grant special deckbuilding exceptions.
 */
export function validateCommanderDeck(
  deck: DraftDeck,
  resolved: Record<string, ResolvedCard>,
): DeckValidationResult {
  const issues: DeckValidationIssue[] = [];
  const size = deckSize(deck);

  if (size !== 100) {
    issues.push({ level: "error", message: `Deck has ${size} cards; Commander requires exactly 100.` });
  }

  // --- commanders ---
  const commanderCards: ResolvedCard[] = [];
  if (deck.commanders.length === 0) {
    issues.push({ level: "error", message: "No commander selected." });
  } else if (deck.commanders.length > 2) {
    issues.push({ level: "error", message: "A deck can have at most 2 commanders (partners)." });
  }
  const colorIdentity = new Set<string>();
  for (const id of deck.commanders) {
    const card = resolved[id];
    if (!card || !card.found) {
      issues.push({ level: "error", message: `Unknown commander: ${id}` });
      continue;
    }
    commanderCards.push(card);
    if (!canBeCommander(card)) {
      issues.push({
        level: "error",
        message: `${card.name} can't be a commander (needs to be a legendary creature, or say "can be your commander").`,
      });
    }
    for (const c of card.colorIdentity ?? []) colorIdentity.add(c);
  }
  if (deck.commanders.length === 2 && commanderCards.length === 2) {
    const bothPartner = commanderCards.every((c) => (c.oracleText ?? "").toLowerCase().includes("partner"));
    const background =
      commanderCards.some((c) => (c.typeLine ?? "").toLowerCase().includes("background")) &&
      commanderCards.some((c) => (c.oracleText ?? "").toLowerCase().includes("choose a background"));
    if (!bothPartner && !background) {
      issues.push({ level: "warning", message: "Two commanders usually require Partner, or a Background pairing." });
    }
  }

  // --- per-card: aggregate copies by NAME so singleton is correct across printings ---
  interface Agg { count: number; card: ResolvedCard }
  const byName = new Map<string, Agg>();
  const entries: DeckEntry[] = [...deck.commanders.map((id) => ({ id, count: 1 })), ...deck.cards];
  for (const e of entries) {
    const card = resolved[e.id];
    if (!card || !card.found) {
      issues.push({ level: "error", message: `Unknown card: ${e.id}` });
      continue;
    }
    const key = card.name.toLowerCase();
    const agg = byName.get(key);
    if (agg) agg.count += e.count;
    else byName.set(key, { count: e.count, card });
  }

  for (const { count, card } of byName.values()) {
    if (count > 1 && !allowsAnyNumber(card)) {
      issues.push({ level: "error", message: `${card.name}: ${count} copies — Commander is singleton (max 1).` });
    }
    if (card.commanderLegal === false) {
      issues.push({ level: "error", message: `${card.name} is banned / not legal in Commander.` });
    }
    if (deck.commanders.length > 0) {
      const outside = (card.colorIdentity ?? []).filter((c) => !colorIdentity.has(c));
      if (outside.length) {
        issues.push({
          level: "error",
          message: `${card.name} is outside your commander's color identity ({${outside.join("")}}).`,
        });
      }
    }
  }

  return {
    ok: issues.every((i) => i.level !== "error"),
    size,
    colorIdentity: [...colorIdentity],
    issues,
  };
}
