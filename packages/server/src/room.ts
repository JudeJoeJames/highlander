import {
  ClientToServer,
  GameCommand,
  GameState,
  IllegalActionError,
  PlayerId,
  ServerToClient,
  createGame,
  reduce,
  viewFor,
} from "@highlander/shared";

/** A connected socket. We only need send + the player it's bound to. */
export interface Connection {
  playerId: PlayerId | null;
  send(msg: ServerToClient): void;
}

/**
 * One game room = one authoritative GameState + the set of connected sockets.
 * The room is the only writer of its state; all mutation flows through `reduce`.
 */
export class GameRoom {
  private state: GameState;
  private readonly connections = new Set<Connection>();

  constructor(id: string, seed: number) {
    this.state = createGame(id, seed);
  }

  get id(): string {
    return this.state.id;
  }

  get empty(): boolean {
    return this.connections.size === 0;
  }

  attach(conn: Connection): void {
    this.connections.add(conn);
  }

  detach(conn: Connection): void {
    this.connections.delete(conn);
    if (conn.playerId && this.state.players[conn.playerId]) {
      // Mark disconnected but keep the seat/state for reconnection.
      this.state = reduce(this.state, {
        actorId: conn.playerId,
        action: { type: "set_connected", playerId: conn.playerId, connected: false },
      });
      this.broadcastSnapshots();
    }
  }

  handle(conn: Connection, msg: ClientToServer): void {
    switch (msg.t) {
      case "hello":
        return this.onHello(conn, msg.playerId, msg.name, msg.seat);
      case "command":
        return this.onCommand(conn, msg.cmd);
      case "chat":
        return this.onChat(conn, msg.text);
    }
  }

  private onHello(conn: Connection, playerId: PlayerId, name: string, seat?: number): void {
    conn.playerId = playerId;
    // Join (or reconnect) only if not already seated, and the game has room.
    if (!this.state.players[playerId]) {
      const claimSeat = seat ?? this.firstFreeSeat();
      this.tryApply(conn, { actorId: playerId, action: { type: "join", playerId, name, seat: claimSeat } });
    } else {
      this.tryApply(conn, { actorId: playerId, action: { type: "join", playerId, name, seat: this.state.players[playerId]!.seat } });
    }
    // Always hand the (re)connecting client a fresh snapshot.
    conn.send({ t: "snapshot", you: playerId, state: viewFor(this.state, playerId) });
  }

  private onCommand(conn: Connection, cmd: GameCommand): void {
    if (!conn.playerId) return conn.send({ t: "error", message: "Say hello first." });
    // The server trusts the connection's identity, not the client-claimed actor.
    if (cmd.actorId !== conn.playerId) {
      return conn.send({ t: "error", message: "actorId does not match your identity.", clientSeq: cmd.clientSeq });
    }
    this.tryApply(conn, cmd);
  }

  private onChat(conn: Connection, text: string): void {
    if (!conn.playerId) return;
    const name = this.state.players[conn.playerId]?.name ?? "?";
    const out: ServerToClient = { t: "chat", from: conn.playerId, name, text };
    for (const c of this.connections) c.send(out);
  }

  /** Apply a command, broadcasting on success, replying with an error on failure. */
  private tryApply(conn: Connection, cmd: GameCommand): void {
    try {
      this.state = reduce(this.state, cmd);
    } catch (err) {
      const message = err instanceof IllegalActionError ? err.message : "Internal error applying command.";
      if (!(err instanceof IllegalActionError)) console.error("reduce failed:", err);
      return conn.send({ t: "error", message, clientSeq: cmd.clientSeq });
    }
    this.broadcastSnapshots();
  }

  /** Each connected player gets a snapshot redacted for their eyes only. */
  private broadcastSnapshots(): void {
    for (const c of this.connections) {
      if (!c.playerId) continue;
      c.send({ t: "snapshot", you: c.playerId, state: viewFor(this.state, c.playerId) });
    }
  }

  private firstFreeSeat(): number {
    const taken = new Set(Object.values(this.state.players).map((p) => p.seat));
    for (let i = 0; i < 4; i++) if (!taken.has(i)) return i;
    return 0;
  }
}
