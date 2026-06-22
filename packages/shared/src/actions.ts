import type { InstanceId, ManaColor, Phase, PlayerId, ScryfallId, Zone } from "./types.js";

/**
 * The complete vocabulary of game moves. These are intentionally low-level and
 * card-agnostic — none of them require understanding any card's text. That is
 * what lets us support the entire Scryfall card pool on day one.
 *
 * Every command is wrapped in a `GameCommand` carrying `actorId` (who issued
 * it) for permission checks and the log. The reducer never trusts the client
 * beyond what `actorId` is allowed to do.
 */
export type Action =
  // --- Lobby / setup ---------------------------------------------------------
  | { type: "join"; playerId: PlayerId; name: string; seat: number }
  | { type: "leave"; playerId: PlayerId }
  | { type: "set_connected"; playerId: PlayerId; connected: boolean }
  | {
      type: "load_deck";
      playerId: PlayerId;
      /** Commander(s) → command zone (supports partners). */
      commanders: ScryfallId[];
      /** The 99 (or 98) → library, in list order before shuffling. */
      library: ScryfallId[];
    }
  | { type: "start_game"; startingLife?: number; openingHand?: number }

  // --- Player totals ---------------------------------------------------------
  | { type: "adjust_life"; playerId: PlayerId; delta: number }
  | { type: "set_life"; playerId: PlayerId; life: number }
  | { type: "set_counter"; playerId: PlayerId; key: string; value: number }
  | {
      type: "set_commander_damage";
      playerId: PlayerId;
      sourceInstanceId: InstanceId;
      value: number;
    }
  | { type: "set_mana"; playerId: PlayerId; color: ManaColor; value: number }
  | { type: "empty_mana"; playerId: PlayerId }

  // --- Card movement & state -------------------------------------------------
  /**
   * The workhorse. Moves a card to `toZone`. For personal zones the card lands
   * in its owner's zone (graveyard, hand, ...). `index` controls position
   * (0 = top of library / front of list); omit to append. `x`/`y` set
   * battlefield position. Leaving the battlefield resets transient state.
   */
  | {
      type: "move_card";
      instanceId: InstanceId;
      toZone: Zone;
      index?: number;
      x?: number;
      y?: number;
    }
  | { type: "set_tapped"; instanceId: InstanceId; tapped: boolean }
  | { type: "adjust_card_counter"; instanceId: InstanceId; key: string; delta: number }
  | { type: "set_card_flags"; instanceId: InstanceId; flipped?: boolean; faceDown?: boolean }
  | { type: "set_card_position"; instanceId: InstanceId; x: number; y: number }
  | { type: "set_controller"; instanceId: InstanceId; controllerId: PlayerId }
  | { type: "attach"; instanceId: InstanceId; toInstanceId: InstanceId | null }
  | { type: "annotate"; instanceId: InstanceId; text: string }

  // --- Library operations ----------------------------------------------------
  | { type: "draw"; playerId: PlayerId; count: number }
  | { type: "shuffle"; playerId: PlayerId }
  | { type: "mulligan"; playerId: PlayerId; handSize?: number }

  // --- Turn structure (manual) ----------------------------------------------
  | { type: "set_phase"; phase: Phase }
  | { type: "advance_phase" }
  | { type: "pass_priority"; playerId: PlayerId }
  | { type: "end_turn" }

  // --- Misc ------------------------------------------------------------------
  | { type: "roll_die"; playerId: PlayerId; sides: number }
  | { type: "flip_coin"; playerId: PlayerId };

export interface GameCommand {
  action: Action;
  actorId: PlayerId;
  /** Optional client sequence number for optimistic-UI reconciliation later. */
  clientSeq?: number;
}

/** Thrown by the reducer when a command is not permitted / not legal-to-apply. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}
