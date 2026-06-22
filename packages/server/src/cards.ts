import { isScryfallId, type ResolvedCard } from "@highlander/shared";

/**
 * Resolves card identifiers (Scryfall ids or names) to displayable data via
 * Scryfall's bulk `cards/collection` endpoint, and caches results in memory.
 *
 * Why server-side: one cache serves every player (no duplicate lookups), and a
 * single place to honor Scryfall's API etiquette — batch (≤75/request), a small
 * delay between requests, and a descriptive User-Agent/Accept. Card *images*
 * are still loaded directly by clients from Scryfall's CDN (which is built for
 * hotlinking with caching); we only proxy the lightweight metadata + image URLs.
 *
 * Future: persist the cache to disk so restarts don't refetch; Scryfall data is
 * effectively immutable per card id.
 */
const ENDPOINT = "https://api.scryfall.com/cards/collection";
const BATCH = 75;
const REQUEST_DELAY_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScryImageUris {
  small?: string;
  normal?: string;
}
interface ScryFace {
  name: string;
  oracle_text?: string;
  mana_cost?: string;
  type_line?: string;
  image_uris?: ScryImageUris;
}
interface ScryCard {
  id: string;
  name: string;
  type_line?: string;
  mana_cost?: string;
  oracle_text?: string;
  image_uris?: ScryImageUris;
  card_faces?: ScryFace[];
}

export class CardCache {
  /** keyed by lowercased identifier */
  private readonly cache = new Map<string, ResolvedCard>();

  async resolve(identifiers: string[]): Promise<Record<string, ResolvedCard>> {
    const out: Record<string, ResolvedCard> = {};
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const idf of identifiers) {
      if (!idf) continue;
      const key = idf.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = this.cache.get(key);
      if (hit) out[idf] = { ...hit, identifier: idf };
      else missing.push(idf);
    }

    for (let i = 0; i < missing.length; i += BATCH) {
      await this.fetchBatch(missing.slice(i, i + BATCH), out);
      if (i + BATCH < missing.length) await sleep(REQUEST_DELAY_MS);
    }
    return out;
  }

  private async fetchBatch(group: string[], out: Record<string, ResolvedCard>): Promise<void> {
    const identifiers = group.map((idf) => (isScryfallId(idf) ? { id: idf } : { name: idf }));
    let data: ScryCard[] = [];
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Highlander/0.1 (web Commander client)",
        },
        body: JSON.stringify({ identifiers }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: ScryCard[] };
        data = json.data ?? [];
      } else {
        console.error(`Scryfall collection error ${res.status}`);
      }
    } catch (err) {
      console.error("Scryfall fetch failed:", err);
    }

    // Index returned cards by id and by (front-face) name for matching back.
    const byId = new Map<string, ScryCard>();
    const byName = new Map<string, ScryCard>();
    for (const c of data) {
      byId.set(c.id, c);
      byName.set(c.name.toLowerCase(), c);
      const front = c.card_faces?.[0]?.name;
      if (front) byName.set(front.toLowerCase(), c);
    }

    for (const idf of group) {
      const card = isScryfallId(idf) ? byId.get(idf) : byName.get(idf.toLowerCase());
      const resolved = card ? toResolved(idf, card) : { identifier: idf, found: false, name: idf };
      this.cache.set(idf.toLowerCase(), resolved);
      out[idf] = resolved;
    }
  }
}

function toResolved(identifier: string, c: ScryCard): ResolvedCard {
  const faces = c.card_faces?.map((f) => ({
    name: f.name,
    imageSmall: f.image_uris?.small,
    imageNormal: f.image_uris?.normal,
    oracleText: f.oracle_text,
    manaCost: f.mana_cost,
    typeLine: f.type_line,
  }));
  const img = c.image_uris ?? c.card_faces?.[0]?.image_uris;
  return {
    identifier,
    found: true,
    scryfallId: c.id,
    name: c.name,
    typeLine: c.type_line,
    manaCost: c.mana_cost,
    oracleText: c.oracle_text,
    imageSmall: img?.small,
    imageNormal: img?.normal,
    ...(faces ? { faces } : {}),
  };
}
