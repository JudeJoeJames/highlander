import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeckEntry, SavedDeck } from "@highlander/shared";

/**
 * Dead-simple persistent deck store: the whole collection lives in one JSON
 * file, loaded into memory at startup and rewritten on each change. Decks are
 * owned by an ownerId (a per-browser user key today; a real account id once
 * magic-link auth lands). Good enough for the scale here; swap for a database
 * without touching callers.
 */
export class DeckStore {
  private readonly decks = new Map<string, SavedDeck>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const arr = JSON.parse(readFileSync(file, "utf8")) as SavedDeck[];
        for (const d of arr) this.decks.set(d.id, d);
      } catch (err) {
        console.error("Failed to load decks file; starting empty:", err);
      }
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
  }

  list(ownerId: string): SavedDeck[] {
    return [...this.decks.values()]
      .filter((d) => d.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SavedDeck | undefined {
    return this.decks.get(id);
  }

  /** Create (no id) or update (existing id owned by the same owner). */
  async upsert(input: unknown, now: number): Promise<SavedDeck> {
    const draft = input as Partial<SavedDeck>;
    if (typeof draft.ownerId !== "string" || !draft.ownerId) throw new Error("ownerId required");

    const commanders = Array.isArray(draft.commanders) ? draft.commanders.filter((x): x is string => typeof x === "string") : [];
    const cards: DeckEntry[] = Array.isArray(draft.cards)
      ? draft.cards
          .filter((e): e is DeckEntry => !!e && typeof e.id === "string" && typeof e.count === "number")
          .map((e) => ({ id: e.id, count: Math.max(1, Math.floor(e.count)) }))
      : [];

    const existing = draft.id ? this.decks.get(draft.id) : undefined;
    if (existing && existing.ownerId !== draft.ownerId) throw new Error("not your deck");

    const deck: SavedDeck = {
      id: existing?.id ?? randomUUID(),
      name: (draft.name ?? "Untitled deck").slice(0, 80),
      ownerId: draft.ownerId,
      commanders,
      cards,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.decks.set(deck.id, deck);
    await this.persist();
    return deck;
  }

  async remove(id: string, ownerId: string): Promise<boolean> {
    const deck = this.decks.get(id);
    if (!deck || deck.ownerId !== ownerId) return false;
    this.decks.delete(id);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    try {
      await writeFile(this.file, JSON.stringify([...this.decks.values()], null, 2));
    } catch (err) {
      console.error("Failed to persist decks:", err);
    }
  }
}
