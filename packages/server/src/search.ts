import type { ResolvedCard } from "@highlander/shared";
import { toResolved, type ScryCard } from "./cards.js";

/**
 * Card search via Scryfall's `cards/search` endpoint. Results use the Scryfall
 * id as their identifier, so adding a search hit to a deck stores a stable id
 * (which the deck loader and card resolver both understand).
 *
 * We pass the user's query straight through to Scryfall's powerful search
 * syntax (https://scryfall.com/docs/syntax), defaulting to one printing per
 * card, ordered by name.
 */
const ENDPOINT = "https://api.scryfall.com/cards/search";

export interface SearchResult {
  cards: ResolvedCard[];
  hasMore: boolean;
  total: number;
}

export async function searchCards(query: string, page = 1): Promise<SearchResult> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&unique=cards&order=name&page=${page}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Highlander/0.1 (web Commander client)" },
    });
    if (res.status === 404) return { cards: [], hasMore: false, total: 0 }; // Scryfall: no cards matched
    if (!res.ok) {
      console.error(`Scryfall search error ${res.status}`);
      return { cards: [], hasMore: false, total: 0 };
    }
    const json = (await res.json()) as { data?: ScryCard[]; has_more?: boolean; total_cards?: number };
    return {
      cards: (json.data ?? []).map((c) => toResolved(c.id, c)),
      hasMore: !!json.has_more,
      total: json.total_cards ?? 0,
    };
  } catch (err) {
    console.error("Scryfall search failed:", err);
    return { cards: [], hasMore: false, total: 0 };
  }
}
