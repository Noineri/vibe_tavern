import type { DiceLaneState } from "../api/types.js";

export type DiceSendBlock = "choose" | "actor_mismatch";

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
  ) return "actor_mismatch";
  return null;
}
