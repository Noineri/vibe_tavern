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
});

export const editMessageSchema = z.object({
  content: z.string().optional().default(""),
});

export const renameChatSchema = z.object({
  title: z.string(),
});

export const setGreetingIndexSchema = z.object({
  greetingIndex: z.number().int().min(0),
});

/** CA-13: replace the co-author chat's bound lorebook ids (right-panel picker).
 *  Wholesale replace — empty array clears the context. Strings (lorebook ids). */
export const setCoauthorLorebookIdsSchema = z.object({
  lorebookIds: z.array(z.string()),
});

export const renameBranchSchema = z.object({
  label: z.string().min(1),
});

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
  enabled: z.boolean(),
});
export type CoauthorDraftLoreEntry = z.infer<typeof coauthorDraftLoreEntrySchema>;

/**
 * The complete cumulative lore draft — every lorebook and entry proposed in
 * the turn so far. Returned IN FULL by every successful lore mutation so the
 * frontend always aggregates the latest complete graph (never a delta that
 * could drop earlier entries). This is the `bundle` payload of
 * {@link coauthorLoreBundleOutputSchema}.
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
