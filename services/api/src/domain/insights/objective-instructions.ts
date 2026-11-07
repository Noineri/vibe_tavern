/**
 * Objective prompt instruction composers (INSIGHTS_PLAN INS-3b/3c).
 *
 * The pure `compose*Instruction` functions that fold the resolved base prompt
 * and the dynamic objective context into the final instruction string the
 * insight model reads. Pure string composition only — no I/O, no state —
 * mirroring the Scene side's scene-instruction.ts.
 *
 * Extracted from objective-service.ts (DK-4b arch-gate ratchet: the service
 * file could not grow — the same remedy DR-3a applied with
 * objective-helpers.ts); the service imports them back and its public surface
 * is unchanged.
 */

/** Compose the final instruction: override-or-default base + dynamic objective context. */
export function composeGenerateInstruction(base: string, objectiveDescription: string): string {
  return `${base}\n\nObjective: ${objectiveDescription.trim() || "(unspecified)"}\n\nRequired output: one JSON object shaped exactly as {"tasks":[{"description":"..."}]}.`;
}

export function composeCheckInstruction(base: string, objectiveDescription: string, taskDescription: string): string {
  return `${base}\n\nObjective: ${objectiveDescription.trim() || "(unspecified)"}\nActive task: ${taskDescription}\n\nRequired output: one JSON object shaped exactly as {"completed":true} or {"completed":false}.`;
}

export function composeGenerateGoalsInstruction(base: string): string {
  return `${base}\n\nRequired output: one JSON object shaped exactly as {"longTerm":{"description":"..."},"shortTerm":[{"description":"..."}]}.`;
}

export function composeCheckGoalsInstruction(base: string, longTermDescription: string | null, shortTermDescription: string): string {
  const longTermLine = longTermDescription?.trim() ? `Long-term goal: ${longTermDescription.trim()}\n` : "";
  return `${base}\n\n${longTermLine}Active short-term goal: ${shortTermDescription}\n\nRequired output: one JSON object shaped exactly as {"completed":true} or {"completed":false}.`;
}
