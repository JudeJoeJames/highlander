import type { DraftDeck, ResolvedCard, SavedDeck } from "@highlander/shared";

/** Client wrappers around the server's JSON API (same-origin / Vite-proxied). */

export interface SearchResult {
  cards: ResolvedCard[];
  hasMore: boolean;
  total: number;
}

export async function searchCards(query: string, page = 1): Promise<SearchResult> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}`);
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  return (await res.json()) as SearchResult;
}

export async function resolveCards(identifiers: string[]): Promise<Record<string, ResolvedCard>> {
  if (!identifiers.length) return {};
  const res = await fetch("/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error(`resolve failed (${res.status})`);
  return ((await res.json()) as { cards: Record<string, ResolvedCard> }).cards;
}

export async function listDecks(ownerId: string): Promise<SavedDeck[]> {
  const res = await fetch(`/api/decks?owner=${encodeURIComponent(ownerId)}`);
  if (!res.ok) throw new Error(`list decks failed (${res.status})`);
  return ((await res.json()) as { decks: SavedDeck[] }).decks;
}

export async function saveDeck(deck: DraftDeck & { ownerId: string }): Promise<SavedDeck> {
  const res = await fetch("/api/decks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(deck),
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
  return ((await res.json()) as { deck: SavedDeck }).deck;
}

export async function deleteDeck(id: string, ownerId: string): Promise<void> {
  await fetch(`/api/decks/${encodeURIComponent(id)}?owner=${encodeURIComponent(ownerId)}`, { method: "DELETE" });
}
