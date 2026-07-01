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
