import { DefaultSummaryStrategy, type SummaryStrategy } from "./summary-strategy.js";

export const SUMMARY_STRATEGIES = {
  default: DefaultSummaryStrategy,
} as const satisfies Record<string, SummaryStrategy>;

export function getSummaryStrategy(): SummaryStrategy {
  return SUMMARY_STRATEGIES.default;
}
