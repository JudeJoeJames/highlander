import {
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  type Scene,
} from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  Zone,
  type CardInstance,
  type GameState,
  type PlayerId,
  type PlayerState,
} from "@highlander/shared";
import { battlefieldPoint, CARD_H, CARD_W, fanPositions, gridPositions, seatFrames, seatYaw, type SeatFrame } from "./layout";
import { backTexture, imageCardTexture, placeholderTexture } from "./textures";
import type { CardLibrary } from "./cards";

interface CardObject {
  group: Object3D; // holds position + tap yaw
  mesh: Mesh; // the card face; carries userData.instanceId for picking
  faceYaw: number;
}

const CARD_GEO = new PlaneGeometry(CARD_W, CARD_H);

/**
 * Owns all visual objects and reconciles them against each snapshot. Cards are
 * keyed by instanceId so positions/tap/counters update in place; objects that
 * vanish from state are removed. Nameplates are CSS2D labels anchored per seat.
 */
export class Board {
  private readonly cards = new Map<string, CardObject>();
  private readonly nameplates = new Map<string, { obj: CSS2DObject; el: HTMLDivElement }>();
  private frames: SeatFrame[] = [];
  /** While set, this card is being dragged locally and is not re-laid by update(). */
  private draggingId: string | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly library: CardLibrary,
  ) {}

  /** Current seat frames (used by the camera to focus a seat). */
  frameFor(playerId: PlayerId): SeatFrame | undefined {
    return this.frames.find((f) => f.playerId === playerId);
  }

  /** Meshes eligible for raycasting (card faces). */
  pickables(): Mesh[] {
    return [...this.cards.values()].map((c) => c.mesh);
  }

  update(state: GameState, you: PlayerId): void {
    this.frames = seatFrames(state.seats, you);
    const live = new Set<string>();

    for (const frame of this.frames) {
      const player = state.players[frame.playerId];
      if (!player) continue;
      this.layoutSeat(state, frame, player, live);
      this.updateNameplate(state, frame, player, you);
    }

    // Remove cards no longer present (moved to hidden zones, etc.).
    for (const [id, obj] of this.cards) {
      if (!live.has(id)) {
        this.scene.remove(obj.group);
        this.cards.delete(id);
      }
    }
  }

  private layoutSeat(state: GameState, frame: SeatFrame, player: PlayerState, live: Set<string>): void {
    const yaw = seatYaw(frame);

    // Hand: fanned single line at the seat's outer edge.
    const hand = player.hand.map((id) => state.cards[id]).filter(Boolean) as CardInstance[];
    const fan = fanPositions(frame, hand.length);
    hand.forEach((card, i) => {
      if (card.instanceId === this.draggingId) {
        live.add(card.instanceId); // being dragged out of hand; leave its slot
        return;
      }
      this.placeCard(card, fan[i]!.pos, fan[i]!.yaw, live);
    });

    // Battlefield: cards this player controls. Honor a dragged position (x/y),
    // otherwise auto-arrange in a grid.
    const bf = state.battlefield
      .map((id) => state.cards[id])
      .filter((c): c is CardInstance => !!c && c.controllerId === player.id);
    const grid = gridPositions(frame, bf.length, 1.6, 7);
    bf.forEach((card, i) => {
      if (card.instanceId === this.draggingId) {
        live.add(card.instanceId); // keep it; its mesh is positioned by the drag
        return;
      }
      const pos = card.x !== undefined && card.y !== undefined ? battlefieldPoint(frame, card.x, card.y) : grid[i]!;
      this.placeCard(card, pos, yaw, live);
    });
  }

  /** Mark a card as actively dragged (skipped by update so it doesn't snap back). */
  setDragging(id: string | null): void {
    this.draggingId = id;
  }

  /** Immediately move a card's mesh to a world position (used during dragging). */
  moveMeshLocal(id: string, p: { x: number; y: number; z: number }): void {
    const obj = this.cards.get(id);
    if (obj) obj.group.position.set(p.x, p.y, p.z);
  }

  private placeCard(card: CardInstance, pos: { x: number; y: number; z: number }, yaw: number, live: Set<string>): void {
    live.add(card.instanceId);
    let obj = this.cards.get(card.instanceId);
    if (!obj) {
      const mesh = new Mesh(CARD_GEO, new MeshStandardMaterial({ side: DoubleSide }));
      mesh.rotation.x = -Math.PI / 2; // lie flat on the table
      mesh.userData.instanceId = card.instanceId;
      const group = new Object3D();
      group.add(mesh);
      this.scene.add(group);
      obj = { group, mesh, faceYaw: yaw };
      this.cards.set(card.instanceId, obj);
    }

    obj.group.position.set(pos.x, pos.y, pos.z);
    // Tapped cards rotate 90° in the table plane.
    obj.group.rotation.y = yaw + (card.tapped ? Math.PI / 2 : 0);

    const mat = obj.mesh.material as MeshStandardMaterial;
    mat.map = this.faceTexture(card);
    mat.needsUpdate = true;
  }

  private faceTexture(card: CardInstance) {
    if (card.hidden) return backTexture();
    const img = this.library.image(card.scryfallId);
    if (img) return imageCardTexture(img, card.counters);
    // Not loaded yet: show a labeled placeholder (resolved name if we have it).
    const name = this.library.get(card.scryfallId)?.name ?? card.scryfallId;
    return placeholderTexture(name, card.counters);
  }

  private updateNameplate(state: GameState, frame: SeatFrame, player: PlayerState, you: PlayerId): void {
    let entry = this.nameplates.get(frame.playerId);
    if (!entry) {
      const el = document.createElement("div");
      el.className = "nameplate";
      const obj = new CSS2DObject(el);
      const anchor = new Object3D();
      anchor.position.copy(frame.pos).addScaledVector(frame.toCenter, -0.6);
      anchor.position.y = 0.4;
      anchor.add(obj);
      this.scene.add(anchor);
      entry = { obj, el };
      this.nameplates.set(frame.playerId, entry);
    }

    const active = state.turn.activePlayerId === player.id;
    entry.el.className =
      "nameplate" +
      (active ? " active" : "") +
      (player.id === you ? " you" : "") +
      (player.connected ? "" : " disconnected");

    const mana = Object.entries(player.manaPool)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${v}${k}`)
      .join(" ");

    entry.el.innerHTML = `
      <div class="name">${escapeHtml(player.name)}</div>
      <div class="life">♥ ${player.life}</div>
      <div class="zones">H ${player.hand.length} · L ${player.library.length} · G ${player.graveyard.length} · E ${player.exile.length} · C ${player.command.length}</div>
      ${mana ? `<div class="mana">${escapeHtml(mana)}</div>` : ""}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
