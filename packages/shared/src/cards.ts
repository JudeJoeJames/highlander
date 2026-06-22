/**
 * Shapes for resolving a card *identifier* (a Scryfall id, or a card name for
 * now) into displayable data. The server talks to Scryfall and caches; the
 * client requests these over /api/cards and renders them.
 *
 * `CardInstance.scryfallId` is the identifier we look up. Decks currently store
 * card names there; once the deckbuilder stores real Scryfall ids, the same
 * pipeline resolves them (ids and names both work — see `isScryfallId`).
 */
export interface ResolvedCardFace {
  name: string;
  imageSmall?: string;
  imageNormal?: string;
  oracleText?: string;
  manaCost?: string;
  typeLine?: string;
}

export interface ResolvedCard {
  /** The identifier we were asked to resolve (echoed back as the map key). */
  identifier: string;
  found: boolean;
  scryfallId?: string;
  name: string;
  typeLine?: string;
  manaCost?: string;
  oracleText?: string;
  imageSmall?: string;
  imageNormal?: string;
  /** Present for double-faced / split cards. */
  faces?: ResolvedCardFace[];
}

export interface ResolveCardsRequest {
  identifiers: string[];
}

export interface ResolveCardsResponse {
  cards: Record<string, ResolvedCard>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if the identifier looks like a Scryfall id rather than a card name. */
export function isScryfallId(s: string): boolean {
  return UUID.test(s);
}
