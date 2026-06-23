import { Zone, type Action, type CardInstance, type GameState, type PlayerId } from "@highlander/shared";

type Send = (action: Action) => void;

/** Status bar: connection state + table id + turn/phase readout. */
export function statusBar() {
  const conn = document.getElementById("conn")!;
  const gameid = document.getElementById("gameid")!;
  const turninfo = document.getElementById("turninfo")!;
  return {
    setGame(id: string) {
      gameid.textContent = `table: ${id}`;
    },
    setConn(status: "connecting" | "open" | "closed") {
      conn.textContent = status;
      conn.className = `pill ${status}`;
    },
    setTurn(state: GameState) {
      if (state.status !== "active") {
        turninfo.textContent = `lobby · ${state.seats.length} seated`;
        return;
      }
      const active = state.turn.activePlayerId ? state.players[state.turn.activePlayerId]?.name : "?";
      turninfo.textContent = `T${state.turn.turnNumber} · ${active} · ${state.turn.phase}`;
    },
  };
}

export interface ToolbarActions {
  onLoadDeck: () => void;
  onOpenDecks: () => void;
}

/** Bottom toolbar of common manual actions. */
export function toolbar(send: Send, you: PlayerId, actions: ToolbarActions) {
  const host = document.getElementById("toolbar")!;
  const btn = (label: string, onClick: () => void, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = onClick;
    host.appendChild(b);
    return b;
  };

  btn("Decks", actions.onOpenDecks);
  btn("Load deck", actions.onLoadDeck);
  btn("Start", () => send({ type: "start_game" }), "primary");
  btn("Draw", () => send({ type: "draw", playerId: you, count: 1 }));
  btn("Shuffle", () => send({ type: "shuffle", playerId: you }));
  btn("Life −1", () => send({ type: "adjust_life", playerId: you, delta: -1 }));
  btn("Life +1", () => send({ type: "adjust_life", playerId: you, delta: 1 }));
  btn("Next phase", () => send({ type: "advance_phase" }));
  btn("End turn", () => send({ type: "end_turn" }));
}

/** Floating action menu for a single card (the manual interaction surface). */
export function cardMenu(send: Send) {
  const el = document.getElementById("cardmenu")!;

  const hide = () => el.classList.add("hidden");
  document.addEventListener("pointerdown", (e) => {
    if (!el.contains(e.target as Node)) hide();
  });

  function show(card: CardInstance, screenX: number, screenY: number) {
    el.innerHTML = "";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = card.hidden ? "(hidden card)" : card.scryfallId || "card";
    el.appendChild(title);

    const act = (label: string, action: Action, cls = "") => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => {
        send(action);
        hide();
      };
      el.appendChild(b);
    };

    const id = card.instanceId;
    if (card.zone !== Zone.Battlefield) act("To battlefield", { type: "move_card", instanceId: id, toZone: Zone.Battlefield });
    if (card.zone === Zone.Battlefield) act(card.tapped ? "Untap" : "Tap", { type: "set_tapped", instanceId: id, tapped: !card.tapped });
    act("To hand", { type: "move_card", instanceId: id, toZone: Zone.Hand });
    act("To graveyard", { type: "move_card", instanceId: id, toZone: Zone.Graveyard });
    act("To exile", { type: "move_card", instanceId: id, toZone: Zone.Exile });
    act("To library top", { type: "move_card", instanceId: id, toZone: Zone.Library, index: 0 });
    if (card.zone === Zone.Battlefield) {
      act("+1/+1", { type: "adjust_card_counter", instanceId: id, key: "+1/+1", delta: 1 });
      act("−1/+1", { type: "adjust_card_counter", instanceId: id, key: "+1/+1", delta: -1 });
    }

    el.classList.remove("hidden");
    // Clamp to viewport.
    const rect = el.getBoundingClientRect();
    const x = Math.min(screenX, window.innerWidth - rect.width - 8);
    const y = Math.min(screenY, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }

  return { show, hide };
}

/** Chat panel wiring. */
export function chatPanel(onSend: (text: string) => void) {
  const panel = document.getElementById("chat")!;
  const toggle = document.getElementById("chat-toggle")!;
  const log = document.getElementById("chat-log")!;
  const form = document.getElementById("chat-form") as HTMLFormElement;
  const input = document.getElementById("chat-input") as HTMLInputElement;

  toggle.addEventListener("click", () => panel.classList.toggle("collapsed"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = "";
  });

  const append = (html: string) => {
    const row = document.createElement("div");
    row.innerHTML = html;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  };
  return {
    message(name: string, text: string) {
      append(`<span class="who">${esc(name)}:</span> ${esc(text)}`);
      if (panel.classList.contains("collapsed")) panel.classList.remove("collapsed");
    },
    system(text: string) {
      append(`<span class="sys">${esc(text)}</span>`);
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
