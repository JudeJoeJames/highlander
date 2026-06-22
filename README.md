# Highlander

Web-based multiplayer **Magic: the Gathering — Commander/EDH** for 2–4 players.
Plays on phone or desktop. Cards come from the [Scryfall API](https://scryfall.com/docs/api).

## Approach to MTG's rules

We do **not** build a full rules engine (the layer system, replacement effects,
the stack, and per-card scripting are a multi-year effort and Commander is the
worst possible card pool to start with). Instead:

1. **Manual-first** — the game faithfully tracks *where every object is* and
   *what state it carries*, but players move cards / tap / adjust life
   themselves, Cockatrice / Tabletop-Simulator style. **Every Scryfall card
   works on day one** because no move requires understanding card text.
2. **Card-agnostic bookkeeping automation** layered on top (untap step, draw,
   deterministic shuffles, turn/phase tracking) — universal conveniences that
   need no per-card logic.
3. **Optional Claude rules *assist*** later (an in-chat judge / oracle-text
   hints), never as the authoritative engine.

See the conversation/design doc for the full rationale.

## Architecture

```
packages/
  shared/   # The backbone: pure, serializable game-state model + reducer.
            #   types.ts      GameState, PlayerState, CardInstance, zones, phases
            #   actions.ts    the manual-move vocabulary (card-agnostic)
            #   reducer.ts    reduce(state, command) — the ONLY state transition
            #   redaction.ts  viewFor(state, player) — hides libraries/hands/face-down
            #   rng.ts        deterministic, seeded RNG (no Math.random)
            #   protocol.ts   client <-> server wire messages
  server/   # Authoritative WebSocket server. One GameRoom per game id.
            #   imports the SAME reducer; clients are never trusted.
  client/   # Vite + Three.js board. Imports shared for types + protocol.
            #   net.ts      WebSocket client (hello / command / snapshot)
            #   scene.ts    renderer, lights, table, CSS2D label layer
            #   camera.ts   focus-on-active-player + manual-pan cooldown
            #   board.ts    diffs snapshots → card meshes + seat nameplates
            #   ui.ts       toolbar, chat, per-card action menu, status bar
```

### Key design decisions

- **One pure reducer, shared by client and server.** `reduce(state, command)`
  returns a new state and never mutates its input. The server is authoritative;
  because the client imports the identical reducer it can later predict
  optimistically and reconcile.
- **Deterministic everything.** Randomness lives in `state.rngSeed` (advanced by
  the reducer), and instance ids come from `state.nextInstanceSeq`. A command
  stream replays to a byte-identical state anywhere — which is what makes sync,
  reconnection, and testing simple. (`Date.now()`/`Math.random()` are banned in
  the model for this reason.)
- **Hidden information is server-side.** The server holds full state and sends
  each player a `viewFor(...)` redaction; opponents' libraries/hands/face-down
  cards are masked (`hidden: true`, blank `scryfallId`) so faces never hit the
  wire. Opaque instance ids and positions are preserved so the UI can still draw
  card backs in the right place.
- **Sync model v1 = correctness first.** Server applies each command then
  broadcasts a fresh redacted snapshot to every player; reconnect is just a
  snapshot. Optimization (broadcast applied command + version, clients re-run
  the reducer, snapshot only on gaps) is a later, non-breaking change.
- **Cards reference Scryfall, not copies.** A `CardInstance` stores a
  `scryfallId`; the client resolves image + oracle text. Card data is never
  duplicated into game state.

## Running

> Note: on this machine Node is at `/opt/homebrew/bin` and may not be on `PATH`.
> Prefix commands with `export PATH="/opt/homebrew/bin:$PATH"` if `node` isn't found.

```bash
npm install
npm run typecheck   # tsc -b across packages
npm test            # shared/ reducer + redaction tests (node:test)

# Production / one-process: build the client and serve it + the WebSocket
# from a single Node process on http://localhost:8787
npm start
```

### Dev with hot-reload (two processes)

For iterating on the client, run Vite (fast HMR) alongside the game server.
The client connects same-origin and Vite proxies the WebSocket to the server,
so no ports are hardcoded:

```bash
npm run dev:server  # game server on :8787 (HTTP + /ws/<gameId>)
npm run dev:client  # Vite dev server on :5173, proxies /ws -> :8787
```

For `npm start`, open http://localhost:8787 in **two browser tabs** (for the
dev setup use http://localhost:5173 instead) — or two devices,
enter a name + the same Table ID in each, and you're seated at the same game.
Use **Load deck** → **Start** in one tab, then play cards (click a card for its
action menu), draw, adjust life, and pass turns — everything syncs live, with
opponents' hands/libraries shown as face-down backs. The camera auto-focuses the
active player but yields to you for ~6s after you pan/zoom.

> If the client can't reach the server, pass `?server=ws://localhost:8787` (and
> optionally `?game=my-table`) in the client URL.

## Roadmap (next milestones)

- [x] **Client board**: Three.js 4-seat layout (responsive desktop/mobile),
      redacted-snapshot rendering, camera focus-on-active-turn with a
      post-manual-move cooldown, per-card action menu, chat + game log.
- [x] **Real cards**: server-side Scryfall resolver + cache (`/api/cards`,
      batched ≤75, throttled), client `CardLibrary` that lazily loads images and
      re-lays the board as faces arrive; placeholder face while loading.
- [ ] **Deckbuilder**: Scryfall search, Commander-legality validation, deck save.
- [ ] **Auth & profiles**: magic-link login, win/loss history.
- [ ] **Lobby**: public game list + shareable join links (REST alongside the WS).
- [ ] **Chat**: already in the protocol; surface it in the client.
- [ ] **Bookkeeping assists**: stack helpers, trigger reminders from oracle text.
- [ ] **Persistence**: snapshot/restore rooms; command-log storage.
