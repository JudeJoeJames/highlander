import type { ResolveCardsResponse, ResolvedCard } from "@highlander/shared";

/**
 * Client-side card data + image cache. Given the identifiers currently in view,
 * it resolves any it hasn't seen (batched through the server's /api/cards) and
 * lazily loads their images from Scryfall's CDN. Anything newly resolved or
 * loaded fires `onChange`, which re-runs the board layout so faces pop in as
 * they arrive — no blocking, no flicker.
 */
export class CardLibrary {
  private readonly resolved = new Map<string, ResolvedCard>();
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly apiBase: string,
    private readonly onChange: () => void,
  ) {}

  get(identifier: string): ResolvedCard | undefined {
    return this.resolved.get(identifier);
  }

  /** Loaded <img> for an identifier, or undefined if not ready yet. */
  image(identifier: string): HTMLImageElement | undefined {
    return this.images.get(identifier);
  }

  /** Resolve any identifiers we don't already have (or have in flight). */
  ensure(identifiers: Iterable<string>): void {
    const need: string[] = [];
    for (const id of identifiers) {
      if (id && !this.resolved.has(id) && !this.pending.has(id)) {
        this.pending.add(id);
        need.push(id);
      }
    }
    if (need.length) void this.fetchResolve(need);
  }

  private async fetchResolve(ids: string[]): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: ids }),
      });
      if (res.ok) {
        const json = (await res.json()) as ResolveCardsResponse;
        for (const [identifier, card] of Object.entries(json.cards)) {
          this.resolved.set(identifier, card);
          if (card.imageNormal) this.loadImage(identifier, card.imageNormal);
        }
      }
    } catch (err) {
      console.error("card resolve failed:", err);
    } finally {
      for (const id of ids) this.pending.delete(id);
      this.onChange();
    }
  }

  private loadImage(identifier: string, url: string): void {
    const img = new Image();
    img.crossOrigin = "anonymous"; // needed to use the pixels as a WebGL texture
    img.onload = () => {
      this.images.set(identifier, img);
      this.onChange();
    };
    img.src = url;
  }
}
