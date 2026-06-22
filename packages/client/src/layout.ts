import { Vector3 } from "three";

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
