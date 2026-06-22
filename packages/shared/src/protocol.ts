import type { GameCommand } from "./actions.js";
import type { GameId, GameState, PlayerId } from "./types.js";

/**
 * The wire protocol between client and server. Kept deliberately small.
 *
 * Sync model (v1, correctness-first):
 *   1. Client sends `hello` to identify/reconnect.
 *   2. Client sends `command`s. The server is authoritative: it validates and
 *      applies each via the shared reducer, then broadcasts a fresh *redacted*
 *      `snapshot` to every player.
 *   3. On reconnect the server just sends the current snapshot — no replay
 *      needed by the client.
 *
 * This trades bandwidth (full redacted snapshot per move) for simplicity and
 * guaranteed consistency. A later optimization is to broadcast applied commands
 * + version and let clients run the same reducer locally (they already import
 * it), falling back to snapshots only on version gaps.
 */

export interface HelloMessage {
  t: "hello";
  gameId: GameId;
  playerId: PlayerId;
  name: string;
  /** Seat to claim when joining a fresh game; ignored on reconnect. */
  seat?: number;
}

export interface CommandMessage {
  t: "command";
  cmd: GameCommand;
}

export interface ChatMessage {
  t: "chat";
  text: string;
}

export type ClientToServer = HelloMessage | CommandMessage | ChatMessage;

export interface SnapshotMessage {
  t: "snapshot";
  you: PlayerId;
  /** A view redacted for `you` — never contains hidden card faces. */
  state: GameState;
}

export interface ErrorMessage {
  t: "error";
  message: string;
  /** Echo of the rejected command's clientSeq, if any. */
  clientSeq?: number;
}

export interface ChatBroadcast {
  t: "chat";
  from: PlayerId;
  name: string;
  text: string;
}

export type ServerToClient = SnapshotMessage | ErrorMessage | ChatBroadcast;
