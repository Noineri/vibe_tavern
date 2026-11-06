/**
 * MessageStore's public TYPES (extracted from message-store.ts for the
 * file-size ratchet, DMT-22 — a move, not a rewrite: every interface and
 * error class is verbatim). The store module re-exports all of them, so
 * every existing import path (`./message-store.js`, `@vibe-tavern/db`)
 * keeps resolving unchanged.
 */

import type { SceneBackfillMode, SceneBackfillRunStatus, SceneTrackerDsl, ScenePromptFormat } from '@vibe-tavern/domain';

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level Message — domain Message projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 */
export interface Message {
  id: string;
  chatId: string;
  branchId: string;
  role: string;
  authorType: string;
  position: number;
  content: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  attachmentsJson?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: unknown; providerOptions?: unknown }> | null;
  toolCallId?: string | null;
}

/**
 * Store-level MessageVariant — domain MessageVariant projected from a DB row.
 */
export interface MessageVariant {
  id: string;
  messageId: string;
  variantIndex: number;
  content: string;
  isSelected: boolean;
  finishReason: string | null;
  reasoning: string | null;
  reasoningDurationMs: number | null;
  modelId: string | null;
  presetName: string | null;
  createdAt: string;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: unknown; providerOptions?: unknown }> | null;
  toolCallId?: string | null;
  /** Canonical per-variant Scene record; null when the variant has none yet
   *  (just created, or cleared on content edit). Owned by this variant's
   *  immutable id. Parsed from scene_tracker_json at this boundary. */
  sceneTracker: MessageVariantSceneRecord | null;
  /** TTS narration annotation (TPE-1, AN-1): the annotated copy of this
   *  variant's content (expressive tags inserted, text otherwise identical).
   *  Null = not annotated — narration reads the content itself. A persisted
   *  fact like the Scene record: content edits do NOT clear it. */
  ttsAnnotation: string | null;
  /** IG-18a: image-gen slot variants carry their image attachments here
   * (raw JSON string, parsed at the DTO boundary with
   * parseStoredAttachments). Null = this variant carries none — every text
   * variant, and slot variant 0 for legacy slots (those fall through to the
   * message row's attachments at the DTO merge point). */
  attachmentsJson: string | null;
}

/**
 * Store-level Scene record — the plain-string mirror of the domain
 * SceneTrackerRecord. Brands are applied at the API boundary (like Message /
 * MessageVariant ids). One record per immutable variant, stored as JSON in
 * message_variants.scene_tracker_json.
 *
 * A record is a persisted fact: a tracker config change never hides or deletes
 * it. `schema`/`promptFormat` are the record's self-describing snapshot (absent
 * only on legacy records persisted before the snapshot contract — readers fall
 * back to the live config then). `schemaHash`/`configRevision` are identity +
 * trace, never a visibility gate; `sourceHash` is the content-drift guard.
 */
export interface MessageVariantSceneRecord {
  /** The immutable variant this record was generated for (ownership identity). */
  variantId: string;
  /** The config schemaHash captured at generation time (identity/coherence, NOT a visibility gate). */
  schemaHash: string;
  /** The config revision captured at generation time (pure trace). */
  configRevision: number;
  /** Hash of the variant source content captured at generation time. */
  sourceHash: string;
  /** The schema DSL (with labels) captured at generation time — self-describing snapshot. Absent on legacy records. */
  schema?: SceneTrackerDsl;
  /** The prompt format captured at generation time. Absent on legacy records. */
  promptFormat?: ScenePromptFormat;
  /** The validated scene state, matching the record's own `schema` snapshot. */
  sceneState: Record<string, unknown>;
  /** The model that produced this record (for trace). */
  modelId: string | null;
  generatedAt: string;
}

/**
 * The active branch's latest assistant message + its selected variant's raw
 * Scene record — the source for the derived current-Scene cache (SCN-6).
 * Null when the branch has no assistant message, the latest assistant has no
 * selected variant, or that variant has no record. See the store's
 * `getCurrentSceneTarget`.
 */
export interface CurrentSceneTarget {
  messageId: string;
  variantId: string;
  record: MessageVariantSceneRecord;
}

/**
 * Store-level Scene backfill run — durable job state for history backfill
 * (SCENE_TRACKER_PLAN Wave 7). Tracks the JOB only (ownership / frozen
 * manifest / cursor / status / per-item errors / cancel / summary); it is
 * NEVER authoritative for Scene data, which lives on message_variants.
 */
export interface SceneBackfillRun {
  id: string;
  chatId: string;
  mode: SceneBackfillMode;
  status: SceneBackfillRunStatus;
  manifestJson: string;
  totalItems: number;
  cursor: number;
  errorsJson: string;
  cancelRequested: boolean;
  summaryJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Thrown when a guarded edit targets a variant that is no longer selected. */
export class SelectedVariantMismatchError extends Error {
  constructor(
    readonly messageId: string,
    readonly expectedVariantId: string,
    readonly actualVariantId: string | null,
  ) {
    super(`Selected variant '${expectedVariantId}' no longer matches message '${messageId}'.`);
    this.name = "SelectedVariantMismatchError";
  }
}

/** Thrown when a guarded edit's expected base text no longer matches the
 *  SELECTED variant's stored content (DMT-22): the variant id still matches,
 *  but the text changed since the caller reviewed its diff base. The check
 *  lives inside the store's synchronous `editMessage` transaction, so a
 *  racing edit between the caller's preflight read and this write still
 *  fails the whole transaction — a stale proposal never overwrites a newer
 *  edit to the same (still-selected) variant. */
export class SelectedVariantContentMismatchError extends Error {
  constructor(
    readonly messageId: string,
    readonly expectedContent: string,
    readonly actualContent: string | null,
  ) {
    super(`Selected variant content of message '${messageId}' no longer matches the expected base.`);
    this.name = "SelectedVariantContentMismatchError";
  }
}

/** Input shape for the store's `addMessage` / `addMessageWithDiceBind`.
 *  Extracted so the dice-aware variant shares the exact insert contract (no drift). */
export interface AddMessageInput {
  chatId: string;
  branchId: string;
  role: string;
  authorType: string;
  content: string;
  reasoning?: string;
  reasoningDurationMs?: number;
  modelId?: string | null;
  /** Prompt preset used for THIS message. Recorded on the selected variant
   *  (the field the message footer reads) so every reply — send, continue,
   *  regenerate, queue — carries its preset, not only the queue/variant path. */
  presetName?: string | null;
  variants?: string[];
  selectedVariantIndex?: number;
  attachmentsJson?: string | null;
  toolCallsJson?: string | null;
  toolCallId?: string | null;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
}
