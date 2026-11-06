/**
 * Director message tools (DIRECTOR_MESSAGE_TOOLS_PLAN, Wave 1 / DMT-11) —
 * the SHARED CONTRACTS for the sidechat Director's three message tools:
 *
 * - `propose_message_edit` — delegate a mechanical correction to the ordinary
 *   AI message editor; the Director supplies the instruction, the editor
 *   supplies the candidate, and the user reviews the source/candidate diff
 *   before Apply (the ordinary editor generation, never a Director-only one).
 * - `propose_message_variant` — the Director writes a COMPLETE alternative
 *   reply itself (no second LLM call); the user reviews the full candidate
 *   before Save as a separate swipe through the ordinary add-variant path.
 * - `request_message_swipe` — the Director proposes a one-shot regeneration
 *   instruction behind the existing permission mechanism; the user inspects
 *   and edits it, then Allow runs exactly one RP generation with the final
 *   approved text as a request-local `user` layer (DMT-12/13) — or Reject
 *   makes none.
 *
 * This file defines identifiers and payload validation ONLY: no tools, no UI,
 * no generation. Producers (the sidechat tool builders, DMT-21), resolvers
 * (the record-proposal registry handlers, DMT-22) and the review UI (DMT-32/33)
 * must all consume these schemas — one source, no duplicate derivations.
 *
 * The first two tools surface as ordinary `RecordProposal`s
 * (`agent-proposal.ts`): their `recordType` is one of the
 * {@link DIRECTOR_MESSAGE_RECORD_TYPES} values and their persisted `payload`
 * is the matching proposal payload below. The third is a SPLIT-TURN PERMISSION
 * tool, not a proposal: its persisted tool-row output follows the marker/receipt
 * vocabulary the split-turn mechanism dispatches on (`status:
 * "awaiting_permission" | "granted" | "denied"` at the top level), extended
 * with the frozen target identity and the instruction.
 *
 * Strictness follows the neighboring schemas' existing split: TOOL INPUTS are
 * model-authored (lenient `z.object`, like `sidechatPromptReadInputSchema` —
 * the AI SDK parses model output and an extra key must not crash a call),
 * while PERSISTED payloads/markers/receipts are server-authored state the UI
 * renders verbatim (`.strict()`, like `copilotTodoItemSchema` — a producer bug
 * must not smuggle fields into persistence).
 */

import { z } from "zod";

// ─── Tool identifiers ─────────────────────────────────────────────────────────

/**
 * The three Director message tools' wire names — the `toolName` the persisted
 * tool rows carry, the identifiers the sidechat tool builders register under
 * (DMT-21), and the keys later units derive the public toggles from (DMT-34;
 * the toggle keys land there, NOT here — the `sidechatOocToolSetSchema` stays
 * unchanged until the tools are finished). `as const` + derived types, never a
 * TS enum.
 */
export const DIRECTOR_MESSAGE_TOOLS = {
  proposeMessageEdit: "propose_message_edit",
  proposeMessageVariant: "propose_message_variant",
  requestMessageSwipe: "request_message_swipe",
} as const;

/** Every Director message tool name, in stable definition order. */
export const DIRECTOR_MESSAGE_TOOL_NAMES = [
  DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit,
  DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant,
  DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe,
] as const;

/** The wire name of one Director message tool. */
export type DirectorMessageToolName = (typeof DIRECTOR_MESSAGE_TOOL_NAMES)[number];

/**
 * The `recordType` values the two reviewable tools' proposals carry in the
 * ONE record-proposal registry (`sidechat-objective-proposal.ts`; DMT-22
 * registers the handlers). Kept beside the tools that produce them — a second
 * recordType list anywhere else is a defect from copy #2.
 */
export const DIRECTOR_MESSAGE_RECORD_TYPES = {
  messageEdit: "message-edit",
  messageVariant: "message-variant",
} as const;

/** The recordType of one Director message proposal. */
export type DirectorMessageRecordType =
  (typeof DIRECTOR_MESSAGE_RECORD_TYPES)[keyof typeof DIRECTOR_MESSAGE_RECORD_TYPES];

// ─── Shared field shapes ──────────────────────────────────────────────────────

/**
 * A reply's branch position — the existing number the frozen
 * `<rp_message position=…>` rows carry (the `sidechatPromptReadInputSchema`
 * convention: zero-based, the whole active branch).
 */
const branchPositionSchema = z
  .number()
  .int()
  .min(0)
  .describe("The reply's branch position — the number in <rp_message position=…>.");

/**
 * A swipe's number in the RP UI — the existing one-based `<variant number=…>`
 * value (`variantIndex + 1`, the `sidechatPromptReadInputSchema` convention).
 */
const variantNumberSchema = z
  .number()
  .int()
  .min(1)
  .describe("The swipe's number from <variant number=…> (one-based).");

/**
 * The Director's instruction text. Bound to the sidechat transport's existing
 * free-text limit (the ask answer's `text`: 1–50 000, the largest text the
 * stream endpoint already carries) — no invented limit.
 */
const directorInstructionSchema = z
  .string()
  .min(1)
  .max(50_000)
  .describe("The instruction text.");

/**
 * One frozen message/variant identity — resolved ONCE against the thread's
 * chat and branch, then stored immutably (the plan's ownership rule: never
 * retarget by the browser's active chat or a reused branch position at
 * confirmation time). `position`/`variantNumber` are display conveniences;
 * `messageId`/`variantId` are the identity the apply/save revalidates.
 */
export const directorMessageSourceIdentitySchema = z
  .object({
    messageId: z.string().min(1),
    variantId: z.string().min(1),
    position: branchPositionSchema,
    variantNumber: variantNumberSchema,
  })
  .strict();
export type DirectorMessageSourceIdentity = z.infer<typeof directorMessageSourceIdentitySchema>;

// ─── Tool input schemas (model-authored — lenient objects) ────────────────────

/**
 * Input of `propose_message_edit`: one source reply (a named swipe number, or
 * the currently selected swipe when omitted — the
 * `sidechatPromptReadInputSchema` convention) plus the correction instruction
 * the ordinary message editor will run with. The editor supplies the
 * candidate; this tool never applies anything itself.
 */
export const proposeMessageEditInputSchema = z.object({
  position: branchPositionSchema,
  variant: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The source swipe's number from <variant number=…>. Omit for the currently selected swipe."),
  instruction: directorInstructionSchema,
});
export type ProposeMessageEditInput = z.infer<typeof proposeMessageEditInputSchema>;

/**
 * Input of `propose_message_variant`: the source swipes the Director based
 * the text on (at least one — the persisted proposal freezes their identities;
 * NOT the merge tool's two-source minimum) and the COMPLETE new reply text.
 * No second LLM call happens behind this tool. Content bound mirrors the
 * ordinary add-variant request (`createMessageVariantSchema`: non-empty, no
 * invented cap).
 */
export const proposeMessageVariantInputSchema = z.object({
  position: branchPositionSchema,
  sourceVariants: z
    .array(variantNumberSchema)
    .min(1)
    .describe("The swipes' numbers from <variant number=…> this reply is based on."),
  content: z
    .string()
    .min(1)
    .describe("The complete alternative reply text, written by the Director itself."),
});
export type ProposeMessageVariantInput = z.infer<typeof proposeMessageVariantInputSchema>;

/**
 * Input of `request_message_swipe`: the target reply plus the DRAFT one-shot
 * instruction the user may inspect and edit before Allow. The instruction is
 * request-local (never a chat message, preset edit or persistent setting) and
 * the draft is not persisted anywhere except this permission marker.
 */
export const requestMessageSwipeInputSchema = z.object({
  position: branchPositionSchema,
  instruction: directorInstructionSchema,
});
export type RequestMessageSwipeInput = z.infer<typeof requestMessageSwipeInputSchema>;

// ─── Proposal payloads (the RecordProposal `payload` values) ──────────────────

/**
 * The `message-edit` proposal payload: the frozen source identity and the
 * exact base text the user's diff is drawn against, the Director's
 * instruction, the editor's candidate, and the editor's ACTUAL provenance
 * (the model/finish metadata the ordinary editor generation reported — the
 * same fields `AddEditorVariantInput` persists for editor variants). Apply
 * runs the guarded edit against this source; Reject changes only the proposal
 * status.
 */
export const directorMessageEditProposalSchema = z
  .object({
    source: directorMessageSourceIdentitySchema,
    sourceText: z.string().min(1),
    instruction: directorInstructionSchema,
    candidate: z
      .string()
      .min(1)
      .describe("The editor's proposed replacement text (a delegate with empty output is a failure, never a proposal)."),
    editor: z
      .object({
        modelId: z.string().min(1),
        presetName: z.string().optional(),
        finishReason: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type DirectorMessageEditProposal = z.infer<typeof directorMessageEditProposalSchema>;

/**
 * The `message-variant` proposal payload: the frozen identities of the source
 * swipes the text is based on plus the complete Director-written candidate.
 * Save appends/selects a separate swipe through the ordinary add-variant path
 * and records DIRECTOR authorship (never RP-model or preset provenance).
 */
export const directorMessageVariantProposalSchema = z
  .object({
    sources: z.array(directorMessageSourceIdentitySchema).min(1),
    content: z.string().min(1),
  })
  .strict();
export type DirectorMessageVariantProposal = z.infer<typeof directorMessageVariantProposalSchema>;

// ─── Swipe permission marker/receipt (the persisted tool-row outputs) ─────────

/**
 * The awaiting marker `request_message_swipe` returns (the split-turn
 * mechanism stops the turn on it): the frozen target identity, the reply
 * identification the card renders (`replyFirstLine` + `variantNumber`, the
 * prompt-read marker's convention) and the PROPOSED instruction in full. The
 * top-level `status` literal is the vocabulary
 * `agent-split-turn.ts` dispatches on — never nest it.
 */
export const directorSwipePermissionMarkerSchema = z
  .object({
    status: z.literal("awaiting_permission"),
    messageId: z.string().min(1),
    variantId: z.string().min(1),
    position: branchPositionSchema,
    variantNumber: variantNumberSchema,
    replyFirstLine: z.string().min(1),
    instruction: directorInstructionSchema,
  })
  .strict();
export type DirectorSwipePermissionMarker = z.infer<typeof directorSwipePermissionMarkerSchema>;

/**
 * The granted receipt (the allow path's stored output): the frozen target
 * identity plus the FINAL USER-APPROVED instruction text — the user-edited
 * text when the user changed the draft, the recorded draft otherwise (DMT-23).
 * This is the text exactly one RP regeneration runs with; it is inspectable
 * in the receipt and the generation trace and is never picked up by another
 * generation.
 */
export const directorSwipeGrantedReceiptSchema = z
  .object({
    status: z.literal("granted"),
    messageId: z.string().min(1),
    variantId: z.string().min(1),
    position: branchPositionSchema,
    variantNumber: variantNumberSchema,
    replyFirstLine: z.string().min(1),
    instruction: directorInstructionSchema,
  })
  .strict();
export type DirectorSwipeGrantedReceipt = z.infer<typeof directorSwipeGrantedReceiptSchema>;

/**
 * The denied receipt — exactly the `{ status: "denied" }` rewrite the
 * split-turn mechanism pins for every deny answer (the prompt-read precedent:
 * the card shows the resolved label; the family identity comes from the row's
 * `toolName`, never from the receipt body). Reject makes no RP generation and
 * mutates no message.
 */
export const directorSwipeDeniedReceiptSchema = z
  .object({
    status: z.literal("denied"),
  })
  .strict();
export type DirectorSwipeDeniedReceipt = z.infer<typeof directorSwipeDeniedReceiptSchema>;

/** Every persisted output one `request_message_swipe` row can carry. */
export const directorSwipeToolOutputSchema = z.union([
  directorSwipePermissionMarkerSchema,
  directorSwipeGrantedReceiptSchema,
  directorSwipeDeniedReceiptSchema,
]);
export type DirectorSwipeToolOutput = z.infer<typeof directorSwipeToolOutputSchema>;

// ─── The swipe run outcome + its answer-stream frame (DMT-24b) ────────────────

/**
 * The canonical outcome of the ONE approved swipe regeneration — what an
 * ordinary branch-pinned RP regeneration produces (the DMT-24 delegate's
 * return; the backend domain consumes THIS schema as its source — one
 * derivation, no second union). Provider-grade failures are absorbed by the
 * adapter into `failed`/`cancelled` so the permission decision stays durable;
 * a provider that produced no text appends no variant (`no_output`).
 */
export const directorSwipeRunOutcomeSchema = z.union([
  z
    .object({
      status: z.literal("completed"),
      messageId: z.string().min(1),
      variantId: z.string().min(1),
      traceId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("no_output"),
      messageId: z.string().min(1),
    })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type DirectorSwipeRunOutcome = z.infer<typeof directorSwipeRunOutcomeSchema>;

/**
 * The SSE event name of the swipe-run outcome frame (DMT-24b): the
 * non-fatal tail frame the sidechat ANSWER stream emits after its turn
 * completes when an allowed swipe's absorbed run outcome was not
 * `completed`. The web's ONE shared SSE parser forwards it and the live
 * answer path toasts the failure — the established generation-failure
 * scheme (owner ruling 2026-11-06). A frame never fails the answer turn:
 * the decision was accepted, the receipt stored; only the generation
 * outcome is carried.
 */
export const DIRECTOR_SWIPE_RUN_OUTCOME_SSE_EVENT = "swipe-run-outcome" as const;

/**
 * The outcome frame's data payload: the answered permission row's
 * `toolCallId` (correlation for consumers and the run-event replay) plus the
 * run outcome verbatim. Server-authored state — `.strict()`.
 */
export const directorSwipeRunOutcomeFrameSchema = z
  .object({
    toolCallId: z.string().min(1),
    outcome: directorSwipeRunOutcomeSchema,
  })
  .strict();
export type DirectorSwipeRunOutcomeFrame = z.infer<typeof directorSwipeRunOutcomeFrameSchema>;
