import { Vector3 } from "three";
import { Zone } from "@highlander/shared";

export const TABLE_RADIUS = 7;
export const CARD_W = 0.72;
export const CARD_H = 1.0;
export const CARD_GAP = 0.12;
const COL_SPACING = CARD_W + CARD_GAP;
const ROW_SPACING = CARD_H + CARD_GAP;

/** A seat's local coordinate frame on the table (y = up everywhere). */
export interface SeatFrame {
  seatIndex: number;
  playerId: string;
  /** Seat anchor on the table edge. */
  pos: Vector3;
  /** Unit vector from the seat toward the table center. */
  toCenter: Vector3;
  /** Unit vector pointing to the seat's right (along its card rows). */
  right: Vector3;
}

/**
 * Place every seat around the table, rotated so the *viewer* sits at the front
 * (nearest the default camera). Turn order is preserved; only the rotation
 * differs per client — exactly like MTG Arena always seating "you" at bottom.
 */
export function seatFrames(seats: string[], viewerId: string): SeatFrame[] {
  const n = Math.max(1, seats.length);
  const viewerIdx = Math.max(0, seats.indexOf(viewerId));
  const up = new Vector3(0, 1, 0);

  return seats.map((playerId, i) => {
    const slot = ((i - viewerIdx) % n + n) % n; // viewer → slot 0 (front)
    const theta = (slot / n) * Math.PI * 2; // 0 = +Z (front, near camera)
    const pos = new Vector3(Math.sin(theta) * TABLE_RADIUS, 0, Math.cos(theta) * TABLE_RADIUS);
    const toCenter = pos.clone().negate().normalize();
    const right = new Vector3().crossVectors(up, toCenter).normalize();
    return { seatIndex: i, playerId, pos, toCenter, right };
  });
}

/**
 * Lay out `count` cards as centered rows starting `baseDist` in front of the
 * seat (along toCenter), advancing toward the center for each new row.
 */
export function gridPositions(
  frame: SeatFrame,
  count: number,
  baseDist: number,
  perRow: number,
): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, count - row * perRow);
    const col = i % perRow;
    const offset = (col - (inRow - 1) / 2) * COL_SPACING;
    const depth = baseDist + row * ROW_SPACING;
    const p = frame.pos
      .clone()
      .addScaledVector(frame.toCenter, depth)
      .addScaledVector(frame.right, offset);
    p.y = 0.02;
    out.push(p);
  }
  return out;
}

/** Yaw (about Y) that makes a card "face" its seat's owner. */
export function seatYaw(frame: SeatFrame): number {
  return Math.atan2(frame.toCenter.x, frame.toCenter.z) + Math.PI;
}

export interface CardPlacement {
  pos: Vector3;
  /** Per-card yaw (about Y), including the fan angle. */
  yaw: number;
}

/**
 * Hand layout: a compact, slightly fanned single row at the seat's edge, so the
 * hand stays out of the play space. Cards overlap and lift slightly front-to-
 * back so the fan reads cleanly from above.
 */
export function fanPositions(frame: SeatFrame, count: number): CardPlacement[] {
  const out: CardPlacement[] = [];
  if (count <= 0) return out;
  const baseYaw = seatYaw(frame);
  const mid = (count - 1) / 2;
  const spacing = Math.min(CARD_W * 0.85, 4.6 / count); // light overlap; cap total width
  const perAngle = count > 1 ? Math.min(0.07, 0.45 / (count - 1)) : 0;
  for (let i = 0; i < count; i++) {
    const off = i - mid;
    const pos = frame.pos
      .clone()
      .addScaledVector(frame.right, off * spacing)
      .addScaledVector(frame.toCenter, 0.18);
    pos.y = 0.08 + i * 0.01; // stack front-to-back so overlaps don't z-fight
    out.push({ pos, yaw: baseYaw + off * perAngle });
  }
  return out;
}

// Per-seat battlefield region, mapping normalized [0..1] positions <-> world.
const BF_NEAR = 1.3;
const BF_WIDTH = 5.2;
const BF_DEPTH = 3.2;

/** Normalized seat-local (x,y) → world point on the table. */
export function battlefieldPoint(frame: SeatFrame, x: number, y: number): Vector3 {
  return frame.pos
    .clone()
    .addScaledVector(frame.toCenter, BF_NEAR + y * BF_DEPTH)
    .addScaledVector(frame.right, (x - 0.5) * BF_WIDTH)
    .setY(0.02);
}

/** World point → normalized seat-local (x,y), clamped to the region. */
export function worldToBattlefield(frame: SeatFrame, world: Vector3): { x: number; y: number } {
  const origin = frame.pos.clone().addScaledVector(frame.toCenter, BF_NEAR);
  const rel = world.clone().sub(origin);
  return {
    x: clamp01(rel.dot(frame.right) / BF_WIDTH + 0.5),
    y: clamp01(rel.dot(frame.toCenter) / BF_DEPTH),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** The non-hand/battlefield zones shown as pads beside each seat, in pad order. */
export const ZONE_LAYOUT: { zone: Zone; label: string }[] = [
  { zone: Zone.Library, label: "Library" },
  { zone: Zone.Graveyard, label: "Graveyard" },
  { zone: Zone.Exile, label: "Exile" },
  { zone: Zone.Command, label: "Command" },
];

/** World position of zone pad `i` (a 2x2 cluster to the seat's right). */
export function zoneAnchor(frame: SeatFrame, i: number): Vector3 {
  const col = i % 2;
  const row = Math.floor(i / 2);
  return frame.pos
    .clone()
    .addScaledVector(frame.right, 2.9 + col * 0.95)
    .addScaledVector(frame.toCenter, 0.35 + row * 1.2)
    .setY(0.01);
}

/** Hit-test a world point against this seat's zone pads (for drag-to-zone). */
export function zoneAt(frame: SeatFrame, point: { x: number; z: number }, radius = 0.55): Zone | null {
  for (let i = 0; i < ZONE_LAYOUT.length; i++) {
    const a = zoneAnchor(frame, i);
    if (Math.hypot(point.x - a.x, point.z - a.z) < radius) return ZONE_LAYOUT[i]!.zone;
  }
  return null;
}
