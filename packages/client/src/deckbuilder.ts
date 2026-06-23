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

  // --- wire events ---
  $("#db-close").addEventListener("click", close);
  $("#db-save").addEventListener("click", save);
  $("#db-more").addEventListener("click", () => {
    page += 1;
    void doSearch(false);
  });
  $("#db-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    query = $<HTMLInputElement>("#db-q").value.trim();
    void doSearch(true);
  });
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
