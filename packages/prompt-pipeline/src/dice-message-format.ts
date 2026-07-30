/**
 * Compact Dice message formatter (DICE_SYSTEM_BACKEND_PLAN, Wave B5 / DICE-B13).
 *
 * This is a PURE function over already-bound immutable {@link DiceRollSnapshot}
 * data — it performs NO Dice-script execution, NO rolling, and NO I/O. The
 * caller (prompt assembly) passes in the frozen message-scoped snapshots and
 * receives a compact model-only text block that is appended to the message's
 * effective content exactly once.
 *
 * Format contract (one line per check, grouped under a `[Dice]` header):
 *
 * - STRICT checks include binding adjudication: the model must honor
 *   `outcome` / `degree` / `constraint` as authoritative facts.
 * - NARRATIVE checks include only mechanical facts (faces / total); they omit
 *   success/failure so the model is free to interpret.
 *
 * Absence (empty `rolls`) returns an empty string, so a message without bound
 * rolls is a byte-for-byte no-op for the assembly pipeline.
 */

import type { DiceRollSnapshot } from "@vibe-tavern/domain";

/** Format a signed modifier for compact display (`+1`, `-2`, or empty when zero). */
function formatModifier(mod: number): string {
  if (mod === 0) return "";
  return mod > 0 ? `+${mod}` : `${mod}`;
}

/**
 * Format one attempt's dice values.
 *
 * Produces `[3,5]+1 = 9` (modifier omitted when zero). When a check has
 * multiple attempts (Immersive mode), each is prefixed with `attempt N: ` and
 * may carry a parenthesized grant reason (`(Lucky Rerroll)`) or a `(chosen)`
 * marker indicating the finalized attempt.
 */
function formatAttempt(
  attempt: DiceRollSnapshot["attempts"][number],
  index: number,
  multiple: boolean,
): string {
  const faces = `[${attempt.faces.join(",")}]`;
  const mod = formatModifier(attempt.modifier);
  const expression = mod ? `${faces}${mod}` : faces;
  const prefix = multiple ? `attempt ${index + 1}: ` : "";
  const grant = attempt.grantReason ? ` (${attempt.grantReason})` : "";
  const chosen = attempt.chosenFinal ? " (chosen)" : "";
  return `${prefix}${expression} = ${attempt.total}${grant}${chosen}`;
}

/**
 * Format one roll snapshot as a single compact line for the model.
 *
 * Strict checks (with a `final`) append the binding adjudication — outcome
 * and optional degree, plus an optional constraint the model must respect.
 * Narrative checks present only the mechanical facts (faces / total).
 */
function formatRollLine(roll: DiceRollSnapshot): string {
  const header = `${roll.checkLabel} (${roll.notation}) — ${roll.actor.actorLabel}`;
  const multiple = roll.attempts.length > 1;
  const attemptsText = roll.attempts
    .map((attempt, i) => formatAttempt(attempt, i, multiple))
    .join("; ");

  if (roll.resolution === "strict" && roll.final) {
    const adjudicationParts: string[] = [];
    if (roll.final.outcome) adjudicationParts.push(roll.final.outcome);
    if (roll.final.degree) adjudicationParts.push(`(${roll.final.degree})`);
    const adjudication =
      adjudicationParts.length > 0 ? ` Adjudication: ${adjudicationParts.join(" ")}.` : "";
    const constraint = roll.final.constraint
      ? ` Binding constraint: ${roll.final.constraint}.`
      : "";
    return `${header}: ${attemptsText}.${adjudication}${constraint}`;
  }

  // Narrative (or strict without a final): mechanical facts only, no adjudication.
  return `${header}: ${attemptsText}.`;
}

/**
 * Format ALL bound Dice rolls for a message into a compact model-only block.
 *
 * Returns an empty string when `rolls` is empty (absence is a no-op).
 */
export function formatDiceMessageBlock(rolls: readonly DiceRollSnapshot[]): string {
  if (rolls.length === 0) return "";
  const lines = rolls.map(formatRollLine);
  return `[Dice]\n${lines.join("\n")}`;
}
