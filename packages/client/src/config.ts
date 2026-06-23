import type { PlayerId } from "@highlander/shared";

const params = new URLSearchParams(location.search);

/**
 * WebSocket base. By default we connect to the same origin the page was served
 * from — so it "just works" whether the game server serves the built client
 * directly (prod, one process) or Vite serves it and proxies `/ws` to the game
 * server (dev). Override with ?server=ws://host:port when pointing elsewhere.
 */
function defaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}
export const SERVER_URL = params.get("server") ?? defaultWsUrl();

/** Table id, overridable via ?game=<id>; also prefilled in the join form. */
export const DEFAULT_GAME_ID = params.get("game") ?? "table-1";

/**
 * A per-tab player identity. We use sessionStorage (NOT localStorage) on
 * purpose: localStorage is shared across every tab in a browser, so two tabs
 * would collide on one identity and the server would treat the second as a
 * reconnect of the first. sessionStorage is scoped to the tab, so each
 * tab/window is a distinct player, while a reload of the same tab keeps its
 * identity (reconnect still reclaims the seat).
 *
 * Override with ?player=<id> to pin an identity explicitly (handy for testing
 * or sharing a specific seat). Real cross-device identity arrives with
 * magic-link auth later.
 */
export function getPlayerId(): PlayerId {
  const override = params.get("player");
  if (override) return override;

  let id = sessionStorage.getItem("hl-playerId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("hl-playerId", id);
  }
  return id;
}

/**
 * A stable per-browser user key for *deck ownership* — distinct from the
 * per-tab game identity above. Decks should persist across sessions and tabs
 * (unlike a game seat), so this lives in localStorage. When magic-link auth
 * lands, both collapse into the real account id.
 */
export function getUserId(): string {
  const override = params.get("user");
  if (override) return override;
  let id = localStorage.getItem("hl-userId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("hl-userId", id);
  }
  return id;
}

/** Name is per-tab too, so two tabs don't inherit one another's display name. */
export function getSavedName(): string {
  return sessionStorage.getItem("hl-name") ?? "";
}

export function saveName(name: string): void {
  sessionStorage.setItem("hl-name", name);
}
