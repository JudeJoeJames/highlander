import { Plane, Raycaster, Vector2, Vector3 } from "three";
import { Zone, toLoadDeck, type GameState, type PlayerId, type SavedDeck } from "@highlander/shared";
import { DEFAULT_GAME_ID, getPlayerId, getSavedName, getUserId, saveName, SERVER_URL } from "./config";
import { Net } from "./net";
import { createScene } from "./scene";
import { CameraController } from "./camera";
import { Board } from "./board";
import { CardLibrary } from "./cards";
import { worldToBattlefield } from "./layout";
import { cardDetail, chatPanel, statusBar, toolbar } from "./ui";
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
const board = new Board(scene, cards);
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
const detail = cardDetail((action) => net?.send(action));
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

  board.update(state, you);
  status.setTurn(state);

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

let drag: { id: string; moved: boolean; fromHand: boolean } | null = null;
let downX = 0;
let downY = 0;
let downCardId: string | null = null;
let lastSent = 0;

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
function openDetailFor(id: string) {
  const card = latest?.cards[id];
  if (!card) return;
  const resolved = card.scryfallId ? cards.get(card.scryfallId) : undefined;
  detail.show(card, resolved, card.ownerId === you || card.controllerId === you);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !latest) return;
  downX = e.clientX;
  downY = e.clientY;
  const id = pickCardId(e);
  downCardId = id;
  const card = id ? latest.cards[id] : undefined;
  // Draggable: your battlefield permanents (reposition) and your hand cards
  // (drag onto the table to play them). Take the pointer from the camera.
  const onBf = card?.zone === Zone.Battlefield && card.controllerId === you;
  const inHand = card?.zone === Zone.Hand && card.ownerId === you;
  if (card && (onBf || inHand)) {
    drag = { id: card.instanceId, moved: false, fromHand: !!inHand };
    board.setDragging(card.instanceId);
    cameraCtl.controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = pointerOnTable(e);
  if (!p) return;
  if (!drag.moved && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) drag.moved = true;
  board.moveMeshLocal(drag.id, { x: p.x, y: 0.06, z: p.z });
  // Stream position only for battlefield repositions; a hand card isn't on the
  // battlefield yet, so it just commits once on drop.
  const now = performance.now();
  if (drag.moved && !drag.fromHand && now - lastSent > 80) {
    lastSent = now;
    const frame = board.frameFor(you);
    if (frame) {
      const { x, y } = worldToBattlefield(frame, p);
      net?.send({ type: "set_card_position", instanceId: drag.id, x, y });
    }
  }
});

canvas.addEventListener("pointerup", (e) => {
  if (drag) {
    cameraCtl.controls.enabled = true;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (drag.moved) {
      const p = pointerOnTable(e);
      const frame = board.frameFor(you);
      if (p && frame) {
        const { x, y } = worldToBattlefield(frame, p);
        // From hand: play it onto the battlefield where it was dropped.
        // From battlefield: just reposition.
        if (drag.fromHand) net?.send({ type: "move_card", instanceId: drag.id, toZone: Zone.Battlefield, x, y });
        else net?.send({ type: "set_card_position", instanceId: drag.id, x, y });
      }
    } else {
      openDetailFor(drag.id); // a click, not a drag
    }
    board.setDragging(null);
    drag = null;
    downCardId = null;
    return;
  }
  // Plain click on a (non-draggable) card → show its detail.
  if (downCardId && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) openDetailFor(downCardId);
  downCardId = null;
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
