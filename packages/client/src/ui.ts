import { Phase, Zone, type Action, type CardInstance, type GameState, type PlayerId, type ResolvedCard } from "@highlander/shared";

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

/** Turn/phase strip: shows the turn + active player and highlights the phase.
 *  Clicking a cell jumps to that phase (set_phase). */
export function phaseStrip(send: Send) {
  const host = document.getElementById("phasestrip")!;
  const cells: { label: string; phases: Phase[] }[] = [
    { label: "Untap", phases: [Phase.Untap] },
    { label: "Upkeep", phases: [Phase.Upkeep] },
    { label: "Draw", phases: [Phase.Draw] },
    { label: "Main 1", phases: [Phase.PrecombatMain] },
    { label: "Combat", phases: [Phase.BeginCombat, Phase.DeclareAttackers, Phase.DeclareBlockers, Phase.CombatDamage, Phase.EndCombat] },
    { label: "Main 2", phases: [Phase.PostcombatMain] },
    { label: "End", phases: [Phase.End, Phase.Cleanup] },
  ];

  host.innerHTML = "";
  const turnEl = document.createElement("div");
  turnEl.className = "ps-turn";
  host.appendChild(turnEl);
  const cellEls = cells.map((c) => {
    const b = document.createElement("button");
    b.className = "ps-cell";
    b.textContent = c.label;
    b.onclick = () => send({ type: "set_phase", phase: c.phases[0]! });
    host.appendChild(b);
    return b;
  });

  return {
    update(state: GameState) {
      if (state.status !== "active") {
        host.classList.add("hidden");
        return;
      }
      host.classList.remove("hidden");
      const active = state.turn.activePlayerId ? (state.players[state.turn.activePlayerId]?.name ?? "?") : "?";
      turnEl.textContent = `Turn ${state.turn.turnNumber} · ${active}`;
      cells.forEach((c, i) => cellEls[i]!.classList.toggle("active", c.phases.includes(state.turn.phase)));
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

/**
 * Closer-look panel for a card: large image + type/oracle text, plus the manual
 * actions you can take on it (when you own or control it). Replaces the old tiny
 * action menu — one click now both shows the card and offers its actions.
 */
export function cardDetail(send: Send) {
  const el = document.createElement("div");
  el.id = "carddetail";
  el.className = "hidden";
  document.body.appendChild(el);

  const hide = () => el.classList.add("hidden");
  document.addEventListener("pointerdown", (e) => {
    if (!el.classList.contains("hidden") && !el.contains(e.target as Node)) hide();
  });

  const div = (cls: string, text: string) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  };

  function show(card: CardInstance, resolved: ResolvedCard | undefined, canAct: boolean) {
    el.innerHTML = "";
    const close = document.createElement("button");
    close.className = "cd-close";
    close.textContent = "✕";
    close.onclick = hide;
    el.appendChild(close);

    if (card.hidden) {
      el.appendChild(div("cd-name", "Hidden card"));
      el.classList.remove("hidden");
      return;
    }

    const img = resolved?.imageNormal ?? resolved?.imageSmall;
    if (img) {
      const im = document.createElement("img");
      im.className = "cd-img";
      im.src = img;
      im.alt = resolved?.name ?? "";
      el.appendChild(im);
    }

    const info = document.createElement("div");
    info.className = "cd-info";
    info.appendChild(div("cd-name", resolved?.name ?? card.scryfallId));
    const sub = [resolved?.typeLine, resolved?.manaCost].filter(Boolean).join("   ");
    if (sub) info.appendChild(div("cd-type", sub));
    if (resolved?.oracleText) info.appendChild(div("cd-oracle", resolved.oracleText));
    el.appendChild(info);

    if (canAct) {
      const actions = document.createElement("div");
      actions.className = "cd-actions";
      const act = (label: string, action: Action, closeAfter = true) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.onclick = () => {
          send(action);
          if (closeAfter) hide();
        };
        actions.appendChild(b);
      };
      const id = card.instanceId;
      const onBf = card.zone === Zone.Battlefield;
      if (!onBf) act("To battlefield", { type: "move_card", instanceId: id, toZone: Zone.Battlefield });
      if (onBf) act(card.tapped ? "Untap" : "Tap", { type: "set_tapped", instanceId: id, tapped: !card.tapped }, false);
      act("Hand", { type: "move_card", instanceId: id, toZone: Zone.Hand });
      act("Graveyard", { type: "move_card", instanceId: id, toZone: Zone.Graveyard });
      act("Exile", { type: "move_card", instanceId: id, toZone: Zone.Exile });
      act("Library top", { type: "move_card", instanceId: id, toZone: Zone.Library, index: 0 });
      // Omitting index appends → bottom of library.
      act("Library bottom", { type: "move_card", instanceId: id, toZone: Zone.Library });
      if (onBf) {
        act("+1/+1 ＋", { type: "adjust_card_counter", instanceId: id, key: "+1/+1", delta: 1 }, false);
        act("+1/+1 −", { type: "adjust_card_counter", instanceId: id, key: "+1/+1", delta: -1 }, false);
        act("−1/−1 ＋", { type: "adjust_card_counter", instanceId: id, key: "-1/-1", delta: 1 }, false);
        act("−1/−1 −", { type: "adjust_card_counter", instanceId: id, key: "-1/-1", delta: -1 }, false);
      }
      el.appendChild(actions);
    }
    el.classList.remove("hidden");
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
