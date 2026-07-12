import { Plane, Raycaster, Vector2, Vector3 } from "three";
import { Zone, toLoadDeck, type Action, type GameState, type PlayerId, type SavedDeck } from "@highlander/shared";
import { DEFAULT_GAME_ID, getPlayerId, getSavedName, getUserId, saveName, SERVER_URL } from "./config";
import { Net } from "./net";
import { createScene } from "./scene";
import { CameraController } from "./camera";
import { Board } from "./board";
import { CardLibrary } from "./cards";
import { worldToBattlefield } from "./layout";
import { cardDetail, chatPanel, phaseStrip, statusBar, toolbar } from "./ui";
import { openDeckbuilder } from "./deckbuilder";
import { listDecks } from "./api";
import { testDeck } from "./deck";

const you: PlayerId = getPlayerId();

// --- scene + render loop (built once at startup) ---------------------------
const canvas = document.getElementById("board") as HTMLCanvasElement;
const labelHost = document.getElementById("labels") as HTMLElement;
const { renderer, labelRenderer, scene, camera, resize } = createScene(canvas, labelHost);
const cameraCtl = new CameraController(camera, renderer.domElement);
// Resolved-card cache; when cards/images arrive it re-lays the board so faces
// pop in as they load.
const cards = new CardLibrary("/api", () => {
  if (latest) board.update(latest, you);
});
const board = new Board(
  scene,
  cards,
  (playerId, delta) => net?.send({ type: "adjust_life", playerId, delta }),
  (playerId, key, value) => net?.send({ type: "set_counter", playerId, key, value }),
);
window.addEventListener("resize", resize);

function frame() {
  requestAnimationFrame(frame);
  cameraCtl.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
frame();

// --- UI singletons ----------------------------------------------------------
const status = statusBar();
const phases = phaseStrip((action) => net?.send(action));
const detail = cardDetail((action) => net?.send(action));
const selection = new Set<string>();
let net: Net | undefined;
let chat: ReturnType<typeof chatPanel> | undefined;

// State tracking for camera focus + log streaming.
let latest: GameState | null = null;
let lastActive: PlayerId | null = null;
let lastLogSeq = 0;

function onSnapshot(state: GameState, _you: PlayerId) {
  latest = state;

  // Resolve faces for every card we're allowed to see (hidden ones are masked
  // with a blank scryfallId, so they never trigger a lookup).
  const visible = new Set<string>();
  for (const c of Object.values(state.cards)) {
    if (c.scryfallId && !c.hidden) visible.add(c.scryfallId);
  }
  cards.ensure(visible);

  // Drop from the selection anything that's no longer your battlefield card.
  let selChanged = false;
  for (const id of [...selection]) {
    const c = state.cards[id];
    if (!c || c.zone !== Zone.Battlefield || c.controllerId !== you) {
      selection.delete(id);
      selChanged = true;
    }
  }

  board.update(state, you);
  if (selChanged) board.setSelection(selection);
  status.setTurn(state);
  phases.update(state);

  // Stream new game-log entries into chat as system messages.
  for (const entry of state.log) {
    if (entry.seq > lastLogSeq) chat?.system(entry.text);
  }
  lastLogSeq = Math.max(lastLogSeq, ...state.log.map((e) => e.seq), 0);

  // Re-focus the camera when the active player changes (respects cooldown).
  const active = state.turn.activePlayerId;
  if (active && active !== lastActive) {
    const f = board.frameFor(active);
    if (f) cameraCtl.focusSeat(f);
    lastActive = active;
  }
}

// --- picking, dragging, and the detail panel --------------------------------
const raycaster = new Raycaster();
const ndc = new Vector2();
const tablePlane = new Plane(new Vector3(0, 1, 0), 0);
const planeHit = new Vector3();

let drag:
  | { ids: string[]; moved: boolean; fromHand: boolean; start: Map<string, { x: number; z: number }>; px: number; pz: number }
  | null = null;
let downX = 0;
let downY = 0;
let downCardId: string | null = null;
let downZone: { playerId: string; zone: Zone } | null = null;
let lastSent = 0;
let lastTapId: string | null = null;
let lastTapAt = 0;
let rightDownX = 0;
let rightDownY = 0;
let rightCardId: string | null = null;

// Right-click inspects a card; suppress the browser context menu on the board.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

function setNdc(e: PointerEvent) {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
}
function pickCardId(e: PointerEvent): string | null {
  setNdc(e);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(board.pickables(), false)[0];
  return hit ? ((hit.object.userData.instanceId as string) ?? null) : null;
}
function pointerOnTable(e: PointerEvent): Vector3 | null {
  setNdc(e);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(tablePlane, planeHit) ? planeHit.clone() : null;
}
/** World point → normalized battlefield (x,y) for the local seat. */
function bfCoords(wx: number, wz: number): { x: number; y: number } | null {
  const frame = board.frameFor(you);
  if (!frame) return null;
  return worldToBattlefield(frame, new Vector3(wx, 0, wz));
}
function pickZoneAt(e: PointerEvent): { playerId: string; zone: Zone } | null {
  setNdc(e);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(board.zonePads(), false)[0];
  if (!hit) return null;
  const zone = hit.object.userData.zone as Zone | undefined;
  const playerId = hit.object.userData.playerId as string | undefined;
  return zone && playerId ? { playerId, zone } : null;
}
function openDetailFor(id: string) {
  const card = latest?.cards[id];
  if (!card) return;
  const resolved = card.scryfallId ? cards.get(card.scryfallId) : undefined;
  detail.show(card, resolved, card.ownerId === you || card.controllerId === you);
}

function setSelection(ids: Iterable<string>) {
  selection.clear();
  for (const id of ids) selection.add(id);
  board.setSelection(selection);
}

/** Route a tap through double-click detection: a quick second tap on the same
 *  battlefield permanent you control toggles its tapped state (instead of detail). */
function onCardTap(cardId: string, shift: boolean) {
  const now = performance.now();
  const isDouble = !shift && cardId === lastTapId && now - lastTapAt < 300;
  lastTapId = cardId;
  lastTapAt = now;
  const c = latest?.cards[cardId];
  if (isDouble && c && c.zone === Zone.Battlefield && c.controllerId === you) {
    detail.hide();
    net?.send({ type: "set_tapped", instanceId: cardId, tapped: !c.tapped });
    return;
  }
  handleTap(cardId, shift);
}

/** Handle a tap (no drag): shift-click toggles selection; a plain click opens detail. */
function handleTap(cardId: string, shift: boolean) {
  const c = latest?.cards[cardId];
  if (!c) return;
  const selectable = c.zone === Zone.Battlefield && c.controllerId === you;
  if (shift && selectable) {
    if (selection.has(cardId)) selection.delete(cardId);
    else selection.add(cardId);
    board.setSelection(selection);
  } else {
    if (selection.size) setSelection([]);
    openDetailFor(cardId);
  }
}

canvas.addEventListener("pointerdown", (e) => {
  // Right button: remember what was under the cursor (open detail on release if
  // it wasn't a camera-tilt drag). Left-drag with the camera stays untouched.
  if (e.button === 2 && latest) {
    rightDownX = e.clientX;
    rightDownY = e.clientY;
    rightCardId = pickCardId(e);
    return;
  }
  if (e.button !== 0 || !latest) return;
  downX = e.clientX;
  downY = e.clientY;
  const id = pickCardId(e);
  downCardId = id;
  downZone = id ? null : pickZoneAt(e);
  const card = id ? latest.cards[id] : undefined;

  // Draggable: your battlefield permanents (reposition, possibly as a group)
  // and your hand cards (drag onto the table to play). Take the pointer.
  const onBf = card?.zone === Zone.Battlefield && card.controllerId === you;
  const inHand = card?.zone === Zone.Hand && card.ownerId === you;
  if (!card || (!onBf && !inHand)) return;

  // If dragging a selected permanent, move the whole selection together.
  const ids = onBf && selection.has(card.instanceId) ? [...selection] : [card.instanceId];
  const start = new Map<string, { x: number; z: number }>();
  for (const dragId of ids) {
    const wp = board.meshWorldPos(dragId);
    if (wp) start.set(dragId, { x: wp.x, z: wp.z });
  }
  const p0 = pointerOnTable(e);
  drag = { ids, moved: false, fromHand: !!inHand, start, px: p0?.x ?? 0, pz: p0?.z ?? 0 };
  board.setDragging(ids);
  cameraCtl.controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = pointerOnTable(e);
  if (!p) return;
  if (!drag.moved && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) drag.moved = true;
  const dx = p.x - drag.px;
  const dz = p.z - drag.pz;
  // Lift dragged cards above the rest of the table so they read as "picked up".
  for (const [id, s] of drag.start) board.moveMeshLocal(id, { x: s.x + dx, y: 0.5, z: s.z + dz });

  // Stream battlefield repositions live (hand cards commit once on drop).
  const now = performance.now();
  if (drag.moved && !drag.fromHand && now - lastSent > 80) {
    lastSent = now;
    for (const [id, s] of drag.start) {
      const c = bfCoords(s.x + dx, s.z + dz);
      if (c) net?.send({ type: "set_card_position", instanceId: id, x: c.x, y: c.y });
    }
  }
});

canvas.addEventListener("pointerup", (e) => {
  if (e.button === 2) {
    if (rightCardId && Math.hypot(e.clientX - rightDownX, e.clientY - rightDownY) < 5) openDetailFor(rightCardId);
    rightCardId = null;
    return;
  }
  if (drag) {
    cameraCtl.controls.enabled = true;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (drag.moved) {
      const p = pointerOnTable(e);
      const zone = p ? board.zoneHitTest(you, p) : null;
      const dx = p ? p.x - drag.px : 0;
      const dz = p ? p.z - drag.pz : 0;
      for (const [id, s] of drag.start) {
        if (zone) {
          net?.send({ type: "move_card", instanceId: id, toZone: zone });
        } else {
          const c = bfCoords(s.x + dx, s.z + dz);
          if (!c) continue;
          if (drag.fromHand) net?.send({ type: "move_card", instanceId: id, toZone: Zone.Battlefield, x: c.x, y: c.y });
          else net?.send({ type: "set_card_position", instanceId: id, x: c.x, y: c.y });
        }
      }
    } else {
      onCardTap(downCardId ?? drag.ids[0]!, e.shiftKey);
    }
    board.setDragging(null);
    drag = null;
    downCardId = null;
    downZone = null;
    return;
  }
  // Plain click: card → detail/select; zone pad → contents; empty → clear selection.
  const tap = Math.hypot(e.clientX - downX, e.clientY - downY) < 5;
  if (tap && downCardId) onCardTap(downCardId, e.shiftKey);
  else if (tap && downZone) openZoneViewer(downZone.playerId, downZone.zone);
  else if (tap) setSelection([]);
  downCardId = null;
  downZone = null;
});

/** Modal listing the cards in a zone (Library shown as hidden). */
function openZoneViewer(playerId: string, zone: Zone) {
  const player = latest?.players[playerId];
  if (!player) return;
  const idsByZone: Record<string, string[]> = {
    [Zone.Library]: player.library,
    [Zone.Graveyard]: player.graveyard,
    [Zone.Exile]: player.exile,
    [Zone.Command]: player.command,
  };
  const labels: Record<string, string> = {
    [Zone.Library]: "Library",
    [Zone.Graveyard]: "Graveyard",
    [Zone.Exile]: "Exile",
    [Zone.Command]: "Command zone",
  };
  const ids = idsByZone[zone] ?? [];

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const close = () => overlay.remove();
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  const panel = document.createElement("div");
  panel.className = "modal";
  const h = document.createElement("h3");
  h.textContent = `${labels[zone]} — ${player.name} (${ids.length})`;
  panel.appendChild(h);

  const list = document.createElement("div");
  list.className = "modal-list";
  if (zone === Zone.Library) {
    const note = document.createElement("div");
    note.className = "modal-note";
    note.textContent = "Library is hidden.";
    list.appendChild(note);
  } else if (!ids.length) {
    const note = document.createElement("div");
    note.className = "modal-note";
    note.textContent = "Empty.";
    list.appendChild(note);
  } else {
    for (const id of [...ids].reverse()) {
      const c = latest?.cards[id];
      const name = (c && !c.hidden && cards.get(c.scryfallId)?.name) || c?.scryfallId || "card";
      const b = document.createElement("button");
      b.textContent = name;
      b.addEventListener("click", () => {
        close();
        openDetailFor(id);
      });
      list.appendChild(b);
    }
  }
  panel.appendChild(list);
  const cancel = document.createElement("button");
  cancel.textContent = "Close";
  cancel.addEventListener("click", close);
  panel.appendChild(cancel);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

/** Keyboard shortcuts (active in-game, ignored while typing or in a modal). */
function openHelp() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const close = () => overlay.remove();
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  const panel = document.createElement("div");
  panel.className = "modal";
  panel.innerHTML =
    "<h3>Shortcuts &amp; controls</h3>" +
    '<div class="modal-note"><b>D</b> draw · <b>N</b> next phase · <b>E</b> end turn · <b>S</b> shuffle · <b>U</b> untap all · <b>T</b> tap/untap selection · <b>Esc</b> clear · <b>?</b> this help</div>' +
    '<div class="modal-note">Drag your battlefield cards to move them. Drag a hand card onto the table to play it. Drop a card on a zone pad (Library / Graveyard / Exile / Command) to send it there. Shift-click permanents to multi-select, then drag or press T together. Click or right-click a card for a closer look; double-click a permanent to tap/untap it; click a zone pad to view its contents.</div>' +
    '<div class="modal-note">Left-drag pans · right-drag tilts · scroll zooms.</div>';
  const b = document.createElement("button");
  b.className = "primary";
  b.textContent = "Got it";
  b.addEventListener("click", close);
  panel.appendChild(b);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "?") {
    openHelp();
    return;
  }
  if (!net || !latest || latest.status !== "active") return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (document.getElementById("deckbuilder") || document.querySelector(".modal-overlay")) return;
  if (e.key === "Escape") {
    detail.hide();
    if (selection.size) setSelection([]);
    return;
  }
  // T taps/untaps the whole selection (untaps only if all are tapped).
  if (e.key.toLowerCase() === "t" && selection.size) {
    const sel = [...selection].map((id) => latest!.cards[id]).filter(Boolean) as GameState["cards"][string][];
    const target = sel.some((c) => !c.tapped);
    for (const c of sel) net.send({ type: "set_tapped", instanceId: c.instanceId, tapped: target });
    e.preventDefault();
    return;
  }
  let action: Action | null = null;
  switch (e.key.toLowerCase()) {
    case "d":
      action = { type: "draw", playerId: you, count: 1 };
      break;
    case "n":
      action = { type: "advance_phase" };
      break;
    case "e":
      action = { type: "end_turn" };
      break;
    case "s":
      action = { type: "shuffle", playerId: you };
      break;
    case "u":
      action = { type: "untap_all", playerId: you };
      break;
    default:
      return;
  }
  net.send(action);
  e.preventDefault();
});

// --- join flow --------------------------------------------------------------
const join = document.getElementById("join")!;
const joinForm = document.getElementById("join-form") as HTMLFormElement;
const nameInput = document.getElementById("join-name") as HTMLInputElement;
const gameInput = document.getElementById("join-game") as HTMLInputElement;
nameInput.value = getSavedName();
gameInput.value = DEFAULT_GAME_ID;
document.getElementById("join-decks")?.addEventListener("click", () => openDeckbuilder(getUserId()));

/** Modal to load one of your saved decks (or the placeholder test deck) into the game. */
async function openDeckPicker(): Promise<void> {
  if (!net) return;
  const decks = await listDecks(getUserId()).catch(() => [] as SavedDeck[]);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const close = () => overlay.remove();
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });

  const panel = document.createElement("div");
  panel.className = "modal";
  const title = document.createElement("h3");
  title.textContent = "Load a deck";
  panel.appendChild(title);

  const list = document.createElement("div");
  list.className = "modal-list";
  const pick = (commanders: string[], library: string[]) => {
    net?.send({ type: "load_deck", playerId: you, commanders, library });
    close();
  };

  if (!decks.length) {
    const note = document.createElement("div");
    note.className = "modal-note";
    note.textContent = "No saved decks yet — build one with “Decks”, or use the test deck.";
    list.appendChild(note);
  }
  for (const d of decks) {
    const size = d.commanders.length + d.cards.reduce((n, e) => n + e.count, 0);
    const b = document.createElement("button");
    b.textContent = `${d.name} (${size})`;
    b.addEventListener("click", () => {
      const { commanders, library } = toLoadDeck(d);
      pick(commanders, library);
    });
    list.appendChild(b);
  }
  const testBtn = document.createElement("button");
  testBtn.className = "primary";
  testBtn.textContent = "Test deck (placeholder)";
  testBtn.addEventListener("click", () => {
    const d = testDeck(you);
    pick(d.commanders, d.library);
  });
  list.appendChild(testBtn);

  panel.appendChild(list);
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  panel.appendChild(cancel);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim() || "Player";
  const gameId = gameInput.value.trim() || DEFAULT_GAME_ID;
  saveName(name);
  status.setGame(gameId);

  chat = chatPanel((text) => net?.chat(text));
  toolbar((action) => net?.send(action), you, {
    onOpenDecks: () => openDeckbuilder(getUserId()),
    onLoadDeck: () => void openDeckPicker(),
  });
  const keysBtn = document.createElement("button");
  keysBtn.textContent = "Keys";
  keysBtn.title = "Keyboard shortcuts";
  keysBtn.onclick = openHelp;
  document.getElementById("toolbar")?.appendChild(keysBtn);

  net = new Net(
    SERVER_URL,
    { gameId, you, name },
    {
      onSnapshot,
      onStatus: (s) => status.setConn(s),
      onChat: (_from, n, text) => chat?.message(n, text),
      onError: (msg) => chat?.system(`⚠ ${msg}`),
    },
  );
  net.connect();
  join.classList.add("hidden");
});
