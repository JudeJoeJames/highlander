import { searchCards } from "./api";
import type { ResolvedCard } from "@highlander/shared";

/**
 * Modal picker for conjuring a token onto your battlefield. Uses the same
 * `/api/search` endpoint the deckbuilder uses, but forces `t:token` onto the
 * query so we only get token card faces from Scryfall. Selecting a result calls
 * back with its Scryfall id — the caller sends the `create_token` action.
 */
export function openTokenPicker(onPick: (scryfallId: string, name: string) => void): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const close = () => overlay.remove();
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });

  const panel = document.createElement("div");
  panel.className = "modal token-picker";

  const h = document.createElement("h3");
  h.textContent = "Create a token";
  panel.appendChild(h);

  const form = document.createElement("form");
  form.className = "tp-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "e.g. soldier · treasure · zombie · goblin";
  input.autocomplete = "off";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Search";
  form.appendChild(input);
  form.appendChild(submit);
  panel.appendChild(form);

  const status = document.createElement("div");
  status.className = "modal-note";
  panel.appendChild(status);

  const grid = document.createElement("div");
  grid.className = "tp-grid";
  panel.appendChild(grid);

  const cancel = document.createElement("button");
  cancel.textContent = "Close";
  cancel.addEventListener("click", close);
  panel.appendChild(cancel);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  input.focus();

  function render(cards: ResolvedCard[]) {
    grid.innerHTML = "";
    for (const c of cards) {
      if (!c.scryfallId) continue;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "tp-cell";
      cell.title = [c.name, c.typeLine].filter(Boolean).join(" — ");
      const img = c.imageSmall ?? c.imageNormal;
      if (img) {
        const im = document.createElement("img");
        im.src = img;
        im.alt = c.name;
        cell.appendChild(im);
      }
      const lbl = document.createElement("div");
      lbl.className = "tp-name";
      lbl.textContent = c.name;
      cell.appendChild(lbl);
      cell.addEventListener("click", () => {
        onPick(c.scryfallId!, c.name);
        close();
      });
      grid.appendChild(cell);
    }
  }

  async function run() {
    const user = input.value.trim();
    // `t:token` restricts to token cards; if the user typed nothing, browse them all by name.
    const q = user ? `t:token ${user}` : "t:token";
    status.textContent = "Searching…";
    grid.innerHTML = "";
    try {
      const res = await searchCards(q, 1);
      if (!res.cards.length) {
        status.textContent = "No tokens matched.";
        return;
      }
      status.textContent = `${res.total} match${res.total === 1 ? "" : "es"}${res.hasMore ? " (showing first page)" : ""}`;
      render(res.cards);
    } catch {
      status.textContent = "Search failed.";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run();
  });

  // Kick off an initial browse so the picker isn't empty on open.
  void run();
}
