import type { Action, GameState, PlayerId, ServerToClient } from "@highlander/shared";

export interface NetHandlers {
  onSnapshot?: (state: GameState, you: PlayerId) => void;
  onChat?: (from: PlayerId, name: string, text: string) => void;
  onError?: (message: string) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

/**
 * Thin WebSocket client. Sends `hello` on open, dispatches server messages, and
 * auto-reconnects (the server keeps our seat, so reconnect is just a snapshot).
 * Commands always carry our own identity as `actorId`; the server enforces it.
 */
export class Net {
  private ws?: WebSocket;
  private closedByUser = false;

  constructor(
    private readonly url: string,
    private readonly identity: { gameId: string; you: PlayerId; name: string },
    private readonly handlers: NetHandlers,
  ) {}

  get you(): PlayerId {
    return this.identity.you;
  }

  connect(): void {
    this.handlers.onStatus?.("connecting");
    const ws = new WebSocket(`${this.url}/ws/${encodeURIComponent(this.identity.gameId)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onStatus?.("open");
      this.raw({ t: "hello", gameId: this.identity.gameId, playerId: this.identity.you, name: this.identity.name });
    };
    ws.onmessage = (ev) => this.dispatch(ev.data);
    ws.onclose = () => {
      this.handlers.onStatus?.("closed");
      if (!this.closedByUser) setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  private dispatch(data: unknown): void {
    let msg: ServerToClient;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.t) {
      case "snapshot":
        return this.handlers.onSnapshot?.(msg.state, msg.you);
      case "chat":
        return this.handlers.onChat?.(msg.from, msg.name, msg.text);
      case "error":
        return this.handlers.onError?.(msg.message);
    }
  }

  /** Issue a game command authored by us. */
  send(action: Action): void {
    this.raw({ t: "command", cmd: { action, actorId: this.identity.you } });
  }

  chat(text: string): void {
    this.raw({ t: "chat", text });
  }

  private raw(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
