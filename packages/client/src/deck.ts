import type { Action, PlayerId } from "@highlander/shared";

/**
 * A throwaway 1-commander + 99 test deck. `scryfallId` is just a string the
 * client renders as text, so for now we use readable card names. When the
 * deckbuilder + Scryfall integration land, these become real Scryfall ids and
 * the board renders actual card art instead of text.
 */
const POOL = [
  "Sol Ring",
  "Arcane Signet",
  "Command Tower",
  "Cultivate",
  "Rampant Growth",
  "Swords to Plowshares",
  "Counterspell",
  "Lightning Bolt",
  "Llanowar Elves",
  "Birds of Paradise",
  "Beast Within",
  "Cyclonic Rift",
  "Smothering Tithe",
  "Rhystic Study",
  "Forest",
  "Island",
  "Plains",
  "Swamp",
  "Mountain",
];

export function testDeck(playerId: PlayerId): Extract<Action, { type: "load_deck" }> {
  const library = Array.from({ length: 99 }, (_, i) => POOL[i % POOL.length]!);
  return { type: "load_deck", playerId, commanders: ["Atraxa, Praetors' Voice"], library };
}
