export interface ChatSummaryContextCandidate {
  includeInContext: boolean;
  content: string;
}

/** Select the snapshots prompt assembly injects into the chat-summary slot. */
export function selectIncludedChatSummaries<T extends ChatSummaryContextCandidate>(
  summaries: readonly T[],
): T[] {
  return summaries.filter((summary) => summary.includeInContext && summary.content.trim());
}

export function buildChatSummaryContext<T extends ChatSummaryContextCandidate & {
  excludeSummarized: boolean;
  summarizedFrom: number;
  summarizedTo: number;
}>(summaries: readonly T[]): {
  enabledSummaries: T[];
  isInExcludedSummaryRange(position: number): boolean;
} {
  const enabledSummaries = selectIncludedChatSummaries(summaries);
  const excludedRanges = enabledSummaries
    .filter((summary) => summary.excludeSummarized && summary.summarizedTo >= summary.summarizedFrom)
    .map((summary) => ({ from: summary.summarizedFrom, to: summary.summarizedTo }));
  return {
    enabledSummaries,
    isInExcludedSummaryRange(position) {
      const oneBasedPosition = position + 1;
      return excludedRanges.some((range) => oneBasedPosition >= range.from && oneBasedPosition <= range.to);
    },
  };
}
