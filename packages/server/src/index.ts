import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientToServer, ServerToClient } from "@highlander/shared";
import { GameRoom } from "./room.js";
import { CardCache } from "./cards.js";

/**
 * WebSocket game server. URL carries the game id: ws://host/ws/<gameId>.
 * Rooms are created lazily and dropped when the last socket leaves.
 *
 * It ALSO serves the built client (packages/client/dist) as static files when
 * that folder exists, so production runs as a single process on a single port:
 * HTTP for the app, `/ws/<gameId>` for play. In dev, Vite serves the client and
 * proxies `/ws` here, so this static serving is simply inactive.
 *
 * Not yet here (next milestones): magic-link auth, persistence, lobby/listing
 * REST, command rate-limiting — all bolt on without touching the game model.
 */

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, GameRoom>();
const cardCache = new CardCache();
let seedCounter = 0x9e3779b9; // arbitrary; per-room seeds derive deterministically

// Resolve the client build relative to this file (packages/server/src).
const CLIENT_DIST = normalize(join(fileURLToPath(import.meta.url), "..", "..", "..", "client", "dist"));
const serveClient = existsSync(join(CLIENT_DIST, "index.html"));

function roomFor(gameId: string): GameRoom {
  let room = rooms.get(gameId);
  if (!room) {
    seedCounter = (seedCounter + 0x6d2b79f5) >>> 0;
    room = new GameRoom(gameId, seedCounter);
    rooms.set(gameId, room);
  }
  return room;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  const requested = normalize(join(CLIENT_DIST, urlPath === "/" ? "index.html" : urlPath));

  // Guard against path traversal outside the dist root.
  if (requested !== CLIENT_DIST && !requested.startsWith(CLIENT_DIST + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(requested);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": MIME[extname(requested)] ?? "application/octet-stream" });
    res.end(await readFile(requested));
  } catch {
    // SPA fallback: unknown routes return index.html.
    try {
      res.writeHead(200, { "content-type": MIME[".html"]! });
      res.end(await readFile(join(CLIENT_DIST, "index.html")));
    } catch {
      res.writeHead(404).end("Not found");
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(); // guard against oversized bodies
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Card-resolution API: POST /api/cards { identifiers: string[] }. */
async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "POST" && path === "/api/cards") {
    let identifiers: string[] = [];
    try {
      const parsed = JSON.parse(await readBody(req)) as { identifiers?: unknown };
      if (Array.isArray(parsed.identifiers)) {
        identifiers = parsed.identifiers.filter((x): x is string => typeof x === "string").slice(0, 1000);
      }
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad request" }));
      return;
    }
    const cards = await cardCache.resolve(identifiers);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ cards }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}

const http = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/api/")) {
    void handleApi(req, res);
    return;
  }
  if (serveClient && req.method === "GET") {
    void serveStatic(req, res);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Highlander game server. Connect via WebSocket at /ws/<gameId>.\n");
});

const wss = new WebSocketServer({ server: http });

wss.on("connection", (ws: WebSocket, req) => {
  const match = /\/ws\/([^/?#]+)/.exec(req.url ?? "");
  if (!match) {
    ws.close(1008, "Expected /ws/<gameId>");
    return;
  }
  const gameId = decodeURIComponent(match[1]!);
  const room = roomFor(gameId);

  const conn = {
    playerId: null as string | null,
    send(msg: ServerToClient) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  room.attach(conn);

  ws.on("message", (data) => {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return conn.send({ t: "error", message: "Malformed JSON." });
    }
    try {
      room.handle(conn, msg);
    } catch (err) {
      console.error("handler error:", err);
      conn.send({ t: "error", message: "Server error." });
    }
  });

  ws.on("close", () => {
    room.detach(conn);
    if (room.empty) rooms.delete(gameId);
  });
});

http.listen(PORT, () => {
  console.log(`Highlander server listening on http://localhost:${PORT}`);
  console.log(serveClient ? `Serving client from ${CLIENT_DIST}` : "Client build not found — run the Vite dev server, or `npm start` to build it.");
  console.log(`WebSocket: ws://localhost:${PORT}/ws/<gameId>`);
});
