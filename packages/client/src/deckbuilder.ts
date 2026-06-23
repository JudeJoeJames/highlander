import {
  validateCommanderDeck,
  type DeckEntry,
  type DraftDeck,
  type ResolvedCard,
  type SavedDeck,
} from "@highlander/shared";
import { deleteDeck, listDecks, resolveCards, saveDeck, searchCards } from "./api";

/**
 * Full-screen deck builder overlay. Self-contained: builds its own DOM, talks to
 * the server API, validates live with the shared Commander validator, and saves
 * decks under the given user id. Search hits store their Scryfall id, so saved
 * decks load straight into a game and resolve to real art.
 */
let current: HTMLElement | null = null;

export function openDeckbuilder(userId: string): void {
  if (current) return; // already open

  const working: Required<DraftDeck> = { id: "", name: "Untitled deck", commanders: [], cards: [] };
  const resolved: Record<string, ResolvedCard> = {};
  let results: ResolvedCard[] = [];
  let page = 1;
  let query = "";
  let hasMore = false;

  // --- DOM scaffold ---
  const root = el("div", { id: "deckbuilder" });
  root.innerHTML = `
    <div class="db-header">
      <h2>Deck Builder</h2>
      <select id="db-list" title="Load a saved deck"><option value="">— saved decks —</option></select>
      <button id="db-new" type="button">New</button>
      <button id="db-import" type="button">Import</button>
      <button id="db-delete" type="button" class="danger">Delete</button>
      <span class="db-spacer"></span>
      <span id="db-status" class="db-status"></span>
      <button id="db-close" type="button" class="primary">Done</button>
    </div>
    <div class="db-body">
      <section class="db-search">
        <form id="db-search-form">
          <input id="db-q" type="text" placeholder="Search cards (Scryfall syntax: t:creature, c:wu, cmc<=3…)" autocomplete="off" />
          <label class="db-check"><input id="db-legal" type="checkbox" checked /> Commander-legal only</label>
          <button type="submit">Search</button>
        </form>
        <div id="db-results" class="db-results"></div>
        <button id="db-more" type="button" class="db-more hidden">Load more</button>
      </section>
      <section class="db-deck">
        <input id="db-name" type="text" maxlength="80" />
        <div class="db-section-title">Commander</div>
        <div id="db-commanders" class="db-commanders"></div>
        <div id="db-validation" class="db-validation"></div>
        <div class="db-section-title">Mana curve</div>
        <div id="db-curve" class="db-curve"></div>
        <div class="db-section-title">Cards (<span id="db-count">0</span>)</div>
        <div id="db-cards" class="db-cards"></div>
        <button id="db-save" type="button" class="primary db-save">Save deck</button>
      </section>
    </div>`;
  document.body.appendChild(root);
  current = root;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const statusEl = $("#db-status");
  const setStatus = (msg: string) => {
    statusEl.textContent = msg;
    if (msg) setTimeout(() => (statusEl.textContent === msg ? (statusEl.textContent = "") : null), 2500);
  };

  function close() {
    root.remove();
    current = null;
  }

  // --- helpers ---
  const entry = (id: string): DeckEntry | undefined => working.cards.find((e) => e.id === id);

  function addToDeck(card: ResolvedCard) {
    resolved[card.identifier] = card;
    const e = entry(card.identifier);
    if (e) e.count += 1;
    else working.cards.push({ id: card.identifier, count: 1 });
    renderDeck();
  }

  function toggleCommander(card: ResolvedCard) {
    resolved[card.identifier] = card;
    const i = working.commanders.indexOf(card.identifier);
    if (i >= 0) {
      working.commanders.splice(i, 1);
    } else {
      // Remove from the 99 if present, then add (cap at 2, dropping the oldest).
      working.cards = working.cards.filter((e) => e.id !== card.identifier);
      working.commanders.push(card.identifier);
      if (working.commanders.length > 2) working.commanders.shift();
    }
    renderDeck();
  }

  function changeCount(id: string, delta: number) {
    const e = entry(id);
    if (!e) return;
    e.count += delta;
    if (e.count <= 0) working.cards = working.cards.filter((x) => x.id !== id);
    renderDeck();
  }

  // --- rendering ---
  function cardRow(card: ResolvedCard, controls: HTMLElement): HTMLElement {
    const legal = card.commanderLegal !== false;
    return el("div", { class: "db-row" }, [
      card.imageSmall
        ? el("img", { class: "db-thumb", src: card.imageSmall, alt: card.name, loading: "lazy" })
        : el("div", { class: "db-thumb db-thumb-empty" }),
      el("div", { class: "db-row-main" }, [
        el("div", { class: "db-row-name" }, [
          el("span", { class: `db-dot ${legal ? "ok" : "bad"}`, title: legal ? "Commander legal" : "Not legal" }),
          document.createTextNode(card.name),
        ]),
        el("div", { class: "db-row-sub" }, [document.createTextNode(`${card.typeLine ?? ""} ${card.manaCost ?? ""}`.trim())]),
      ]),
      controls,
    ]);
  }

  function renderResults() {
    const host = $("#db-results");
    host.innerHTML = "";
    if (!results.length) {
      host.appendChild(el("div", { class: "db-empty" }, [document.createTextNode(query ? "No matches." : "Search to add cards.")]));
    }
    for (const card of results) {
      const controls = el("div", { class: "db-row-actions" }, [
        button("+ 99", () => addToDeck(card)),
        button("★ Cmd", () => toggleCommander(card)),
      ]);
      host.appendChild(cardRow(card, controls));
    }
    $("#db-more").classList.toggle("hidden", !hasMore);
  }

  function renderDeck() {
    $<HTMLInputElement>("#db-name").value = working.name;

    // Commanders
    const cmdHost = $("#db-commanders");
    cmdHost.innerHTML = "";
    if (!working.commanders.length) {
      cmdHost.appendChild(el("div", { class: "db-empty" }, [document.createTextNode("Pick a commander with ★ Cmd.")]));
    }
    for (const id of working.commanders) {
      const card = resolved[id];
      const ctrl = el("div", { class: "db-row-actions" }, [button("Remove", () => toggleCommander(card ?? ({ identifier: id, name: id, found: false } as ResolvedCard)))]);
      cmdHost.appendChild(cardRow(card ?? placeholder(id), ctrl));
    }

    // The 99
    const cardsHost = $("#db-cards");
    cardsHost.innerHTML = "";
    const sorted = [...working.cards].sort((a, b) => name(a.id).localeCompare(name(b.id)));
    for (const e of sorted) {
      const card = resolved[e.id] ?? placeholder(e.id);
      const ctrl = el("div", { class: "db-row-actions db-stepper" }, [
        button("−", () => changeCount(e.id, -1)),
        el("span", { class: "db-qty" }, [document.createTextNode(String(e.count))]),
        button("+", () => changeCount(e.id, +1)),
      ]);
      cardsHost.appendChild(cardRow(card, ctrl));
    }

    const total = working.commanders.length + working.cards.reduce((n, e) => n + e.count, 0);
    $("#db-count").textContent = String(total);
    renderValidation();
    renderCurve();
  }

  /** Mana curve of nonland cards in the 99, bucketed by mana value (7+ combined). */
  function renderCurve() {
    const host = $("#db-curve");
    host.innerHTML = "";
    const buckets = [0, 0, 0, 0, 0, 0, 0, 0]; // index = mana value, 7 = "7+"
    for (const e of working.cards) {
      const card = resolved[e.id];
      if (!card) continue;
      if ((card.typeLine ?? "").toLowerCase().includes("land")) continue;
      const idx = Math.min(7, Math.max(0, Math.floor(card.cmc ?? 0)));
      buckets[idx] += e.count;
    }
    const max = Math.max(1, ...buckets);
    buckets.forEach((n, i) => {
      const bar = el("div", { class: "db-curve-bar" });
      bar.style.height = `${(n / max) * 100}%`;
      const col = el("div", { class: "db-curve-col" }, [
        el("div", { class: "db-curve-n" }, [document.createTextNode(String(n))]),
        el("div", { class: "db-curve-barwrap" }, [bar]),
        el("div", { class: "db-curve-label" }, [document.createTextNode(i === 7 ? "7+" : String(i))]),
      ]);
      host.appendChild(col);
    });
  }

  function renderValidation() {
    const host = $("#db-validation");
    host.innerHTML = "";
    const result = validateCommanderDeck(working, resolved);

    const head = el("div", { class: `db-valhead ${result.ok ? "ok" : "bad"}` }, [
      document.createTextNode(`${result.size}/100 · ${result.ok ? "Legal ✓" : "Not legal"}`),
    ]);
    if (result.colorIdentity.length) {
      head.appendChild(el("span", { class: "db-ci" }, [document.createTextNode(`{${result.colorIdentity.join("")}}`)]));
    }
    host.appendChild(head);

    // Show errors first, then warnings (cap to keep it tidy).
    const ordered = [...result.issues].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
    for (const issue of ordered.slice(0, 12)) {
      host.appendChild(el("div", { class: `db-issue ${issue.level}` }, [document.createTextNode(issue.message)]));
    }
    if (ordered.length > 12) host.appendChild(el("div", { class: "db-issue" }, [document.createTextNode(`…and ${ordered.length - 12} more.`)]));
  }

  function name(id: string): string {
    return resolved[id]?.name ?? id;
  }
  function placeholder(id: string): ResolvedCard {
    return { identifier: id, name: id, found: false };
  }

  // --- data flow ---
  async function doSearch(reset: boolean) {
    if (reset) {
      page = 1;
      results = [];
    }
    let q = query;
    if ($<HTMLInputElement>("#db-legal").checked && !/legal:|f:/i.test(q)) q = `legal:commander ${q}`;
    setStatus("Searching…");
    try {
      const res = await searchCards(q, page);
      results = reset ? res.cards : results.concat(res.cards);
      hasMore = res.hasMore;
      setStatus(res.total ? `${res.total} result${res.total === 1 ? "" : "s"}` : "");
      renderResults();
    } catch {
      setStatus("Search failed.");
    }
  }

  async function refreshDeckList(selectedId = "") {
    const decks = await listDecks(userId).catch(() => [] as SavedDeck[]);
    const select = $<HTMLSelectElement>("#db-list");
    select.innerHTML = '<option value="">— saved decks —</option>';
    for (const d of decks) {
      const opt = el("option", { value: d.id }, [document.createTextNode(d.name)]) as HTMLOptionElement;
      select.appendChild(opt);
    }
    select.value = selectedId;
  }

  async function loadDeck(deck: SavedDeck) {
    working.id = deck.id;
    working.name = deck.name;
    working.commanders = [...deck.commanders];
    working.cards = deck.cards.map((e) => ({ ...e }));
    renderDeck();
    setStatus("Resolving cards…");
    const ids = [...deck.commanders, ...deck.cards.map((e) => e.id)];
    try {
      Object.assign(resolved, await resolveCards(ids));
    } catch {
      /* leave placeholders */
    }
    setStatus("");
    renderDeck();
  }

  async function save() {
    working.name = $<HTMLInputElement>("#db-name").value.trim() || "Untitled deck";
    setStatus("Saving…");
    try {
      const saved = await saveDeck({
        id: working.id || undefined,
        name: working.name,
        ownerId: userId,
        commanders: working.commanders,
        cards: working.cards,
      });
      working.id = saved.id;
      await refreshDeckList(saved.id);
      setStatus("Saved ✓");
    } catch {
      setStatus("Save failed.");
    }
  }

  function openImportModal() {
    const overlay = el("div", { class: "modal-overlay" });
    const close = () => overlay.remove();
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close();
    });
    const ta = el("textarea", {
      class: "db-import-text",
      placeholder: "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n10 Forest\n…",
    }) as HTMLTextAreaElement;
    const importBtn = button("Import", () => {
      void importDeck(ta.value);
      close();
    });
    importBtn.className = "primary";
    const panel = el("div", { class: "modal" }, [
      el("h3", {}, [document.createTextNode("Import decklist")]),
      el("div", { class: "modal-note" }, [
        document.createTextNode('Paste lines like "1 Sol Ring". A "Commander" header marks commanders; set/collector annotations are ignored.'),
      ]),
      ta,
      el("div", { class: "db-import-actions" }, [importBtn, button("Cancel", close)]),
    ]);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    ta.focus();
  }

  async function importDeck(text: string) {
    const parsed = parseDecklist(text);
    const names = [...new Set([...parsed.commanders, ...parsed.cards.map((c) => c.name)])];
    if (!names.length) return;
    setStatus(`Resolving ${names.length} cards…`);
    const map = await resolveCards(names).catch(() => ({}) as Record<string, ResolvedCard>);

    // Prefer the resolved Scryfall id as the deck identifier (stable + real art);
    // fall back to the raw name (shown as "unknown") when a line doesn't resolve.
    const idFor = (cardName: string): string => {
      const card = map[cardName];
      if (card && card.found && card.scryfallId) {
        resolved[card.scryfallId] = { ...card, identifier: card.scryfallId };
        return card.scryfallId;
      }
      resolved[cardName] = { identifier: cardName, name: cardName, found: false };
      return cardName;
    };

    working.commanders = parsed.commanders.map(idFor);
    const merged = new Map<string, number>();
    for (const c of parsed.cards) {
      const id = idFor(c.name);
      merged.set(id, (merged.get(id) ?? 0) + c.count);
    }
    working.cards = [...merged.entries()]
      .filter(([id]) => !working.commanders.includes(id))
      .map(([id, count]) => ({ id, count }));

    const notFound = names.filter((n) => !map[n]?.found).length;
    setStatus(notFound ? `Imported — ${notFound} card(s) not found` : "Imported ✓");
    renderDeck();
  }

  // --- wire events ---
  $("#db-close").addEventListener("click", close);
  $("#db-save").addEventListener("click", save);
  $("#db-more").addEventListener("click", () => {
    page += 1;
    void doSearch(false);
  });
  const runSearch = () => {
    query = $<HTMLInputElement>("#db-q").value.trim();
    void doSearch(true);
  };
  $("#db-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch();
  });
  // Explicit Enter handling (preventDefault stops the implicit submit firing too).
  $<HTMLInputElement>("#db-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  });
  $("#db-import").addEventListener("click", openImportModal);
  $<HTMLInputElement>("#db-name").addEventListener("input", (e) => {
    working.name = (e.target as HTMLInputElement).value;
  });
  $("#db-new").addEventListener("click", () => {
    working.id = "";
    working.name = "Untitled deck";
    working.commanders = [];
    working.cards = [];
    $<HTMLSelectElement>("#db-list").value = "";
    renderDeck();
  });
  $("#db-delete").addEventListener("click", async () => {
    if (!working.id) return;
    await deleteDeck(working.id, userId);
    working.id = "";
    await refreshDeckList();
    setStatus("Deleted");
  });
  $<HTMLSelectElement>("#db-list").addEventListener("change", async (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (!id) return;
    const decks = await listDecks(userId).catch(() => [] as SavedDeck[]);
    const deck = decks.find((d) => d.id === id);
    if (deck) await loadDeck(deck);
  });

  // initial paint
  renderResults();
  renderDeck();
  void refreshDeckList();
}

// --- tiny DOM helpers -------------------------------------------------------
function el(tag: string, attrs: Record<string, string> = {}, children: Node[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.appendChild(c);
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

interface ParsedCard {
  count: number;
  name: string;
}

/**
 * Parse a pasted decklist. Handles the common formats: "1 Card", "1x Card",
 * with optional "Commander" / "Deck" section headers (Moxfield/Archidekt style)
 * and trailing set/collector annotations like "(CMM) 410". Lines under a
 * sideboard/maybeboard/tokens header are ignored.
 */
export function parseDecklist(text: string): { commanders: string[]; cards: ParsedCard[] } {
  const commanders: string[] = [];
  const cards: ParsedCard[] = [];
  let section: "main" | "commander" | "ignore" = "main";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    const lower = line.toLowerCase();
    if (/^commanders?\b:?$/.test(lower)) {
      section = "commander";
      continue;
    }
    if (/^(deck|mainboard|main|cards|companion)\b:?$/.test(lower)) {
      section = "main";
      continue;
    }
    if (/^(sideboard|sb|maybeboard|maybe|tokens)\b/.test(lower)) {
      section = "ignore";
      continue;
    }
    if (section === "ignore") continue;

    const m = line.match(/^(\d+)\s*[xX]?\s+(.+)$/);
    let count = 1;
    let name = line;
    if (m) {
      count = parseInt(m[1]!, 10);
      name = m[2]!;
    }
    // Drop trailing set/collector annotations (real card names have no parens).
    name = name.replace(/\s*\(.*$/, "").trim();
    if (!name) continue;

    if (section === "commander") commanders.push(name);
    else cards.push({ count: Math.max(1, count), name });
  }
  return { commanders, cards };
}
