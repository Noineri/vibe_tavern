import { brandId, type MessageVariantId } from "@vibe-tavern/domain";
import { z } from "zod";

export const createChatSchema = z.object({
  characterId: z.string(),
  /** Chat mode. Omit for the default 'rp'. Allowed values mirror CHAT_MODE. */
  mode: z.enum(["rp", "coauthor", "novel", "group"]).optional(),
});

export const cloneChatSchema = z.object({});

export const attachmentSchema = z.object({
  /** Stable attachment id — correlates vision descriptions back to specific attachments. */
  id: z.string().min(1),
  assetId: z.string().min(1),
  type: z.enum(["image", "file", "video"]),
  name: z.string().max(255),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().positive().max(50_000_000),
});

export const sendMessageSchema = z.object({
  content: z.string(),
  attachments: z.array(attachmentSchema).max(5).optional(),
  /**
   * DICE-B10: optional Dice commit intent. Omitted ⇒ no-Dice send behavior
   * (byte-for-byte current path). When present, `diceMode` selects the active
   * lane and `pendingRevision` is the client's last-seen active-lane revision;
   * a stale value fails the whole user-turn commit before the message row
   * persists. Both fields are required together (a half-spec is rejected) and
   * never carry raw rolls or client-selected keys.
   */
  diceMode: z.enum(["normal", "immersive"]).optional(),
  pendingRevision: z.number().int().nonnegative().optional(),
}).refine(
  (data) => (data.diceMode === undefined) === (data.pendingRevision === undefined),
  { message: "diceMode and pendingRevision must both be present or both absent" },
);

const messageVariantIdSchema = z.string().min(1).transform((value) => brandId<MessageVariantId>(value));

export const editMessageSchema = z.object({
  content: z.string().optional().default(""),
  expectedVariantId: messageVariantIdSchema.optional(),
});

export const createMessageVariantSchema = z.object({
  content: z.string().min(1),
  sourceVariantIds: z.array(messageVariantIdSchema).min(2),
  modelId: z.string().optional(),
  promptPresetId: z.string().optional(),
  finishReason: z.string().optional(),
});

export const renameChatSchema = z.object({
  title: z.string(),
});

export const setGreetingIndexSchema = z.object({
  greetingIndex: z.number().int().min(0),
});

export const updateDynamicPromptSchema = z.object({
  content: z.string(),
});

/** CE-C1: replace the co-author chat's pinned Level-1 context entities
 *  (right-panel picker). Wholesale replace — empty array clears the context.
 *  Each link is a typed target (character/persona/lorebook/script). Generalizes
 *  the CA-13 lorebook-id-only list; the DB column retains its legacy
 *  `coauthor_lorebook_ids_json` SQL name with the new typed payload. */
export const coauthorContextLinkSchema = z.object({
  targetType: z.enum(["character", "persona", "lorebook", "script"]),
  targetId: z.string(),
});
export type CoauthorContextLinkInput = z.infer<typeof coauthorContextLinkSchema>;

export const setCoauthorContextLinksSchema = z.object({
  links: z.array(coauthorContextLinkSchema),
});

export const renameBranchSchema = z.object({
  label: z.string().min(1),
});

// ─── Wave 4: proposal-only lore authoring (CTX-L1) ───────────────────────────
// Lore tools are PROPOSAL-ONLY: tool execution allocates stable draft IDs and
// mutates ONLY a request-local LoreDraftState (no LorebookStore, no SQLite).
// Apply is the sole persistence boundary; Cancel leaves the DB unchanged. The
// contract below is the cumulative bundle that every successful lore mutation
// returns in full, so last-proposal aggregation can never discard earlier
// entries or fields. The draft lorebook/entry shapes are authoring-focused
// (stable IDs + parent refs + content + keys + activation), not the full
// ST-parity LoreEntry — Apply (CTX-L2) fills store defaults for the rest.

/**
 * A draft lorebook proposed by a lore tool. Stable `id` is allocated in the
 * request-local closure and becomes the DB primary key at Apply (CTX-L2
 * upsert-with-id). `scopeType` mirrors {@link LoreScopeType}; default
 * "character" (the co-author edits a character card's lore).
 */
export const coauthorDraftLorebookSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scopeType: z.enum(["global", "character", "persona", "chat"]),
  enabled: z.boolean(),
  /** Activation: how many recent messages to scan for key matches (CE-A1). Optional — the draft engine fills `LOREBOOK_DEFAULTS`; Apply honors the co-author's choice. */
  scanDepth: z.number().int().optional(),
  /** Activation: max tokens the lorebook may inject per turn (CE-A1). */
  tokenBudget: z.number().int().optional(),
  /** Activation: whether a key match can recurse into matched entries' keys (CE-A1). */
  recursiveScanning: z.boolean().optional(),
  /**
   * CE-B1: whether this node is a NEW creation (INSERT) or an EDIT of an
   * existing persisted entity (UPDATE via Apply's upsert). Omitted / "create"
   * = a new lorebook proposed this turn; "edit" = a co-author-created
   * lorebook being modified (the `id` is its real DB primary key). Apply
   * upserts either way (it does not branch on mode); the marker is consumed
   * by the review UI to badge new-vs-edit. Set by the draft engine.
   */
  mode: z.enum(["create", "edit"]).optional(),
});
export type CoauthorDraftLorebook = z.infer<typeof coauthorDraftLorebookSchema>;

/**
 * A draft lore entry proposed by a lore tool. `lorebookId` is the parent
 * reference — it MUST resolve to a lorebook id present in the same bundle
 * (validated before the snapshot advances; a missing parent is rejected and
 * leaves all prior draft state intact). `keys` are activation triggers;
 * `constant`/`position`/`depth` are the activation fields a co-author sets.
 */
export const coauthorDraftLoreEntrySchema = z.object({
  id: z.string(),
  lorebookId: z.string(),
  title: z.string(),
  content: z.string(),
  keys: z.array(z.string()),
  secondaryKeys: z.array(z.string()),
  /** Constant entries activate every turn regardless of key match. */
  constant: z.boolean(),
  /** Where the entry injects (mirrors LoreEntryPosition, string form). */
  position: z.string(),
  depth: z.number().int(),
  /** CE-A2: activation logic / match mode (ST selective_logic via domain LORE_LOGIC; default "and_any"). Optional — the draft engine fills the default; Apply honors the co-author's choice. */
  logic: z.string().optional(),
  enabled: z.boolean(),
  /**
   * CE-B2: parent-reference provenance. Omitted = the parent lorebook MUST be
   * present in this proposal bundle (normal create flow). "persisted" = the
   * parent was verified via LoreEntityLookup and intentionally lives only in
   * the DB (edit_lore_entry / add_lore_entry across turns). Apply + review may
   * therefore accept/render the entry without a parent node in the bundle.
   */
  parentMode: z.literal("persisted").optional(),
  /**
   * CE-B1: whether this node is a NEW creation (INSERT) or an EDIT of an
   * existing persisted entry (UPDATE via Apply's upsert). Omitted / "create"
   * = a new entry proposed this turn; "edit" = a co-author-created entry
   * being modified (the `id` is its real DB primary key). Apply upserts
   * either way; the marker badges the review UI's new-vs-edit distinction.
   */
  mode: z.enum(["create", "edit"]).optional(),
});
export type CoauthorDraftLoreEntry = z.infer<typeof coauthorDraftLoreEntrySchema>;

/**
 * The complete cumulative lore draft — every lorebook and entry proposed in
 * the turn so far. Returned IN FULL by every successful lore mutation so the
 * frontend always aggregates the latest complete graph (never a delta that
 * could drop earlier entries). This is the `bundle` payload of
 * {@link coauthorLoreBundleOutputSchema} and of the loreBundle Apply field.
 */
export const coauthorLoreBundleSchema = z.object({
  lorebooks: z.array(coauthorDraftLorebookSchema),
  entries: z.array(coauthorDraftLoreEntrySchema),
});
export type CoauthorLoreBundle = z.infer<typeof coauthorLoreBundleSchema>;

/**
 * The `output` payload of a `lore_bundle` `tool-result` SSE event (CTX-L1).
 * A PROPOSAL (unlike `coauthorSkillReadOutputSchema` which is a non-proposal
 * read): the frontend aggregates the latest bundle per turn and renders it as
 * a structured review surface (CTX-L3). `target` is the literal
 * `"lore_bundle"` so aggregation can route it distinctly from profile/greeting
 * proposals. The backend canonical definition lives in `lore-draft-state.ts` /
 * `coauthor-tools.ts`; this schema is the single source of truth for the wire
 * shape.
 */
export const coauthorLoreBundleOutputSchema = z.object({
  target: z.literal("lore_bundle"),
  bundle: coauthorLoreBundleSchema,
  summary: z.string(),
});
export type CoauthorLoreBundleOutput = z.infer<typeof coauthorLoreBundleOutputSchema>;

/**
 * Co-Author Apply request (CA-7). The frontend aggregates `CoauthorToolOutput[]`
 * from a co-author turn into this canonical proposed state; the backend never
 * sees AI SDK tool shapes, only the canonical character fields it knows how to
 * persist. All fields optional — partial applies are valid (e.g. greetings-only
 * when the model only touched greetings, no `profileMd`).
 */
export const coauthorApplySchema = z.object({
  /** Full canonical `profile.md` document (frontmatter + H1 sections). */
  profileMd: z.string().optional(),
  /** Replacement for `firstMessage` (greeting index 0). */
  firstMessage: z.string().optional(),
  /** Full replacement array for `alternateGreetings` (indices 1..N). */
  alternateGreetings: z.array(z.string()).optional(),
  /**
   * CTX-L2 (Wave 4): the accepted cumulative lore draft (lorebooks + entries
   * with preallocated stable ids). Apply is the sole persistence boundary for
   * lore proposals — tool execution only mutates a request-local draft; this
   * field carries the user-accepted graph to be written idempotently.
   */
  loreBundle: coauthorLoreBundleSchema.optional(),
});

export type CoauthorApplyRequest = z.infer<typeof coauthorApplySchema>;

/**
 * Where a co-author proposed edit lands. Drives which frontend surface shows
 * the diff (the profile body vs a greeting slot).
 */
export const coauthorTargetSchema = z.enum(["profile", "greeting"]);
export type CoauthorTarget = z.infer<typeof coauthorTargetSchema>;

/**
 * The `output` payload of a co-author `tool-result` SSE event (CA-6/CA-9). The
 * backend tool `execute()` returns this shape; it crosses the wire verbatim as
 * the `output` field of the `tool-result` event. The frontend renders it as a
 * collapsible activity card (summary label + mini-diff) and aggregates the
 * turn's outputs into a {@link CoauthorApplyRequest} on Apply (CA-11). The
 * backend canonical definition lives in `services/api/.../coauthor-tools.ts`
 * and imports this type — single source of truth for the wire shape.
 */
export const coauthorToolOutputSchema = z.object({
  target: coauthorTargetSchema,
  greetingIndex: z.number().int().min(0).optional(),
  isAdd: z.boolean().optional(),
  proposed: z.string(),
  summary: z.string(),
});
export type CoauthorToolOutput = z.infer<typeof coauthorToolOutputSchema>;

/**
 * The `output` payload of a `read_skill_file` `tool-result` SSE event (CTX-S4).
 * A read is NOT a proposal — it carries no `target`/`proposed`, so it never
 * enters proposal aggregation (CTX-S6); it is shown only as glanceable tool
 * activity (the file path the model read). The backend sandboxed reader
 * (`skill-read-tool.ts`) returns this shape; it crosses the wire verbatim as
 * the `tool-result` event's `output` and is persisted as the `role:"tool"`
 * row's JSON content. `content` is intentionally NOT surfaced in the activity
 * card (it can be large) — only `path` is rendered.
 */
export const coauthorSkillReadOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type CoauthorSkillReadOutput = z.infer<typeof coauthorSkillReadOutputSchema>;

/**
 * Metadata-only catalog entry for a Co-Author skill (CTX-S3 / CTX-S7). One row
 * per discovered skill directory (built-in or user); a user skill shadows a
 * same-id built-in. Deliberately carries NO file body (the manifest text is
 * fetched on demand by the model via `read_skill_file`) and NO absolute
 * filesystem path — only the portable root-relative manifest path crosses the
 * wire. This is the shared wire contract consumed by both the skill-library
 * HTTP routes and the frontend skill manager / module-editor skill picker.
 */
export const skillCatalogEntrySchema = z.object({
  /** Stable skill id = the skill directory name. */
  id: z.string(),
  /** Where the winning copy lives: a user skill shadows a same-id built-in. */
  source: z.enum(["builtin", "user"]),
  name: z.string(),
  description: z.string(),
  /** Path to `SKILL.md` relative to its root (`<id>/SKILL.md`) — portable. */
  manifestPath: z.string(),
  /** True when a user skill with this id shadows a built-in (user precedence). */
  shadowsBuiltin: z.boolean(),
});
export type SkillCatalogEntryDto = z.infer<typeof skillCatalogEntrySchema>;

/** A malformed-manifest notice surfaced with the skill id (no absolute path). */
export const skillCatalogErrorSchema = z.object({
  source: z.enum(["builtin", "user"]),
  id: z.string(),
  reason: z.string(),
});
export type SkillCatalogError = z.infer<typeof skillCatalogErrorSchema>;

/** Merged metadata-only catalog: built-in + user skills (user precedence). */
export const skillCatalogSchema = z.object({
  entries: z.array(skillCatalogEntrySchema),
  errors: z.array(skillCatalogErrorSchema),
});
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

/** Result of an atomic skill-tree import (CTX-S2). */
export const skillImportResultSchema = z.object({
  /** Top-level directories that contain a SKILL.md after the import (the skills). */
  importedSkillIds: z.array(z.string()),
  /** Every top-level directory written, including non-skill siblings. */
  importedTopLevelDirs: z.array(z.string()),
});
export type SkillImportResult = z.infer<typeof skillImportResultSchema>;

/**
 * One exact SEARCH/REPLACE edit applied to a single prose section body. Used by
 * the per-section `edit_*` tools (edit_personality / edit_scenario /
 * edit_examples) and by the frontend operation-card renderer (Wave 6), so the
 * tool definition and the rendered preview agree on the input shape.
 *
 * Semantics (enforced in the backend `execute()`, not by Zod, so rejections
 * surface as actionable tool-errors the model can self-correct from):
 *  - `search` must be non-empty and match EXACTLY ONCE in the current scoped
 *    section body (literal, not regex; case-sensitive).
 *  - `replace` may be empty (deletion) but must differ from `search` (no-op
 *    rejected).
 */
export const coauthorEditItemSchema = z.object({
  search: z
    .string()
    .describe("Exact literal text to find in the current section body. Must occur exactly once; add surrounding context to disambiguate."),
  replace: z
    .string()
    .describe("The replacement text. May be empty to delete the match. Must differ from `search`."),
});
export type CoauthorEditItem = z.infer<typeof coauthorEditItemSchema>;

/**
 * Input for a per-section exact-edit tool. `edits` is applied in array order to
 * the section's CURRENT (cumulative within the turn) body; a batch commits
 * atomically (any failed item rejects the whole batch and changes nothing).
 */
export const coauthorSectionEditInputSchema = z.object({
  edits: z
    .array(coauthorEditItemSchema)
    .describe("Ordered exact SEARCH/REPLACE edits applied to this section's body in array order. Non-empty."),
  summary: z
    .string()
    .max(200)
    .describe("One-line description of what this edit changes, shown above the Apply button."),
});
export type CoauthorSectionEditInput = z.infer<typeof coauthorSectionEditInputSchema>;

/**
 * Input for a per-section whole-write tool (write_personality / write_scenario /
 * write_examples). `content` replaces the ENTIRE body of one section — the
 * correct operation for populating an empty section or an intentional
 * whole-section rewrite. Non-empty (whitespace-only rejected in `execute()`).
 */
export const coauthorSectionWriteInputSchema = z.object({
  content: z
    .string()
    .describe("The full proposed body for this one section (do NOT include the heading)."),
  summary: z
    .string()
    .max(200)
    .describe("One-line description of what this write changes, shown above the Apply button."),
});
export type CoauthorSectionWriteInput = z.infer<typeof coauthorSectionWriteInputSchema>;

/**
 * A backend-applied correction during Co-Author Apply (CA-7 R3). Returned to the
 * frontend so the user is notified (not silently masked) when the model's
 * proposal would have lost data — e.g. an empty `name` restored from the
 * current character. Shared DTO (backend response element + frontend toast).
 */
export const coauthorCorrectionSchema = z.object({
  /** Canonical character field that was corrected, e.g. "name". */
  field: z.string(),
  /** What the backend did, e.g. "restored". */
  action: z.string(),
  /** Human-readable reason for the UI toast. */
  reason: z.string(),
});

export type CoauthorCorrection = z.infer<typeof coauthorCorrectionSchema>;
