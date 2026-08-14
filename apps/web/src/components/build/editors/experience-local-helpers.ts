/**
 * Shared local-id + pending-record helpers for the interactive Experience
 * authoring surfaces (ExperienceEditor).
 *
 * Extracted from ExperienceEditor.tsx so duplicate drafts can seed pending
 * rules/visual drafts through the SAME draft stores and the SAME
 * empty-base-dirty trick without duplicating the id counter or the record
 * factories. The id counter is module-level and shared so local ids never
 * collide across the editor.
 */
import type { ExperienceVisualDraftValues } from "../../../stores/experience-authoring-store.js";
import type { InteractiveRulesDraftValues } from "../../../lib/experience-rules-starters.js";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";

// ── Local (unsaved) record ids ─────────────────────────────────────────────
// A draft created from a starter/duplicate/wizard has no server row until its
// first save. Local ids namespace those buffers; `isLocalId` drives the
// create-vs-patch save branch and the trust model (a local source is never
// trusted).
let localIdCounter = 0;

export function nextLocalId(prefix: string): string {
  localIdCounter += 1;
  return `local:${prefix}:${localIdCounter}`;
}

export function isLocalId(id: string): boolean {
  return id.startsWith("local:");
}

// ── Starter pairing (IR-81A/IR-63 row order) ───────────────────────────────

/** Canonical rules-starter → visual-starter pairing. */
export const PAIRED_VISUAL_STARTER_ID: Record<string, string> = {
  round: "choice",
  board: "grid-board",
  card: "card-table",
  model_conversation: "conversation",
  blank_state_machine: "blank",
};

/** Bridge API version new visuals target (the version the five IR-63 starters
 *  are written against; there is no shared constant — the schema floor is 1). */
export const VISUAL_API_VERSION = 1;

// ── Pending-record factories ───────────────────────────────────────────────
// Build the in-memory ScriptRecord / ExperienceVisualRow that represents a
// not-yet-saved draft. Used by the editor (starter pick / duplicate) and the
// wizard (creation draft seed) so both feed the SAME store shape.

export function pendingScriptRecord(id: string, values: InteractiveRulesDraftValues): ScriptRecord {
  return {
    id,
    name: values.name,
    description: values.description,
    code: values.code,
    scriptKind: "interactive",
    enabled: false,
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    defaultVisualId: null,
    copilotProfileId: null,
    sortOrder: 0,
  };
}

export function pendingVisualRow(id: string, values: ExperienceVisualDraftValues): ExperienceVisualRow {
  return {
    id,
    name: values.name,
    source: values.source,
    sourceHash: "",
    apiVersion: values.apiVersion,
    compatibleManifestIds: [...values.compatibleManifestIds],
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    createdAt: "",
    updatedAt: "",
  };
}
