import { buildChatSummaryContext } from "../prompt/chat-summary-selection.js";
import type { RpSyncPayload } from "./rp-sync.js";
import type { SidechatTimelineEvent } from "./sidechat-xml.js";

/**
 * SC-6 — RP-layer summary coverage, PURE: given the branch's LIVE summary
 * rows and a frozen `rp_sync` payload, decide which frozen messages drop and
 * where each summary's `<rp_summary>` row renders. No store reads here — the
 * loader (sidechat-context.ts) reads the summaries fresh on every turn and
 * hands them in; no `rp_summary` event is ever WRITTEN, these rows are
 * rendered live out of this module and the SC-3a renderer.
 *
 * THE COVERAGE RULE IS THE RP'S OWN, from its one source: the decision goes
 * through `buildChatSummaryContext` (chat-summary-selection.ts) and NEVER
 * through a second hand-written comparison — summary ranges are 1-based turn
 * numbers («T1–T5»), message positions are 0-based, and that function already
 * converts (the same conversion the range→row rendering below repeats once,
 * for the row's own bracket). Everything it derives holds here too:
 * - `includeInContext` off, or empty/whitespace content → the summary is not
 *   enabled: no row, and its range excludes nothing (messages render raw).
 * - enabled → one `<rp_summary>` row per summary, rendered ONCE, anchored at
 *   the first covered position in the frozen timeline's order.
 * - enabled + `excludeSummarized` → the covered frozen messages drop; without
 *   it they stay and render raw after the row.
 *
 * A frozen `rp_sync` event holds a BATCH: coverage is applied per message
 * inside the batch, so one stored event can split into several rendered rows
 * (a surviving run renders as its own `<rp_sync>` block bracketed exactly to
 * that run — the same first/last-position bracket the stored payload honors
 * for its own array).
 */

/** The coverage fields the store's summary row carries (ChatSummary minus the
 *  columns coverage never reads — structural, so tests pass narrow rows). */
export interface RpSummaryCoverageCandidate {
  id: string;
  content: string;
  includeInContext: boolean;
  excludeSummarized: boolean;
  summarizedFrom: number;
  summarizedTo: number;
}

/** The walk-long coverage state the loader threads through every `rp_sync`
 *  payload: summary rows anchor ONCE, so "already rendered" is state of the
 *  whole timeline walk, not of one batch. */
export interface RpSummaryCoverage {
  /** `<rp_summary>` rows anchored at or before `position` (each enabled
   *  summary exactly once, in ascending `from` order — the walk calls this in
   *  timeline order, so a row lands immediately before the first covered
   *  message it sees). */
  rowsBefore(position: number): SidechatTimelineEvent[];
  /** Whether the frozen message at `position` drops (an enabled summary with
   *  `excludeSummarized` covers it — decided by buildChatSummaryContext). */
  isExcluded(position: number): boolean;
  /** Rows whose range never anchored (every covered position beyond the
   *  frozen frontier, or its messages deleted) — the walk emits them at the
   *  end; an enabled summary the RP model sees is never silently dropped. */
  tailRows(): SidechatTimelineEvent[];
}

/** Build the walk-long coverage state over the branch's LIVE summary rows. */
export function createRpSummaryCoverage<T extends RpSummaryCoverageCandidate>(
  summaries: readonly T[],
): RpSummaryCoverage {
  // THE single coverage decision: buildChatSummaryContext derives both the
  // enabled set (includeInContext + non-empty content) and the excluded
  // ranges (enabled + excludeSummarized) — the same derivations the RP prompt
  // applies at its own assembly.
  const { enabledSummaries, isInExcludedSummaryRange } = buildChatSummaryContext(summaries);
  const pending = enabledSummaries
    .map((summary) => ({
      summary,
      // 1-based turn range → 0-based message positions (the timeline's one
      // position language — `rp_message` rows carry the same 0-based values).
      from: summary.summarizedFrom - 1,
      to: summary.summarizedTo - 1,
    }))
    // Ascending anchor; stable sort keeps the store's own order (sortOrder,
    // then summarizedFrom) for summaries that anchor at the same position.
    .sort((left, right) => left.from - right.from);
  let cursor = 0;
  const row = (item: (typeof pending)[number]): SidechatTimelineEvent => ({
    rowType: "event",
    kind: "rp_summary",
    payload: {
      fromPosition: item.from,
      toPosition: item.to,
      text: item.summary.content,
    },
  });
  const drain = (): SidechatTimelineEvent[] => {
    const rows: SidechatTimelineEvent[] = [];
    while (cursor < pending.length) {
      rows.push(row(pending[cursor]!));
      cursor += 1;
    }
    return rows;
  };
  return {
    rowsBefore(position: number): SidechatTimelineEvent[] {
      const rows: SidechatTimelineEvent[] = [];
      while (cursor < pending.length && pending[cursor]!.from <= position) {
        rows.push(row(pending[cursor]!));
        cursor += 1;
      }
      return rows;
    },
    isExcluded(position: number): boolean {
      return isInExcludedSummaryRange(position);
    },
    tailRows: drain,
  };
}

/**
 * Apply coverage to ONE frozen `rp_sync` payload: the batch's messages walk
 * in order, covered ones drop, an enabled summary's row renders before the
 * first message at or past its anchor, and each surviving RUN closes into its
 * own `<rp_sync>` block (bracketed to that run). An all-covered batch yields
 * only its anchored rows — never an empty `<rp_sync>` wrapper.
 */
export function coverRpSyncPayload(
  payload: RpSyncPayload,
  coverage: RpSummaryCoverage,
): SidechatTimelineEvent[] {
  const events: SidechatTimelineEvent[] = [];
  let run: RpSyncPayload["messages"] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    events.push({
      rowType: "event",
      kind: "rp_sync",
      payload: {
        fromPosition: run[0]!.position,
        toPosition: run[run.length - 1]!.position,
        messages: run,
      },
    });
    run = [];
  };
  for (const message of payload.messages) {
    // Anchor first, THEN test exclusion: the summary row lands at the first
    // covered position even when that message itself drops.
    const summaryRows = coverage.rowsBefore(message.position);
    if (summaryRows.length > 0) flushRun();
    events.push(...summaryRows);
    if (!coverage.isExcluded(message.position)) run.push(message);
  }
  flushRun();
  return events;
}
