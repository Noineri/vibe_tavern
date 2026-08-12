/**
 * Experience-Copilot wire schemas (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 2 / ER-4).
 *
 * The experience-copilot is a standalone, editor-embedded subsystem (own backend
 * domain `interactive/copilot/`, own endpoint, own tables — ER-3) that lets the
 * model propose rules/visual edits and run tests against the unsaved source. Its
 * tools are the model's ONLY channel for proposing edits (the user commits via
 * the BE-6 endpoints); they NEVER write to a store.
 *
 * This file holds the subsystem's WIRE contracts shared with the frontend. ER-4
 * defines only the tool-output shape that the `write_buffer`/`edit_buffer` tools
 * return (the `target`/`proposed`/`summary` triple the frontend renders as a
 * diff). ER-7 will add the thread/message wire + context assembly schemas; those
 * are intentionally NOT pre-built here.
 *
 * Convention follows the Co-Author sibling: `coauthorToolOutputSchema` lives in
 * `chat-schema.ts` (the chat-bound co-author) while the co-author module config
 * lives in `coauthor-module.ts`. The experience-copilot is NOT chat-bound, so it
 * gets its own schema file rather than riding on `interactive-schema.ts` (which
 * is the interactive-RUNTIME session lifecycle — sessions, kernel, tester — not
 * the editor-copilot subsystem).
 */

import { z } from "zod";

/**
 * Which buffer a copilot proposed edit lands on. Drives which editor surface
 * shows the diff (the rules editor vs the visual editor). Mirrors
 * `CoauthorTarget` ("profile" | "greeting") for the two co-author surfaces.
 */
export const experienceCopilotTargetSchema = z.enum(["rules", "visual"]);
export type ExperienceCopilotTarget = z.infer<typeof experienceCopilotTargetSchema>;

/**
 * The `output` payload of an experience-copilot `write_buffer`/`edit_buffer`
 * `tool-result` (ER-4). The backend tool `execute()` returns this shape; it
 * crosses the wire verbatim and the frontend renders it as a proposed-buffer
 * diff for the user to commit via the BE-6 binding endpoints (the sole write
 * path). Mirrors `coauthorToolOutputSchema`, with the copilot's two named text
 * buffers ("rules"/"visual") in place of the co-author's profile/greeting
 * surfaces. The read-only tools (`run_test`, `run_simulate`,
 * `suggest_visual_binding`) return their own digest shapes and never carry this
 * proposal triple.
 */
export const experienceCopilotToolOutputSchema = z.object({
  target: experienceCopilotTargetSchema,
  proposed: z.string(),
  summary: z.string(),
});
export type ExperienceCopilotToolOutput = z.infer<typeof experienceCopilotToolOutputSchema>;

/**
 * The authoring step the user is on in the inline 3-step creation flow. Drives
 * the system framing + the context package the model sees (ER-5). Omitted on
 * the wire defaults to `"rules"` (the first step / a draft thread).
 */
export const experienceCopilotStepSchema = z.enum(["rules", "visual", "test"]);
export type ExperienceCopilotStep = z.infer<typeof experienceCopilotStepSchema>;

/**
 * Request body for the experience-copilot stream endpoint (ER-6),
 * `POST /api/experience-copilot/:threadId/stream`. Mirrors the AI-assistant's
 * `{ providerProfileId, model }` resolution shape, plus the copilot-specific
 * `content` (the user's message) and an optional `step`/`testFeedback`. The
 * thread id is a path param, not a body field. `testFeedback` is a free-form
 * passthrough of the latest test/simulate digest the user sent back from the
 * test panel (ER-5 renders it as context) — it is validated as a record, not
 * a typed digest, because the digest shapes live in the backend domain
 * (`experience-copilot-tools.ts`) and ER-7 will lift them into wire contracts.
 */
export const experienceCopilotStreamRequestSchema = z.object({
  content: z.string().min(1).max(50_000),
  providerProfileId: z.string().min(1),
  model: z.string().min(1).optional(),
  step: experienceCopilotStepSchema.optional(),
  testFeedback: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ExperienceCopilotStreamRequest = z.infer<typeof experienceCopilotStreamRequestSchema>;

/**
 * Wire shape of an experience-copilot thread (ER-7). Mirrors
 * `ExperienceCopilotThread` (packages/db/src/stores/experience-copilot-store.ts)
 * field-for-field. The thread's branded `ExperienceCopilotThreadId` and the
 * cross-domain soft-link `scriptId`/`draftSessionId` are all plain strings on
 * the wire (repo convention: branded ids flatten to `z.string()` — see
 * script-schema.ts). `archivedAt` is `null` for the active thread and an ISO
 * timestamp once archived; the at-most-one-active invariant lives in the store
 * (ER-3), not the schema.
 */
export const experienceCopilotThreadSchema = z.object({
  id: z.string(),
  scriptId: z.string().nullable(),
  draftSessionId: z.string().nullable(),
  title: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExperienceCopilotThreadWire = z.infer<typeof experienceCopilotThreadSchema>;

/**
 * Wire shape of an experience-copilot message (ER-7). Mirrors
 * `ExperienceCopilotMessage` (packages/db/src/stores/experience-copilot-store.ts):
 * a single assistant/user/tool-role turn on a thread. The message's branded
 * `ExperienceCopilotMessageId` and its parent `threadId` are plain strings on
 * the wire. `toolCallsJson`/`toolCallId` are nullable (present on tool-call /
 * tool-result turns, `null` otherwise).
 */
export const experienceCopilotMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.string(),
  content: z.string(),
  toolCallsJson: z.string().nullable(),
  toolCallId: z.string().nullable(),
  createdAt: z.string(),
});
export type ExperienceCopilotMessageWire = z.infer<typeof experienceCopilotMessageSchema>;

/**
 * Wire shape of a visual that is bound to the experience being authored and so
 * shown to the copilot as available context (ER-7). Mirrors the element shape of
 * `CopilotContext.boundVisuals`
 * (services/api/src/domain/interactive/copilot/experience-copilot-stream.ts):
 * `{ id, name, kind }`. `kind` is free-form string (currently always
 * `"visual"`) rather than an enum because the bound-visual set is open-ended;
 * the prompt renderer (experience-copilot-prompt.ts) emits it verbatim.
 */
export const experienceCopilotBoundVisualSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
});
export type ExperienceCopilotBoundVisual = z.infer<typeof experienceCopilotBoundVisualSchema>;
