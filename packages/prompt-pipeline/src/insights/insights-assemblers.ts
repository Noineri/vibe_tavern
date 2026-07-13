/**
 * Insights assembler registry (INSIGHTS_PLAN INS-3c).
 *
 * The registry peer to `AI_ASSISTANT_ASSEMBLERS` / `SUMMARY_STRATEGIES`. Keyed
 * by `InsightsKind`; the `as const satisfies Record<InsightsKind,
 * InsightsAssembler>` guard makes adding a new kind a **compile error** until
 * an assembler is registered — so a kind that needs a divergent prompt shape
 * gets its own entry, and the chat pipeline is never involved (no flag on
 * `assemblePrompt`, no `if (kind === ...)` branch).
 */
import {
  DefaultInsightsAssembler,
  type InsightsAssembler,
  type InsightsKind,
} from "./insights-assembler.js";

export const INSIGHTS_ASSEMBLERS = {
  objective: DefaultInsightsAssembler,
  scene: DefaultInsightsAssembler,
} as const satisfies Record<InsightsKind, InsightsAssembler>;

export function getInsightsAssembler(kind: InsightsKind): InsightsAssembler {
  return INSIGHTS_ASSEMBLERS[kind];
}
