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
import { agentReviewSnapshotSchema } from "./agent-review-snapshot.js";
import { experiencePlaygroundStartRequestSchema } from "./interactive-schema.js";

/**
 * Which buffer a copilot proposed edit lands on. Drives which editor surface
 * shows the diff (the rules editor vs the visual editor). Mirrors
 * `CoauthorTarget` ("profile" | "greeting") for the two co-author surfaces.
 * AS-8b adds `"code"` — the script kind's single buffer (its `write_buffer`/
 * `edit_buffer` results carry `target: "code"`); the experience kind never
 * emits it, so the union only grows for the kind that uses it.
 */
export const experienceCopilotTargetSchema = z.enum(["rules", "visual", "code"]);
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
 * Answer payload for a pending `ask_user` question (TAG-5 split-turn, style
 * B). `text` = the user's answer (a tapped chip's label or free text);
 * `skipped` = the user pressed skip. The two are mutually exclusive: a skip
 * carries no text, and an answer with neither is meaningless — both are
 * rejected here. The referenced `toolCallId` must point at an `ask_user`
 * tool-result row that is still awaiting an answer in THIS thread; that is
 * thread state, so it is enforced by the stream (domain), not by the schema.
 */
const experienceCopilotAskAnswerSchema = z
  .object({
    toolCallId: z.string().min(1),
    text: z.string().min(1).max(50_000).optional(),
    skipped: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.skipped === true && val.text !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["skipped"],
        message: "A skipped answer cannot carry text.",
      });
    }
    if (val.skipped === undefined && val.text === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "An answer must carry either `text` or `skipped`.",
      });
    }
  });
export type ExperienceCopilotStreamAskAnswer = z.infer<typeof experienceCopilotAskAnswerSchema>;

/**
 * Permission decision for a pending wait-tool request (SC-23e split-turn):
 * `decision: "allow"` = the user lets the model read the material the tool
 * asked about (the kind re-runs the tool's granted execution and stores its
 * real result); `decision: "deny"` = the user refuses (the row stores the
 * denied marker and the turn continues without the material). Carries
 * NEITHER `text` NOR `skipped` — those belong to the ask family, and the
 * `.strict()` member rejects them here. The `toolCallId` must point at a
 * still-awaiting permission marker row in THIS thread (thread state —
 * enforced by the stream, not the schema).
 */
export const experienceCopilotStreamPermissionAnswerSchema = z
  .object({
    toolCallId: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
  })
  .strict();
export type ExperienceCopilotStreamPermissionAnswer = z.infer<
  typeof experienceCopilotStreamPermissionAnswerSchema
>;

/**
 * Answer to a pending wait-tool request — a DISCRIMINATED-BY-SHAPE union of
 * the two split-turn families: the `ask_user` answer (TAG-5, `text`/
 * `skipped`) and the permission decision (SC-23e, `decision`). The
 * permission member is tried FIRST: an ask body has no `decision` field and
 * falls through to the ask member unchanged, while a permission body's
 * `decision` key would be rejected by the ask member's `.strict()` anyway —
 * so every valid body of either family parses to exactly one member and the
 * ask family's validation is byte-identical for its own bodies.
 */
export const experienceCopilotStreamAnswerSchema = z.union([
  experienceCopilotStreamPermissionAnswerSchema,
  experienceCopilotAskAnswerSchema,
]);
export type ExperienceCopilotStreamAnswer = z.infer<typeof experienceCopilotStreamAnswerSchema>;

/** The Try sandbox context copied into copilot test and validation tools. The
 * participant/grant/seed/seat fields reuse the playground-start wire schemas so
 * the two execution paths cannot drift into separate roster contracts. */
export const experienceCopilotLaunchContextSchema = z.object({
  participants: experiencePlaygroundStartRequestSchema.shape.participants,
  capabilityGrants: experiencePlaygroundStartRequestSchema.shape.capabilityGrants,
  settings: z.record(z.string(), z.unknown()).optional(),
  seed: experiencePlaygroundStartRequestSchema.shape.seed,
  humanSeatId: experiencePlaygroundStartRequestSchema.shape.humanSeatId,
}).strict();
export type ExperienceCopilotLaunchContext = z.infer<typeof experienceCopilotLaunchContextSchema>;

/**
 * Request body for the experience-copilot stream endpoint (ER-6),
 * `POST /api/experience-copilot/:threadId/stream`. Mirrors the AI-assistant's
 * `{ providerProfileId, model }` resolution shape, plus the copilot-specific
 * `content` (the user's message), an optional `step`/`testFeedback`, and the
 * live `rules`/`visual` draft buffers the model should see (the editor sends
 * the current unsaved source so the copilot is never blind to in-progress
 * edits — the backend prefers these over the last-persisted buffers). The
 * thread id is a path param, not a body field. `testFeedback` is a free-form
 * passthrough of the latest test/simulate digest the user sent back from the
 * test panel (ER-5 renders it as context) — it is validated as a record, not
 * a typed digest, because the digest shapes live in the backend domain
 * (`experience-copilot-tools.ts`) and ER-7 will lift them into wire contracts.
 *
 * TAG-5 split-turn (style B): `content` and `answer` are exactly-one-of. A
 * normal turn sends `content`; answering a pending wait-tool request sends
 * `answer` instead (no new user row — the answer replaces the awaiting marker
 * of the referenced tool-result and the turn resumes as a continuation:
 * an `ask_user` answer since TAG-5, a permission decision since SC-23e).
 * AP-9 (AGENT_SHELL_POLISH Wave 3) adds `regenerate` as the THIRD exclusive
 * mode: rerun the last turn without a new user row — the server deletes the
 * rows after the thread's last user row (the replaced turn's own rows,
 * through the AP-8 turn-delete store) and runs the turn against the surviving
 * thread state. Exactly one of the three modes must be present; an explicit
 * `regenerate: false` counts as the absent mode (a client sending the flag
 * alongside `content` stays a content turn).
 */
export const experienceCopilotStreamRequestSchema = z
  .object({
    content: z.string().min(1).max(50_000).optional(),
    providerProfileId: z.string().min(1),
    model: z.string().min(1).optional(),
    step: experienceCopilotStepSchema.optional(),
    rules: z.string().max(200_000).optional(),
    visual: z.string().max(200_000).optional(),
    // AS-8b — the script kind's live-buffer fields. `code` is the LIVE editor
    // buffer (never a stale DB read — the model must see the user's unsaved
    // edits, exactly like `rules`/`visual` for the experience kind);
    // `scriptKind` is ADVISORY telemetry (the STORED script kind is the
    // authoritative selector for the API-knowledge section — immutable after
    // creation, so a mismatching advisory is ignored, never fatal);
    // `codeSaved` mirrors `rulesSaved`/`visualSaved`.
    code: z.string().max(200_000).optional(),
    scriptKind: z.enum(["prompt", "dice"]).optional(),
    codeSaved: z.boolean().optional(),
    // AS-8e1 — the script kind's build-panel context (the same ids the old
    // modal's scopeContext carried): the character and persona open in the
    // editor when the turn was sent. The script kind renders their full cards
    // into the context package; the experience kind ignores both fields.
    contextCharacterId: z.string().min(1).optional(),
    contextPersonaId: z.string().min(1).optional(),
    testFeedback: z.record(z.string(), z.unknown()).nullable().optional(),
    launchContext: experienceCopilotLaunchContextSchema.optional(),
    answer: experienceCopilotStreamAnswerSchema.optional(),
    // AP-9 — regenerate mode: rerun the last turn with NO new user row (the
    // server deletes the replaced turn's rows through the AP-8 store sibling
    // and streams the replacement). Exactly-one-of with `content`/`answer`
    // (the refine below); an explicit `false` is the absent mode.
    regenerate: z.boolean().optional(),
    // SC-17 — the "discuss in the sidechat" server side: RP variants attached to
    // this sidechat turn, as plain (messageId, variantId) pairs — nothing
    // else. The pair schema is `.strict()` on purpose: the request NEVER
    // carries a `selected` marker, because the server reads the RP's own
    // selection (`message_variants.is_selected`) at freeze time — a stale
    // tab must not freeze a wrong marker. The array carries no length cap
    // (SC-21b, owner review 2026-10-21: a bound here would be invented
    // provenance — no owner decision ever set one). Only the `sidechat-ooc`
    // kind reads the field; the other kinds ignore it entirely (SC-17's
    // plan row).
    attachedVariants: z
      .array(z.object({ messageId: z.string().min(1), variantId: z.string().min(1) }).strict())
      .optional(),
    reviewSnapshot: agentReviewSnapshotSchema.optional(),
    rulesSaved: z.boolean().optional(),
    visualSaved: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    // AP-9: THREE exclusive modes — content (a new message), answer
    // (answering the pending question), regenerate (rerunning the last
    // turn). Exactly one must be present; `regenerate: false` counts as
    // absent (an explicit false never turns a content turn into a pair).
    const present: string[] = [];
    if (val.content !== undefined) present.push("`content`");
    if (val.answer !== undefined) present.push("`answer`");
    if (val.regenerate === true) present.push("`regenerate`");
    if (present.length > 1) {
      ctx.addIssue({
        code: "custom",
        message:
          `Provide only one turn mode — got ${present.join(" + ")}; \`content\` (a new message), ` +
          "`answer` (answering the pending question), and `regenerate` (rerunning the last turn) " +
          "are mutually exclusive.",
      });
    }
    if (present.length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide either `content` (a new message), `answer` (answering the pending question), or `regenerate` (rerunning the last turn).",
      });
    }
  });
export type ExperienceCopilotStreamRequest = z.infer<typeof experienceCopilotStreamRequestSchema>;

/**
 * Segmented context-usage metrics for a copilot thread (CM-1). The meter draws
 * three segments (system / digest / history) against `budgetTokens`, with the
 * response reserve zone marked at the tail. Every field is a plain integer:
 * when the effective provider profile has no explicit context budget
 * (`contextBudget: null`), `budgetTokens` is `0` (the meter renders an unmetered
 * bar — the frontend, Wave 3, decides how to draw that). `source` records
 * whether `totalTokens` came from the provider's actual `usage.inputTokens`
 * ("provider") or the assembler's local estimate ("estimate") — metrics honesty:
 * never blend the two and claim it was measured. Per-segment values
 * (`systemTokens`/`digestTokens`/`historyTokens`) are always the assembler's
 * estimate (the provider only reports an aggregate). `.strict()` rejects unknown
 * keys so a client/server typo cannot silently widen the shape.
 *
 * SC-0j: `segments` is the OPTIONAL kind-provided breakdown. Absent = the
 * fixed system/digest/history breakdown above (every existing consumer stays
 * valid); present = the kind's own token sections, rendered by
 * `AgentContextMeter` with labels from the host descriptor's
 * `meterSegmentLabels`. No producer emits it yet (the first consumer is the
 * sidechat kind, Wave 1) — the server never sends it.
 */
export const experienceCopilotContextMetricsSchema = z
  .object({
    systemTokens: z.number().int(),
    digestTokens: z.number().int(),
    historyTokens: z.number().int(),
    /** SC-0j: kind-provided meter segments (`{ key, tokens }` per section).
     *  Optional so existing producers/consumers that ignore it stay valid. */
    segments: z
      .array(
        z
          .object({
            key: z.string().min(1),
            tokens: z.number().int(),
          })
          .strict(),
      )
      .optional(),
    /** Tokens of the pinned-context attached block + recency anchor (CX-1,
     *  additive). Rows written before this plan lack the field — the DB parse
     *  guard defaults it to 0, so the wire can require it unconditionally. */
    attachedTokens: z.number().int(),
    totalTokens: z.number().int(),
    budgetTokens: z.number().int(),
    reserveTokens: z.number().int(),
    source: z.enum(["estimate", "provider"]),
    measuredAt: z.string(),
  })
  .strict();
export type ExperienceCopilotContextMetrics = z.infer<typeof experienceCopilotContextMetricsSchema>;

/** Pinned-context target types the copilot picker offers (CX-1). Mirrors the
 *  Co-Author CE-C1 set plus `skill` — skills are filesystem-scanned (id = the
 *  skill directory name), and pinning one eagerly injects its `SKILL.md` body
 *  (user decision 2026-08-18; `read_skill_file` stays for on-demand assets).
 *  `prompt_preset` (SC-23c) is the sidechat's RP-prompt discussion pin: a
 *  CHAT-OWNED-thread-only link (the set-links path rejects it on a script or
 *  draft thread with the typed 400 `preset_link_not_chat_owned`) that never
 *  resolves through the generic pinned-context loader — the sidechat context
 *  loader renders it as the `<rp_prompt>` view (rp-prompt-view.ts) instead. */
export const experienceCopilotContextTargetTypeSchema = z.enum([
  "character",
  "persona",
  "lorebook",
  "script",
  "skill",
  "prompt_preset",
]);
export type ExperienceCopilotContextTargetType = z.infer<typeof experienceCopilotContextTargetTypeSchema>;

/** One pinned-context link on a copilot thread: resolved by id at ASSEMBLY
 *  time (never a stored copy), so dangling ids (deleted entities) are skipped
 *  silently at the next turn — mirroring the co-author context-link loader. */
export const experienceCopilotContextLinkSchema = z
  .object({
    targetType: experienceCopilotContextTargetTypeSchema,
    targetId: z.string().min(1).max(200),
  })
  .strict();
export type ExperienceCopilotContextLink = z.infer<typeof experienceCopilotContextLinkSchema>;

/** Body for `PATCH /api/experience-copilot/:threadId/context-links` (CX-1): a
 *  full replace of the thread's pinned-context set (the client sends the whole
 *  array; add/remove are computed client-side). The array carries no length
 *  cap (SC-21b, owner review 2026-10-21): the dropped bound claimed to mirror
 *  the co-author's, but the co-author's schema has none — invented
 *  provenance. */
export const setCopilotContextLinksSchema = z
  .object({
    links: z.array(experienceCopilotContextLinkSchema),
  })
  .strict();
export type SetCopilotContextLinksRequest = z.infer<typeof setCopilotContextLinksSchema>;

// ─── Copilot todo (EXPERIENCE_COPILOT_TODO_ASK_GRILL_PLAN, TAG-1) ───────────

/**
 * One step in the copilot's todo list (TAG-1). The `todo` tool (Wave 2) has
 * the model maintain a quick session-scoped checklist for the authoring
 * thread via full-list rewrites; the list persists on the thread row
 * (`todo_json`, TAG-2). PM-7 (owner ruling 2026-10-11) restored the mechanic
 * to live BESIDE the script-owned agent plan: todo = the thread's session
 * (small tasks), plan = the script's durable document. The four statuses
 * mirror the objective tracker's `objectiveTaskStatusSchema`
 * (insights-schema.ts) — a deliberate match so the pinned panel (TAG-8)
 * reuses the tracker's visual language (`NodeGlyph`, `statusClass`)
 * unchanged. `.strict()` rejects unknown keys: a model-authored list must
 * not smuggle extra fields through persistence.
 */
export const copilotTodoItemSchema = z
  .object({
    title: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "completed", "abandoned"]),
  })
  .strict();
export type CopilotTodoItem = z.infer<typeof copilotTodoItemSchema>;

/**
 * A complete todo list as the `todo` tool sends it (rewrite semantics — every
 * call carries the FULL list, never a delta; Cline-style). The cap is a
 * pragmatic bound: room for a real working checklist, bounded cost for the
 * pinned panel render.
 */
export const copilotTodoListSchema = z.array(copilotTodoItemSchema).max(30);
export type CopilotTodoList = z.infer<typeof copilotTodoListSchema>;

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
  /** Nullable context metrics (null until the thread's first turn reports
   *  usage). Mirrors the store's parsed `contextMetrics` (CM-2). */
  metrics: experienceCopilotContextMetricsSchema.nullable(),
  /** Pinned-context links (CX-1): resolved fresh at assembly time; dangling
   *  ids are skipped silently. Empty array = nothing pinned (the zero-pinned
   *  assembly stays byte-identical to the pre-plan output). */
  contextLinks: z.array(experienceCopilotContextLinkSchema),
  /** The model's session-scoped checklist (TAG-6, restored PM-7): `[]` until
   * the first `todo` call, then the full-list rewrite the tool persists every
   * call. Mirrors the store's parsed `todo` (TAG-2). REQUIRED (always
   * present, empty = no checklist yet) so the client never has to
   * null-check — the adapter maps the store row's todo into this field on
   * every thread read. The DURABLE plan is separate: script-owned
   * (`agent_plans`), served by GET/PUT `/api/scripts/:scriptId/agent-plan`. */
  todo: z.array(copilotTodoItemSchema),
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
  // Free-text role mirroring the store column. The value `"digest"` marks a
  // compaction digest message (CM-3): it is lifted out of the history flow by
  // the prompt assembler (the LAST digest becomes a system-level JSON context
  // section; older digests are dropped) and rendered by the frontend as a
  // collapsed «Context compacted» card (CM-9). No migration is needed for the
  // digest itself — it is just another role value.
  role: z.string(),
  content: z.string(),
  toolCallsJson: z.string().nullable(),
  toolCallId: z.string().nullable(),
  // AP-28 (AGENT_SHELL_POLISH): the turn's reasoning + its summed per-burst
  // duration, persisted onto the FIRST assistant row of the turn; null on
  // every other row, on turns without reasoning, and on rows written before
  // the column existed. Display-only — never sent back to the model.
  reasoning: z.string().nullable(),
  reasoningDurationMs: z.number().nullable(),
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

// ─── Copilot profiles (EXPERIENCE_COPILOT_PROFILES_PLAN, CP-1) ────────────────
// A configurable, reusable copilot "personality" (system prompt + skills + tool
// toggles + turn budget), mirroring Co-Author's module system. Unlike a
// co-author module, a copilot profile has NO `description` and NO
// `openingMessage` — the copilot is not a chat-mode and does not greet.

/**
 * Which tools a profile may toggle. A PARTIAL record over exactly the 9
 * toggleable copilot tools (write_buffer, edit_buffer, run_test, run_simulate,
 * suggest_visual_binding, plan, read_plan, todo, ask_user). `todo` was
 * restored as a real key in PM-7 (owner ruling 2026-10-11): it is the
 * session-scoped quick checklist living beside the script-owned plan, and a
 * stored `todo: true` projects to `todo: true` and nothing else (no alias).
 * `read_skill_file` is intentionally ABSENT — it is
 * the always-on, read-only skill-access channel and is never gated by a
 * toolSet (mirroring Co-Author's `coauthorToolSetSchema`, which excludes
 * `read_skill_file` for the same reason). `.strict()` rejects any unknown key
 * — including `read_skill_file` — rather than silently stripping it, so a
 * client typo cannot silently disable/enable the wrong surface.
 */
export const copilotToolSetSchema = z
  .object({
    write_buffer: z.boolean().optional(),
    edit_buffer: z.boolean().optional(),
    run_test: z.boolean().optional(),
    run_simulate: z.boolean().optional(),
    suggest_visual_binding: z.boolean().optional(),
    plan: z.boolean().optional(),
    read_plan: z.boolean().optional(),
    todo: z.boolean().optional(),
    ask_user: z.boolean().optional(),
  })
  .strict();

export type CopilotToolSet = z.infer<typeof copilotToolSetSchema>;

/**
 * Which tools a SCRIPT-kind agent profile may toggle (AGENT_SHELL_PLAN AS-7).
 * A PARTIAL record over exactly the 6 toggleable script-agent tools
 * (write_buffer, edit_buffer, run_script_test, plan, read_plan, ask_user) —
 * the same convention as {@link copilotToolSetSchema}: `read_skill_file` is
 * intentionally absent (always-on, read-only skill channel, never gated), and
 * there is no `todo` (the script kind wires no thread-session checklist).
 * `.strict()` rejects any unknown key — including experience-only keys like
 * `run_test` — so a profile cannot silently carry another kind's tools on the
 * wire; the adapter additionally re-validates against the kind's REGISTERED
 * schema (`copilot_profile_invalid_tool_set`), which stays the enforcement
 * seam for cross-kind sets that pass this union.
 */
export const scriptAgentToolSetSchema = z
  .object({
    write_buffer: z.boolean().optional(),
    edit_buffer: z.boolean().optional(),
    run_script_test: z.boolean().optional(),
    plan: z.boolean().optional(),
    read_plan: z.boolean().optional(),
    ask_user: z.boolean().optional(),
  })
  .strict();

export type ScriptAgentToolSet = z.infer<typeof scriptAgentToolSetSchema>;

/**
 * Every tool a script-agent profile may toggle, in stable definition order.
 * Derived from {@link scriptAgentToolSetSchema} exactly the way
 * {@link COPILOT_TOOL_KEYS} derives from `copilotToolSetSchema` (the wire
 * contract is the single source of truth for toggleable-tool names).
 * `read_skill_file` is intentionally absent (always-on).
 */
export const SCRIPT_AGENT_TOOL_KEYS = Object.keys(
  scriptAgentToolSetSchema.shape,
) as (keyof ScriptAgentToolSet)[];

/**
 * Which tools a `sidechat-ooc` agent profile may toggle (SIDECHAT_PLAN,
 * Wave 1 / SC-5). A PARTIAL record over exactly the 6 toggleable sidechat
 * tools (search_context, read_context_item, propose_objective, todo,
 * read_plan, read_message_prompt) — the same convention as
 * {@link copilotToolSetSchema} and
 * {@link scriptAgentToolSetSchema}: tool sets store only ENABLED keys, so a
 * tool that is not yet served is simply absent from every set. The keys
 * exist on the wire BEFORE their tools (the TAG-1 pattern: the schema
 * declares the toggleable-tool space, `todo`/`ask_user` landed the same way
 * ahead of their implementations) because the tools arrive in later waves
 * and flip on one by one — until then a stored `true` is inert (the stream
 * serves no tools, `buildTools` returns the empty set). `.strict()` rejects
 * any unknown key — including the other kinds' keys — so a profile cannot
 * silently carry another kind's tools on the wire; the adapter additionally
 * re-validates against the kind's REGISTERED schema
 * (`copilot_profile_invalid_tool_set`).
 */
export const sidechatOocToolSetSchema = z
  .object({
    search_context: z.boolean().optional(),
    read_context_item: z.boolean().optional(),
    propose_objective: z.boolean().optional(),
    todo: z.boolean().optional(),
    read_plan: z.boolean().optional(),
    read_message_prompt: z.boolean().optional(),
  })
  .strict();

export type SidechatOocToolSet = z.infer<typeof sidechatOocToolSetSchema>;

/**
 * Every tool a sidechat-ooc profile may toggle, in stable definition order.
 * Derived from {@link sidechatOocToolSetSchema} exactly the way
 * {@link SCRIPT_AGENT_TOOL_KEYS} derives from `scriptAgentToolSetSchema`
 * (the wire contract is the single source of truth for toggleable-tool
 * names — the kind's default set and builtin seed project through this, and
 * Wave 3 flips each key on by enabling it in the kind's declarative set).
 */
export const SIDECHAT_OOC_TOOL_KEYS = Object.keys(
  sidechatOocToolSetSchema.shape,
) as (keyof SidechatOocToolSet)[];

/**
 * The tool set a copilot/agent profile may carry ACROSS kinds: the experience
 * record, the script record, or the sidechat record (a union — a set valid
 * for any kind passes; a set mixing keys from several kinds, or carrying an
 * unknown key, fails EVERY member and is rejected). Per-kind enforcement (a
 * sidechat profile may not carry experience keys and vice versa) lives with
 * the kind's REGISTERED schema in the profile adapter, which knows the
 * profile's `agentKind`.
 */
export const agentToolSetSchema = z.union([
  copilotToolSetSchema,
  scriptAgentToolSetSchema,
  sidechatOocToolSetSchema,
]);
export type AgentToolSet = CopilotToolSet | ScriptAgentToolSet | SidechatOocToolSet;

/**
 * Every tool a profile may toggle, in stable definition order. Derived from
 * `copilotToolSetSchema` so the wire contract is the single source of truth
 * (the profile editor's toggle list reads this — no parallel hardcoded array
 * to drift out of sync). `read_skill_file` is intentionally absent (always-on).
 */
export const COPILOT_TOOL_KEYS = Object.keys(copilotToolSetSchema.shape) as (keyof CopilotToolSet)[];

/**
 * A resolved copilot profile as served to the client / consumed by the prompt
 * assembler. `basePrompt` is INLINE prompt text (not a file reference): the
 * built-in seed loads its `.md` at resolve time, user profiles store text
 * directly in the DB. `isBuiltIn` marks the read-only "Experience Authoring"
 * seed (users only edit their own copies). Leaner than `CoauthorModule` — no
 * `description`, no `openingMessage`. No `maxSteps`: the tool-loop bound was
 * removed by user decision (TAG-4 → TAG-10) — the loop runs unbounded to
 * `COPILOT_TOOL_LOOP_CEILING`, and the DB `copilot_profiles.max_steps` column
 * was dropped in TAG-4b. No `skillIds` either (PM-8, owner ruling
 * 2026-10-12): the skill catalog is UNGATED like Co-Author's — the catalog
 * carries only id + one-line description (progressive disclosure), so listing
 * every scanned skill is free; profiles are `basePrompt` + `toolSet` only.
 * `.strict()` rejects unknown keys — including a retired `skillIds` — so a
 * stale client cannot smuggle the retired field back in.
 */
export const copilotProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    isBuiltIn: z.boolean(),
    basePrompt: z.string().min(1),
    // AS-7: the union of per-kind tool-set records — which keys a profile may
    // toggle depends on its `agentKind` (experience, script, or sidechat-ooc).
    toolSet: agentToolSetSchema,
    // AS-3: owning agent kind ('experience' for every pre-AS-3 profile).
    // Required on the wire profile — the server always emits it (seed and
    // rows alike) so a list consumer can tell kinds apart.
    agentKind: z.string().min(1),
  })
  .strict();

export type CopilotProfile = z.infer<typeof copilotProfileSchema>;

export const copilotProfileListSchema = z.array(copilotProfileSchema);

/**
 * Input for creating a user profile. `id` is assigned by the store; `isBuiltIn`
 * is always `false` for user-created profiles (enforced server-side, never
 * accepted from the client). Leaner than `CoauthorModuleCreate` — no
 * `description`, no `openingMessage`, and no `skillIds` (PM-8: skills are
 * ungated, so there is nothing to pick). `.strict()` rejects unknown keys.
 */
export const copilotProfileCreateSchema = z
  .object({
    name: z.string().min(1),
    basePrompt: z.string().min(1),
    // AS-7: per-kind tool-set records (union) — the adapter validates the set
    // against the OWNING kind's registered schema (sidechat keys: SC-5).
    toolSet: agentToolSetSchema,
    // AS-3: optional with an 'experience' default so the current web client
    // (which sends no kind) keeps creating experience profiles untouched.
    agentKind: z.string().min(1).optional().default("experience"),
  })
  .strict();

export type CopilotProfileCreate = z.input<typeof copilotProfileCreateSchema>;

/**
 * Partial update for a user profile. Every field is optional. `agentKind` is
 * OMITTED (not merely optional) — the kind is immutable after create, and
 * the object stays `.strict()`, so a PATCH smuggling an `agentKind` key is
 * rejected with a 400 instead of being silently stripped. A wrong-kind
 * profile is recreated under the right kind, never converted.
 */
export const copilotProfileUpdateSchema = copilotProfileCreateSchema.omit({ agentKind: true }).partial();

export type CopilotProfileUpdate = z.infer<typeof copilotProfileUpdateSchema>;
