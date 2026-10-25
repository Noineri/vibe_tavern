import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getT } from "../../../i18n/locale-helpers.js";
import { copilotTurnFailureOf, useAgentTurnActions, type AgentPendingAskAnswer, type AgentPendingPermissionAnswer, type AgentTurnActions, type AgentTurnFailure } from "./use-agent-turn-actions.js";
import {
  agentThreadKey,
  type AgentHostTransport,
  type AgentKind,
  type AgentSendOptions,
  type CopilotAnswerInput,
  type CopilotStreamOpts,
} from "../../../lib/agent-host-registry.js";
import {
  useAgentTurnStore,
  parseTodoToolResult,
  parseTodoToolArgs,
  parseAgentAskState,
  parseAgentPermissionState,
} from "../../../stores/agent-turn-store.js";
import { parseAgentPlanToolResult } from "../../../hooks/use-agent-plan.js";
import { toSendAttachment } from "../../../lib/send-attachments.js";
import type { Attachment } from "@vibe-tavern/domain";
import {
  coauthorSkillReadOutputSchema,
  experienceCopilotToolOutputSchema,
  experienceCopilotContextMetricsSchema,
  type ExperienceCopilotContextMetrics,
  type CopilotTodoItem,
  type ExperienceCopilotMessageWire,
} from "@vibe-tavern/api-contracts";


/**
 * Experience-Copilot send/stream controller (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 4 / ER-11b).
 *
 * The copilot has its own transport (AS-6c-i: injected through args — the
 * host descriptor's `transport`, mirroring the ER-10 stream client) and its
 * own turn store (`useAgentTurnStore`, ER-8), so it cannot reuse
 * the RP-chat `useChatController`. This hook ports the stream half of
 * `executeStreamAction`, retargeted and simplified: the copilot is stream-only,
 * with no dice/attachments/variants/regenerate/non-stream/insights and no
 * StreamingReveal — `pendingText` is a plain accumulated string.
 *
 * State is LOCAL (no new Zustand store): the copilot editor shell owns a single
 * controller instance and threads values down via props/context (ER-11c/11d).
 * The hook feeds the ER-8 turn store from the SSE tool events (exactly what the
 * shell renders as activity cards) and signals `onTurnSettled` so the shell can
 * refetch persisted messages once a turn settles.
 */

export interface UseAgentControllerArgs {
  /** AS-6c-ii: the host kind driving this controller (required, no default
   *  — the shell passes what it got). Used for store keys ONLY (through
   *  `agentThreadKey`); the transport stays host-injected and kind-free. */
  kind: AgentKind;
  /** AS-6c-i: the host descriptor's transport — the send path's ONLY API
   *  seam (stream + ask-answer); the shell passes `getAgentHost(kind).transport`.
   *  Typed through the registry so this module imports no kind-specific
   *  client. */
  transport: AgentHostTransport;
  threadId: string | null;
  providerProfileId: string | null;
  model?: string;
  /** Called after a turn settles (done/cancelled/failed) so the shell can refetch persisted messages.
   *  SC-18: carries whether the stream COMPLETED (`true`) or failed/was
   *  cancelled (`false`) — the shell's host hook clears per-turn
   *  attachments on success and keeps them for a retry on failure. */
  onTurnSettled?: (ok: boolean) => void;
  /** CM-7: feed the segmented context metrics from the `finish` SSE event to
   *  the shell's meter immediately (before any context refetch round-trips).
   *  Null when the finish event carried no/ill-formed metrics. */
  onMetrics?: (metrics: ExperienceCopilotContextMetrics | null) => void;
  /** PM-6 (EXPERIENCE_COPILOT_PLAN_MODE_PLAN): the shell's `useAgentPlan`
   *  applyToolResult. A `plan` tool result routes its carrier args + result
   *  envelope here; the hook replaces the script-owned plan cache when both
   *  parse (a confirmed full-plan rewrite — no optimistic args-only update,
   *  by the hook's design). */
  applyPlanToolResult?: (args: unknown, output: unknown) => void;
  /** TAG-7 (restored PM-7): the current thread wire's `todo` (the durable
   *  `todo_json` truth — the session checklist that lives BESIDE the plan).
   *  Seeds/resets the session-scoped live todo panel state on mount, thread
   *  switch, and every thread refetch that produces a new array; live `todo`
 *  tool events upsert on top between refetches. Omitted (undefined) leaves
   *  the store untouched — the shell wires this to `thread.todo`. */
  threadTodo?: readonly CopilotTodoItem[];
  /** AP-10: the shell's CURRENT persisted messages for the thread (the
   *  message list, fresh every render). `handleEditLast` resolves the last
   *  user row's id from THIS list — controller state (the `threadTodo`
   *  pattern above), never a fetch. Omitted (undefined) leaves edit-last
   *  without a resolvable target — the shell wires this to `messages`. */
  threadMessages?: ExperienceCopilotMessageWire[];
}

/** AS-6c-ii: re-exported from the host registry (which owns the type —
 *  lib importing a components module is banned). Kept here so existing
 *  importers (`AgentShell`, the experience host) keep compiling. */
export type { AgentSendOptions } from "../../../lib/agent-host-registry.js";

/** Re-exported from the turn-actions module (which owns the types) so
ex *  existing importers (`AgentMessageList`) keep resolving them here. */
export type { AgentPendingAskAnswer, AgentPendingPermissionAnswer, AgentTurnFailure };

export interface AgentController extends AgentTurnActions {
  isSending: boolean;
  /** Live assistant text accumulated from text-deltas this turn (cleared on settle). */
  pendingText: string;
  /** Live model reasoning accumulated from reasoning-deltas this turn,
   *  rendered with the co-author's MessageReasoning `inline` preset on the
   *  live caption line (AP-29). Cleared on settle alongside pendingText —
   *  the settle+refetch handover replaces it with the persisted caption
   *  toggle (the clear precedes the async refetch, so the handover shows
   *  no gap and no duplicate: production never renders both at once). */
  pendingReasoning: string;
  /** The user's just-sent message, shown optimistically while the model
   *  generates — the persisted user row only appears after the turn settles
   *  and the shell refetches, so without this the user's own message is
   *  invisible for the entire generation. Cleared in `finally`. */
  pendingUserContent: string;
  /** CA-4e3: the just-sent message's attachments — set with (and cleared
   *  with) `pendingUserContent`, so the optimistic bubble shows the chips and
   *  the settle refetch swaps in the persisted row's identical attachments. */
  pendingUserAttachments: readonly Attachment[];
  /** TAG-9: the optimistic resolution of the just-answered `ask_user` card
   *  (status flipped immediately on submit so the card does not wait for the
   *  settle+refetch round-trip). Cleared at the next turn start or thread
   *  switch — by then the persisted row carries the same resolution, so the
   *  lingering entry is harmless. A PRE-stream failure (validation 400 /
   *  network before the SSE opened) rolls it back: the backend never rewrote
   *  the row, so the card must return to interactive. */
  pendingAskAnswer: AgentPendingAskAnswer | null;
  /** AP-13: the thread's last turn failure (the error card's live state —
   *  null = the last turn did not fail). Keyed per thread (a switch shows
   *  that thread's failure or none); a successful turn clears it; a retry's
   *  failure replaces it. Cancel records nothing. */
  turnFailure: AgentTurnFailure | null;
  handleSend: (content: string, opts?: AgentSendOptions) => Promise<void>;
  /** TAG-9: answer a pending `ask_user` question (style B split-turn) —
   *  streams the continuation with the `answer` body (no new user row).
   *  SC-23f: also carries the permission decision (`{ decision }` — just
   *  another answer-union member on the SAME path, no transport fork); ask
   *  bodies behave byte-identically to before. */
  handleAnswer: (toolCallId: string, answer: CopilotAnswerInput, opts?: AgentSendOptions) => Promise<void>;
  // AP-10 turn actions (handleRegenerate / handleDeleteTurn / handleEditLast)
  // and the AP-31 assistant edit (handleEditAssistant) arrive through
  // `AgentTurnActions` above — owned by `use-agent-turn-actions.ts`.
  handleCancel: () => void;
  /** SC-23f: the optimistic resolution of the just-decided permission card
   *  (mirrors `pendingAskAnswer` — flips the card immediately, rolls back
   *  on a pre-stream failure, clears at the next turn start / thread
   *  switch). */
  pendingPermissionAnswer: AgentPendingPermissionAnswer | null;
}

/**
 * Best-effort string summary of a tool-result `output`. The SSE parser hands
 * `output` already JSON-parsed (never circular), so `JSON.stringify` cannot
 * throw here and no try/catch is needed. Mirrors the persisted path's
 * `summary: message.content` (the raw tool-result string).
 */
function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  return JSON.stringify(output);
}

export function useAgentController(
  args: UseAgentControllerArgs,
): AgentController {
  const { kind, transport, threadId, providerProfileId, model, onTurnSettled, onMetrics, applyPlanToolResult, threadTodo, threadMessages } = args;

  const [isSending, setIsSending] = useState(false);
  const [pendingText, setPendingText] = useState("");
  const [pendingReasoning, setPendingReasoning] = useState("");
  // Optimistic user message: shown immediately on send so the user sees their
  // own message while the model generates (the persisted row only arrives
  // after the turn settles + the shell refetches). Cleared in `finally` so
  // every exit path (success / error / abort) drops it once the turn is done.
  const [pendingUserContent, setPendingUserContent] = useState("");
  // CA-4e3: the optimistic bubble's attachments (see the interface doc).
  const [pendingUserAttachments, setPendingUserAttachments] = useState<readonly Attachment[]>([]);
  // TAG-9: the optimistic resolution of the just-answered ask card (see the
  // interface doc for the rollback/convergence contract).
  const [pendingAskAnswer, setPendingAskAnswer] = useState<AgentPendingAskAnswer | null>(null);
  // SC-23f: the optimistic resolution of the just-decided permission card
  // (the same contract — the ask override above is untouched).
  const [pendingPermissionAnswer, setPendingPermissionAnswer] = useState<AgentPendingPermissionAnswer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous re-entrancy guard: `isSending` state flips on the next render,
  // so a rapid double-send in the same tick would otherwise both pass the
  // guard. Mirrors the RP controller reading generation state synchronously.
  const isSendingRef = useRef(false);

  // TAG-7 (restored PM-7): seed/reset the session-scoped todo panel state
  // from the persisted thread wire (the durable truth — `todo_json` on the
  // thread row). Runs on mount, thread switch, and every thread refetch
  // producing a new array; seeding with the wire value IS the thread-switch
  // reset (an empty wire todo clears the panel for a thread with no checklist
  // yet). Live `todo` tool events upsert on top between refetches — the wire
  // and the live state converge on settle+refetch because both describe the
  // same persisted list. The plan is deliberately NOT seeded here: it is
  // script-owned (useAgentPlan), never thread state.
  useEffect(() => {
    if (threadId === null || threadTodo === undefined) return;
    useAgentTurnStore.getState().setTodo(kind, threadId, threadTodo);
  }, [kind, threadId, threadTodo]);

  // TAG-9: drop a stale optimistic ask resolution on thread switch (the new
  // thread's persisted rows are the truth for its own asks). SC-23f: the
  // permission override drops with it (same truth — the new thread's rows).
  // AP-13: the failure record does NOT drop — it is keyed per thread, so a
  // switch shows that thread's failure or none (the selector below reads
  // the map through the CURRENT thread's key).
  useEffect(() => {
    setPendingAskAnswer(null);
    setPendingPermissionAnswer(null);
  }, [threadId]);

  // AP-13: the last turn failure per thread (the error card's live state).
  // The map retains every thread's failure across switches (a successful
  // turn deletes its thread's entry); `writeTurnFailure` takes the key
  // explicitly so a late settle never clears the WRONG thread's entry.
  const [turnFailures, setTurnFailures] = useState<Readonly<Record<string, AgentTurnFailure>>>({});
  const turnFailure = threadId !== null ? turnFailures[agentThreadKey(kind, threadId)] ?? null : null;
  const writeTurnFailure = useCallback((key: string, failure: AgentTurnFailure | null): void => {
    setTurnFailures((prev) => {
      if (failure === null) {
        if (prev[key] === undefined) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key]?.category === failure.category) return prev;
      return { ...prev, [key]: failure };
    });
  }, []);

  // TAG-9: ONE builder for the SSE→store callbacks, shared by handleSend and
  // handleAnswer. The live tool routing must stay field-for-field with the
  // persisted extraction (CD-1), so both entry points drive the IDENTICAL
  // wiring; `sawStreamEvent` lets the answer path distinguish a pre-stream
  // failure (backend never rewrote the ask row) from a mid-stream one.
  const buildStreamCallbacks = (
    activeThreadId: string,
    sawStreamEvent: { current: boolean },
  ): CopilotStreamOpts => ({
    onStatus: (status) => {
      if (status === "streaming") sawStreamEvent.current = true;
    },
    onChunk: (delta) => {
      setPendingText((p) => p + delta);
      useAgentTurnStore.getState().appendTextDelta(kind, activeThreadId, delta);
    },
    onReasoningChunk: (delta) => {
      setPendingReasoning((p) => p + delta);
    },
    onToolCall: (info) => {
      useAgentTurnStore.getState().closeTextSegment(kind, activeThreadId);
      useAgentTurnStore.getState().appendActivityRef(kind, activeThreadId, info.toolCallId);
      useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        args: info.args,
        status: "streaming",
      });
      // TAG-7 (restored PM-7): full-rewrite semantics — the todo tool-call's
      // args ARE the new session checklist (Cline-style), so the panel
      // updates immediately while the call streams; the tool-result envelope
      // below re-confirms the same list. Object shape `{items}` (incident
      // fix 2026-08-21); ill-formed/partial args → null, silently skipped
      // (the result envelope is the fallback path).
      if (info.toolName === "todo") {
        const todo = parseTodoToolArgs(info.args);
        if (todo !== null) {
          useAgentTurnStore.getState().setTodo(kind, activeThreadId, todo);
        }
      }
    },
    onToolInputStart: (info) => {
      useAgentTurnStore.getState().closeTextSegment(kind, activeThreadId);
      useAgentTurnStore.getState().appendActivityRef(kind, activeThreadId, info.toolCallId);
      useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        status: "streaming",
      });
    },
    onToolResult: (info) => {
      useAgentTurnStore.getState().closeTextSegment(kind, activeThreadId);
      useAgentTurnStore.getState().appendActivityRef(kind, activeThreadId, info.toolCallId);
      // This routing MUST stay field-for-field with ER-8's
      // `extractPersistedAgentActivities` so live activities
      // === persisted activities on snapshot refetch. The only addition
      // is the live-only `isError` signal, OR'd into the error status.
      if (info.toolName === "read_skill_file") {
        const read = coauthorSkillReadOutputSchema.safeParse(info.output);
        useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !read.success ? "error" : "done",
          ...(read.success ? { readPath: read.data.path } : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      if (info.toolName === "write_buffer" || info.toolName === "edit_buffer") {
        const output = experienceCopilotToolOutputSchema.safeParse(info.output);
        useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !output.success ? "error" : "done",
          ...(output.success
            ? {
                summary: output.data.summary,
                target: output.data.target,
                proposed: output.data.proposed,
              }
            : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      // TAG-7 (restored PM-7): a todo result is the {ok, items, activeTitle,
      // remaining} envelope. A successful envelope carries the card payload
      // AND confirms the panel state (same list the tool-call args already
      // upserted); a failed save (ok:false — not an isError) renders the
      // error card and leaves the panel at the optimistic value (the model
      // retries the rewrite next step). Must stay field-for-field with the
      // persisted extraction's `todo` branch.
      if (info.toolName === "todo") {
        const todo = parseTodoToolResult(info.output);
        if (todo) {
          useAgentTurnStore.getState().setTodo(kind, activeThreadId, todo.items);
        }
        useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !todo ? "error" : "done",
          ...(todo ? { todo } : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      // PM-6: a plan result is the {ok, activeTitle?, remaining?} envelope
      // from createAgentPlanTools. The carrier args captured by onToolCall
      // are read back from the streaming placeholder (the same recovery the
      // ask_user branch uses) and routed — with the envelope — into the
      // shell's useAgentPlan applyToolResult, which replaces the script-owned
      // plan cache only when BOTH parse. The card itself carries no summary
      // on success (CopilotActivityCard labels plan cards via i18n); a failed
      // save (ok:false — not an isError) renders the error card with the raw
      // content, the write_buffer branch's failure shape. This routing must
      // stay field-for-field with the persisted extraction's `plan` branch.
      if (info.toolName === "plan") {
        const result = parseAgentPlanToolResult(info.output);
        const liveArgs = useAgentTurnStore
          .getState()
          .getActivities(kind, activeThreadId)
          .find((activity) => activity.toolCallId === info.toolCallId)?.args;
        applyPlanToolResult?.(liveArgs, info.output);
        useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !result ? "error" : "done",
          ...(!result ? { summary: summarizeToolOutput(info.output) } : {}),
        });
        return;
      }
      // TAG-7: an ask result is the awaiting marker (the only ask
      // output a live turn ever sees — answered/skipped rewrites only
      // exist in persisted rows). The carrier args captured by
      // onToolCall are read back from the streaming placeholder so
      // this branch stays field-for-field with the persisted
      // extraction (the parser prefers the output's verbatim echo and
      // falls back to the args for question/options/recommended).
      if (info.toolName === "ask_user") {
        const liveArgs = useAgentTurnStore
          .getState()
          .getActivities(kind, activeThreadId)
          .find((activity) => activity.toolCallId === info.toolCallId)?.args;
        const ask = parseAgentAskState(liveArgs, info.output);
        useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !ask ? "error" : "done",
          ...(ask ? { ask } : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      // SC-23f: a permission result is the awaiting marker (the only
      // permission output a live turn ever sees — granted/denied rewrites
      // only exist in persisted rows). Parsed by the ONE parser the
      // persisted extraction shares, so live === persisted field-for-field.
      if (info.toolName === "read_message_prompt") {
        const permission = parseAgentPermissionState(info.output);
        useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !permission ? "error" : "done",
          ...(permission ? { permission } : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      // run_test / run_simulate / suggest_visual_binding — non-proposal
      // informational digests (never parsed as a proposal). Always a
      // done card with a best-effort string summary.
      useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        status: "done",
        summary: summarizeToolOutput(info.output),
      });
    },
  });

  const handleSend = useCallback(
    async (content: string, opts?: AgentSendOptions): Promise<void> => {
      const trimmed = content.trim();
      // CA-4e3: an attachment-only send is legal (the schema allows content
      // OR non-empty attachments; an empty string is refused — content is
      // then omitted from the body below).
      const attachments = opts?.attachments ?? [];
      const hasAttachments = attachments.length > 0;

      // Silent guards (no toast): no text AND no attachments, missing thread,
      // already sending.
      if ((!trimmed && !hasAttachments) || !threadId || isSendingRef.current) return;
      // Missing provider is the one guard that deserves feedback.
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // Start the turn fresh: drop the previous turn's tool activities (same
      // rationale as the RP controller's co-author clearTurn). Also drop any
      // stale optimistic ask resolution (TAG-9) — by now the persisted rows
      // carry the true ask state. SC-23f: the permission override drops with
      // it (same truth — the persisted rows). AP-13: the stale failure drops
      // with them — a new turn supersedes the card while it runs (its
      // failure replaces the card in the catch below).
      useAgentTurnStore.getState().clearTurn(kind, threadId);
      setPendingAskAnswer(null);
      setPendingPermissionAnswer(null);
      const failureKey = agentThreadKey(kind, threadId);
      writeTurnFailure(failureKey, null);

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      setIsSending(true);
      setPendingText("");
      setPendingReasoning("");
      setPendingUserContent(trimmed);
      setPendingUserAttachments(attachments);

      try {
        const streamResult = await transport.sendStream(
          threadId,
          {
            // CA-4e3: an attachment-only send omits `content` (the schema
            // refuses an empty string); the attachments ride the body through
            // the ONE send mapper.
            ...(trimmed ? { content: trimmed } : {}),
            providerProfileId,
            ...(model ? { model } : {}),
            ...(hasAttachments ? { attachments: attachments.map(toSendAttachment) } : {}),
            ...(opts?.rules !== undefined ? { rules: opts.rules } : {}),
            ...(opts?.visual !== undefined ? { visual: opts.visual } : {}),
            ...(opts?.code !== undefined ? { code: opts.code } : {}),
            ...(opts?.scriptKind !== undefined ? { scriptKind: opts.scriptKind } : {}),
            ...(opts?.codeSaved !== undefined ? { codeSaved: opts.codeSaved } : {}),
            ...(opts?.contextCharacterId !== undefined ? { contextCharacterId: opts.contextCharacterId } : {}),
            ...(opts?.contextPersonaId !== undefined ? { contextPersonaId: opts.contextPersonaId } : {}),
            ...(opts?.step ? { step: opts.step } : {}),
            ...(opts?.testFeedback !== undefined ? { testFeedback: opts.testFeedback } : {}),
            ...(opts?.launchContext !== undefined ? { launchContext: opts.launchContext } : {}),
            ...(opts?.reviewSnapshot !== undefined ? { reviewSnapshot: opts.reviewSnapshot } : {}),
            ...(opts?.rulesSaved !== undefined ? { rulesSaved: opts.rulesSaved } : {}),
            ...(opts?.visualSaved !== undefined ? { visualSaved: opts.visualSaved } : {}),
            // SC-18: the sidechat host maps its pending variant chips here;
            // absent = not sent (the schema caps the list at 64 pairs).
            ...(opts?.attachedVariants !== undefined ? { attachedVariants: opts.attachedVariants } : {}),
          },
          {
            signal: controller.signal,
            ...buildStreamCallbacks(threadId, { current: false }),
          },
        );

        // CM-7: surface the finish event's segmented metrics to the meter.
        // The stream return value carries `metrics` (unknown from the parser);
        // validate once here so the hook only ever sees the wire shape.
        const rawMetrics = streamResult.metrics;
        const parsedMetrics = rawMetrics != null
          ? experienceCopilotContextMetricsSchema.safeParse(rawMetrics)
          : null;
        onMetrics?.(parsedMetrics?.success ? parsedMetrics.data : null);

        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        // AP-13: the turn answered — the card clears with the failure.
        writeTurnFailure(failureKey, null);
        onTurnSettled?.(true);
      } catch (error) {
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          // AP-13: the turn failure owns the surface — the card renders the
          // category description, so the toast is gone.
          writeTurnFailure(failureKey, copilotTurnFailureOf(error));
        }
        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        // A cancelled turn is NOT a success (SC-18): the pending chips stay
        // for a retry — same as a failure.
        onTurnSettled?.(false);
      } finally {
        abortRef.current = null;
        setPendingUserContent("");
        setPendingUserAttachments([]);
      }
    },
    [kind, threadId, providerProfileId, model, transport, onTurnSettled, onMetrics, applyPlanToolResult],
  );

  const handleAnswer = useCallback(
    async (toolCallId: string, answer: CopilotAnswerInput, opts?: AgentSendOptions): Promise<void> => {
      // SC-23f: the decision is just another answer-union member on this
      // SAME path — `decision` present = the permission family, absent =
      // the ask family. The wire union members are both `.strict()`, so a
      // mixed body (decision + text/skipped) matches NEITHER and is refused
      // here, before any stream call.
      const decision = "decision" in answer ? answer.decision : undefined;
      const text = "text" in answer ? answer.text?.trim() : undefined;
      const skipped = "skipped" in answer && answer.skipped === true;
      if (decision !== undefined && (text !== undefined || skipped)) return;
      if (decision !== undefined && decision !== "allow" && decision !== "deny") return;

      // Silent guards: the wire schema's exactly-one-of (a chip click sends
      // `text`, the skip button sends `skipped`, free text sends `text` —
      // the card never produces both/neither; this pins it anyway), missing
      // target/thread, already sending.
      if (!toolCallId || (decision === undefined && ((!text && !skipped) || (text !== undefined && text.length > 0 && skipped)))) return;
      if (!threadId || isSendingRef.current) return;
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // The answer resumes the question turn (style B): clear the live turn
      // so the awaiting activity yields to the persisted row (TAG-7 note),
      // and drop any stale override from a previous answer. AP-13: the
      // stale failure drops with them (the answer is a new turn attempt —
      // same supersede rule as a send).
      useAgentTurnStore.getState().clearTurn(kind, threadId);
      const failureKey = agentThreadKey(kind, threadId);
      writeTurnFailure(failureKey, null);

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      setIsSending(true);
      setPendingText("");
      setPendingReasoning("");
      // NO pendingUserContent — the answer has no user row (it replaces the
      // awaiting tool-result row server-side).
      // Optimistic flip: the card shows the resolution immediately instead of
      // waiting for the settle+refetch round-trip. The decision flips the
      // permission card; the ask flip is untouched (one family per call —
      // the guard above refused mixed bodies, so nulling the other family's
      // override cannot drop a live value).
      if (decision !== undefined) {
        setPendingAskAnswer(null);
        setPendingPermissionAnswer({ toolCallId, decision });
      } else {
        setPendingPermissionAnswer(null);
        setPendingAskAnswer({
          toolCallId,
          status: skipped ? "skipped" : "answered",
          ...(text ? { answer: text } : {}),
        });
      }

      const sawStreamEvent = { current: false };
      try {
        const streamResult = await transport.answerAsk(
          threadId,
          {
            answer: {
              toolCallId,
              ...(text ? { text } : {}),
              ...(skipped ? { skipped: true } : {}),
              ...(decision !== undefined ? { decision } : {}),
            },
            providerProfileId,
            ...(model ? { model } : {}),
            ...(opts?.rules !== undefined ? { rules: opts.rules } : {}),
            ...(opts?.visual !== undefined ? { visual: opts.visual } : {}),
            ...(opts?.code !== undefined ? { code: opts.code } : {}),
            ...(opts?.scriptKind !== undefined ? { scriptKind: opts.scriptKind } : {}),
            ...(opts?.codeSaved !== undefined ? { codeSaved: opts.codeSaved } : {}),
            ...(opts?.contextCharacterId !== undefined ? { contextCharacterId: opts.contextCharacterId } : {}),
            ...(opts?.contextPersonaId !== undefined ? { contextPersonaId: opts.contextPersonaId } : {}),
            ...(opts?.step ? { step: opts.step } : {}),
            ...(opts?.testFeedback !== undefined ? { testFeedback: opts.testFeedback } : {}),
            ...(opts?.launchContext !== undefined ? { launchContext: opts.launchContext } : {}),
            ...(opts?.reviewSnapshot !== undefined ? { reviewSnapshot: opts.reviewSnapshot } : {}),
            ...(opts?.rulesSaved !== undefined ? { rulesSaved: opts.rulesSaved } : {}),
            ...(opts?.visualSaved !== undefined ? { visualSaved: opts.visualSaved } : {}),
            // SC-18: the pending chips ride the continuation too (the next
            // stream call carries them, whichever path it takes).
            ...(opts?.attachedVariants !== undefined ? { attachedVariants: opts.attachedVariants } : {}),
          },
          {
            signal: controller.signal,
            ...buildStreamCallbacks(threadId, sawStreamEvent),
          },
        );

        // Same CM-7 metrics surfacing as handleSend.
        const rawMetrics = streamResult.metrics;
        const parsedMetrics = rawMetrics != null
          ? experienceCopilotContextMetricsSchema.safeParse(rawMetrics)
          : null;
        onMetrics?.(parsedMetrics?.success ? parsedMetrics.data : null);

        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        // AP-13: the turn answered — the card clears with the failure.
        writeTurnFailure(failureKey, null);
        onTurnSettled?.(true);
      } catch (error) {
        // A failure BEFORE the stream opened (validation 400, network) means
        // the backend never rewrote the ask row — roll the optimistic flip
        // back so the card returns to interactive. A failure after the SSE
        // opened means the answer was already persisted; the override stays
        // (it matches the row the settle refetch shows). Both families roll
        // back together (only one was set above — the other is already null).
        if (!sawStreamEvent.current) {
          setPendingAskAnswer(null);
          setPendingPermissionAnswer(null);
        }
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          // AP-13: the turn failure owns the surface — the card renders the
          // category description, so the toast is gone.
          writeTurnFailure(failureKey, copilotTurnFailureOf(error));
        }
        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.(false);
      } finally {
        abortRef.current = null;
      }
    },
    [kind, threadId, providerProfileId, model, transport, onTurnSettled, onMetrics, applyPlanToolResult],
  );

  // AP-10: the turn actions live in their own module (the file-size
  // ratchet) — fed with the controller's send, callback builder, and turn
  // state, re-exposed on the controller's contract below.
  const turnActions = useAgentTurnActions({
    kind,
    transport,
    threadId,
    providerProfileId,
    model,
    onTurnSettled,
    onMetrics,
    applyPlanToolResult,
    threadMessages,
    sendTurn: handleSend,
    buildStreamCallbacks,
    turnState: {
      isSendingRef,
      abortRef,
      setIsSending,
      setPendingText,
      setPendingReasoning,
      setPendingAskAnswer,
      setPendingPermissionAnswer,
      // AP-13: the regenerate path writes the same per-thread failure the
      // send/answer paths above own — bound to the CURRENT thread (the hook
      // guards a missing thread before touching it, like it guards a send).
      setTurnFailure: (failure) => {
        if (threadId !== null) writeTurnFailure(agentThreadKey(kind, threadId), failure);
      },
    },
  });

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    toast.info(getT()("cancelling_generation"));
  }, []);

  return { isSending, pendingText, pendingReasoning, pendingUserContent, pendingUserAttachments, pendingAskAnswer, pendingPermissionAnswer, turnFailure, handleSend, handleAnswer, handleRegenerate: turnActions.handleRegenerate, handleDeleteTurn: turnActions.handleDeleteTurn, handleEditAssistant: turnActions.handleEditAssistant, handleEditLast: turnActions.handleEditLast, pendingDelete: turnActions.pendingDelete, requestDeleteTurn: turnActions.requestDeleteTurn, confirmDeleteTurn: turnActions.confirmDeleteTurn, cancelDeleteTurn: turnActions.cancelDeleteTurn, isRegenerating: turnActions.isRegenerating, hiddenRegeneratedIds: turnActions.hiddenRegeneratedIds, handleCancel };
}
