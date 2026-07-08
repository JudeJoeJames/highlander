import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientToServer, ServerToClient } from "@highlander/shared";
import { GameRoom } from "./room.js";
import { CardCache } from "./cards.js";
import { searchCards } from "./search.js";
import { DeckStore } from "./decks.js";

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
const deckStore = new DeckStore(normalize(join(fileURLToPath(import.meta.url), "..", "..", "data", "decks.json")));
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * JSON API:
 *   POST   /api/cards            { identifiers } -> resolved card data
 *   GET    /api/search?q=&page=  -> Scryfall search results
 *   GET    /api/decks?owner=     -> decks owned by `owner`
 *   POST   /api/decks            SavedDeck (with ownerId) -> upserted deck
 *   DELETE /api/decks/:id?owner= -> { ok }
 */
async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "POST" && path === "/api/cards") {
      const parsed = JSON.parse(await readBody(req)) as { identifiers?: unknown };
      const identifiers = Array.isArray(parsed.identifiers)
        ? parsed.identifiers.filter((x): x is string => typeof x === "string").slice(0, 1000)
        : [];
      return sendJson(res, 200, { cards: await cardCache.resolve(identifiers) });
    }

    if (req.method === "GET" && path === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      if (!q) return sendJson(res, 200, { cards: [], hasMore: false, total: 0 });
      return sendJson(res, 200, await searchCards(q, page));
    }

    if (path === "/api/decks") {
      if (req.method === "GET") {
        return sendJson(res, 200, { decks: deckStore.list(url.searchParams.get("owner") ?? "") });
      }
      if (req.method === "POST") {
        const deck = await deckStore.upsert(JSON.parse(await readBody(req)), Date.now());
        return sendJson(res, 200, { deck });
      }
    }

    if (req.method === "DELETE" && path.startsWith("/api/decks/")) {
      const id = decodeURIComponent(path.slice("/api/decks/".length));
      const ok = await deckStore.remove(id, url.searchParams.get("owner") ?? "");
      return sendJson(res, ok ? 200 : 404, { ok });
    }
  } catch (err) {
    console.error("API error:", err);
    return sendJson(res, 400, { error: err instanceof Error ? err.message : "bad request" });
  }
  sendJson(res, 404, { error: "not found" });
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

http.listen(PORT, "0.0.0.0", () => {
  console.log(`Highlander server listening on http://0.0.0.0:${PORT}`);
  console.log(serveClient ? `Serving client from ${CLIENT_DIST}` : "Client build not found — run the Vite dev server, or `npm start` to build it.");
  console.log(`WebSocket: ws://localhost:${PORT}/ws/<gameId>`);
});
