/**
 * CM-4 context-metrics construction for a finished agent turn — extracted
 * from `agent-stream.ts` when that file hit the arch-gate size cap
 * (SIDECHAT_PLAN SC-9; the gate's prescribed remedy, not a behavior change).
 * Owns the accounting shape every kind's assembly returns and the honest
 * estimate-vs-provider total decision; the generic loop persists whatever
 * this builds (best-effort, back in the loop).
 */

import type { CopilotContextMetrics, CopilotMeterSegment } from "@vibe-tavern/db";

/** The segmented token accounting a kind's assembly hands the loop. The four
 *  fixed fields predate SC-0j; `segments` (SC-9) is the kind's own meter
 *  breakdown, relayed verbatim into the metrics — the loop never interprets
 *  the keys, exactly like the meter. Absent (the other kinds) = the fixed
 *  system/digest/history breakdown, byte-identical to before. */
export interface AgentTokenAccounting {
  readonly system: number;
  readonly digest: number;
  readonly history: number;
  readonly attached: number;
  readonly total: number;
  readonly segments?: ReadonlyArray<CopilotMeterSegment>;
}

/** One per-step usage record off the live provider-response trace
 *  (structural — the concrete SDK type satisfies this). */
interface AgentStepUsage {
  readonly usage?: { readonly inputTokens?: number };
}

/** The finish usage shape `mapFinish` resolves (structural). */
interface AgentFinishUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Build the turn's {@link CopilotContextMetrics}.
 *
 * Per-segment values are ALWAYS the assembler's estimate (the provider only
 * reports an aggregate). `totalTokens` prefers the provider's ACTUAL input
 * size of the FINAL request — read from the live provider-response trace's
 * LAST step — the aggregate `usage.inputTokens` SUMS steps (multi-step turns
 * re-send the whole context per step: 3 × ~63k ≈ 190k against a 100k budget —
 * a false 190% reading; the last step's input is the true final size).
 * Else the assembler's estimate — never blend the two and claim it was
 * measured. `budgetTokens` is 0 with no explicit budget (unmetered bar);
 * `reserveTokens` clamps negatives to 0 (maxTokens -1 = model decides).
 */
export function buildContextMetrics(input: {
  /** The live provider-response trace's per-step usage records. */
  readonly traceSteps: ReadonlyArray<AgentStepUsage>;
  /** The finish usage `mapFinish` resolved (fallback source). */
  readonly usage: AgentFinishUsage | undefined;
  /** The kind's assembly accounting (fixed fields + optional segments). */
  readonly tokenAccounting: AgentTokenAccounting;
  readonly limits: {
    readonly contextBudgetTokens: number;
    readonly responseReserveTokens: number;
  };
}): CopilotContextMetrics {
  const lastStepInputTokens = input.traceSteps.length > 0
    ? input.traceSteps[input.traceSteps.length - 1]?.usage?.inputTokens
    : undefined;
  const providerInputTokens = lastStepInputTokens ?? input.usage?.inputTokens;
  let metricsSource: "estimate" | "provider";
  let metricsTotalTokens: number;
  if (
    typeof providerInputTokens === "number" &&
    Number.isFinite(providerInputTokens) &&
    providerInputTokens > 0
  ) {
    metricsSource = "provider";
    metricsTotalTokens = providerInputTokens;
  } else {
    metricsSource = "estimate";
    metricsTotalTokens = input.tokenAccounting.total;
  }
  return {
    systemTokens: input.tokenAccounting.system,
    digestTokens: input.tokenAccounting.digest,
    historyTokens: input.tokenAccounting.history,
    totalTokens: metricsTotalTokens,
    attachedTokens: input.tokenAccounting.attached,
    budgetTokens: input.limits.contextBudgetTokens,
    reserveTokens: input.limits.responseReserveTokens,
    source: metricsSource,
    measuredAt: new Date().toISOString(),
    // SC-9: the kind's meter segments ride along verbatim (copy, so the
    // persisted object never aliases the assembly's readonly array); kinds
    // without segments keep metrics without the field.
    ...(input.tokenAccounting.segments !== undefined
      ? { segments: [...input.tokenAccounting.segments] }
      : {}),
  };
}
