import type { DiceLaneState } from "../api/types.js";

/** Why a send is Dice-blocked. */
export type DiceSendBlock = "choose" | "actor_mismatch";

/** Pure send-gate: the reason the active pending lane blocks a send, or null.
 *  Mirrors the backend bind gate (`bindActiveAndResetInTx`), which rejects an
 *  unresolved `choose` only among INCLUDED unbound rolls (the store already
 *  drops bound rolls) — so excluded rolls neither block nor bind. The actor
 *  check is frontend-only (the backend does not validate actor): a pending roll
 *  captured for an actor that no longer matches the current persona/character
 *  must not bind silently. Exported for the reactive `canSend` in
 *  use-input-area. */
export function diceSendBlockReason(
  lane: DiceLaneState | null | undefined,
  personaId: string | null,
  characterId: string | null,
): DiceSendBlock | null {
  if (!lane) return null;
  const bindable = lane.rolls.filter((roll) => roll.included);
  if (bindable.some((roll) => roll.policy === "choose" && roll.finalAttemptId === null)) return "choose";
  if (
    bindable.some((roll) =>
      roll.actor.actorType === "persona" ? roll.actor.actorId !== personaId : roll.actor.actorId !== characterId,
    )
  ) {
    return "actor_mismatch";
  }
  return null;
}
