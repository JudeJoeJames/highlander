import { CardInstance, GameState, PlayerId, Zone } from "./types.js";

/**
 * Hidden information is the crux of any card game's networking. The server
 * holds the full canonical GameState; it must NEVER ship cards a player isn't
 * allowed to see, because a cheating client could read them off the wire.
 *
 * `viewFor` returns a redacted copy: cards the viewer may not see are masked
 * (their `scryfallId` blanked and `hidden: true`). Order/identity of the
 * opaque instance ids is preserved so the UI can still render face-down backs
 * in the right places, but no card faces leak.
 *
 * Visibility rules (manual Commander, friendly play):
 *   - Library:   hidden from everyone, including its owner.
 *   - Hand:      visible to its owner only.
 *   - Face-down: visible to its controller only.
 *   - Everything else (battlefield face-up, graveyard, exile, command, stack)
 *     is public.
 */
export function viewFor(state: GameState, viewerId: PlayerId): GameState {
  const view: GameState = structuredClone(state);
  for (const id of Object.keys(view.cards)) {
    const c = view.cards[id]!;
    if (!isVisibleTo(c, viewerId)) view.cards[id] = mask(c);
  }
  return view;
}

function isVisibleTo(c: CardInstance, viewerId: PlayerId): boolean {
  switch (c.zone) {
    case Zone.Library:
      return false;
    case Zone.Hand:
      return c.ownerId === viewerId;
    case Zone.Battlefield:
    case Zone.Stack:
      // Face-down permanents/objects are visible only to their controller.
      return !c.faceDown || c.controllerId === viewerId;
    case Zone.Graveyard:
    case Zone.Exile:
    case Zone.Command:
      return true;
  }
}

/** Replace identity-revealing fields, keep positional/structural ones. */
function mask(c: CardInstance): CardInstance {
  return {
    instanceId: c.instanceId,
    scryfallId: "",
    ownerId: c.ownerId,
    controllerId: c.controllerId,
    zone: c.zone,
    tapped: c.tapped,
    flipped: false,
    faceDown: c.faceDown,
    counters: c.zone === Zone.Battlefield ? c.counters : {},
    ...(c.x !== undefined ? { x: c.x } : {}),
    ...(c.y !== undefined ? { y: c.y } : {}),
    hidden: true,
  };
}
