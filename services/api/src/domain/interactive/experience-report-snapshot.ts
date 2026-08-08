/**
 * Experience attachment → prompt report snapshot mapper (IR-52, Wave 5).
 *
 * The load seam between {@link ExperienceStore} (DB rows) and the prompt
 * pipeline's pure {@link formatExperienceMessageBlock}. Mirrors
 * {@link storeRollToSnapshot} for Dice: converts a stored
 * `ExperienceAttachmentRow` into the immutable {@link ExperienceReportSnapshot}
 * the formatter consumes.
 *
 * Two invariants this mapper guarantees:
 *  1. It NEVER reads `hiddenStateCheckpointJson`. The hidden checkpoint lives in
 *     a separate column and is read only on branch-fork restore (IR-53), never
 *     on prompt assembly. The ordinary RP Writer sees only the public report.
 *  2. It parses `publicEventsJson` defensively. The attachment has NO foreign
 *     key to its session (it survives session deletion), so the report is a
 *     self-describing envelope (`{title, summary?, events[]}`). A corrupted or
 *     malformed attachment is SKIPPED (returns null) rather than crashing prompt
 *     assembly — a single bad attachment must not break the user's RP turn.
 */

import type { ExperienceReportSnapshot } from "@vibe-tavern/domain";
import type { ExperienceAttachmentRow } from "@vibe-tavern/db";

/** A minimal structural check on the parsed `publicEventsJson` envelope. */
function isPublicReportEnvelope(value: unknown): value is { title: string; summary?: string; events: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.title !== "string") return false;
  if (rec.summary !== undefined && typeof rec.summary !== "string") return false;
  if (!Array.isArray(rec.events)) return false;
  return true;
}

/** Coerce one parsed event into the snapshot shape (type must be a string). */
function coerceEvent(event: unknown): { type: string; detail?: unknown } | null {
  if (typeof event !== "object" || event === null) return null;
  const rec = event as Record<string, unknown>;
  if (typeof rec.type !== "string") return null;
  return rec.detail !== undefined ? { type: rec.type, detail: rec.detail } : { type: rec.type };
}

/**
 * Convert a stored experience attachment into the prompt report snapshot, or
 * `null` when its `publicEventsJson` is missing/malformed (the attachment is
 * then silently skipped on the prompt read path — see file header invariant 2).
 *
 * Exported so the prompt-assembly read path reuses the same mapping without
 * duplicating the parse + validate logic.
 */
export function storeAttachmentToReportSnapshot(
  attachment: ExperienceAttachmentRow,
): ExperienceReportSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachment.publicEventsJson);
  } catch {
    // Malformed JSON in a frozen attachment — skip it; prompt assembly degrades
    // gracefully (no report block) rather than failing the whole RP turn.
    return null;
  }
  if (!isPublicReportEnvelope(parsed)) return null;
  const events: { type: string; detail?: unknown }[] = [];
  for (const raw of parsed.events) {
    const coerced = coerceEvent(raw);
    if (coerced) events.push(coerced);
  }
  return {
    kind: attachment.kind,
    sessionRevision: attachment.sessionRevision,
    title: parsed.title,
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
    events,
  };
}
