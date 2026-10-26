/**
 * Experience RP-report message formatter (IR-52, Wave 5).
 *
 * The direct analogue of {@link formatDiceMessageBlock} for the ordinary RP
 * Writer. A bound experience attachment is immutable resolved message metadata,
 * like a bound dice roll: prompt assembly appends ONE clearly delimited block
 * to the carrying user message's effective content, instructing the Writer that
 * the events are authoritative and may be narrated but not altered, repeated as
 * new moves, or replaced. The Writer never receives tools and never chooses a
 * move (SCRIPTED_GAMES_DESIGN.md §"RP Report Binding / Flat Writer integration").
 *
 * This is a PURE function over already-bound immutable {@link ExperienceReportSnapshot}
 * data — it performs NO experience-script execution, NO state projection, and NO
 * I/O. It reads ONLY the public report fields (title / summary / participants / events). It
 * NEVER references hidden state: the hidden checkpoint lives in a separate DB
 * column read only on branch-fork restore, never on prompt assembly. Absence
 * (empty `reports`) returns an empty string, so a message without a bound
 * report is a byte-for-byte no-op for the assembly pipeline.
 */

import type { ExperienceReportSnapshot } from "@vibe-tavern/domain";
import { renderExperienceEventLine } from "@vibe-tavern/domain";

/**
 * Add the model block's list marker to the shared public-event rendering.
 */
function formatEventLine(
  event: ExperienceReportSnapshot["events"][number],
  participants: ExperienceReportSnapshot["participants"],
): string {
  return `- ${renderExperienceEventLine(event, participants)}`;
}

/**
 * The authority preamble every report block carries. Instructs the flat Writer
 * that the events are resolved facts: narrate them, but never alter, repeat as
 * new moves, or replace them. Kept as a single constant so the wording is
 * identical across every report and every send mode.
 */
const AUTHORITY_PREAMBLE =
  "The following experience events are resolved facts. Narrate them as part of the scene; do not alter them, repeat them as new moves, or replace them.";

/**
 * Format one bound report snapshot as a delimited model-only block.
 *
 * Layout:
 * ```
 * [Experience report — <title> — authoritative]
 * <authority preamble>
 * <optional summary line>
 * - <event>
 * - <event>
 * [End experience report]
 * ```
 *
 * V1 only renders the `report` attachment kind (public events). The `transcript`
 * kind (alternating Messenger dialogue) is a future capability and will get its
 * own wrapper; for now an unknown kind falls back to the generic report block so
 * the block is never silently dropped.
 */
function formatReportBlock(report: ExperienceReportSnapshot): string {
  const header = `[Experience report — ${report.title} — authoritative]`;
  const summaryLine = report.summary ? report.summary : "";
  const eventLines = report.events.map((event) => formatEventLine(event, report.participants));
  const body = [header, AUTHORITY_PREAMBLE, ...(summaryLine ? [summaryLine] : []), ...eventLines, "[End experience report]"];
  return body.join("\n");
}

/**
 * Format ALL bound experience reports for a message into a compact model-only block.
 *
 * Returns an empty string when `reports` is empty (absence is a no-op). When a
 * message carries multiple bound reports (uncommon — one frozen report per user
 * turn is the norm), each renders as its own delimited block joined by a blank
 * line, so the Writer can still tell them apart.
 */
export function formatExperienceMessageBlock(reports: readonly ExperienceReportSnapshot[]): string {
  if (reports.length === 0) return "";
  return reports.map(formatReportBlock).join("\n\n");
}
