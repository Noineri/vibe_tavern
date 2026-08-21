import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getT, type TFunc } from "../i18n/locale-helpers.js";
import {
  answerCopilotAsk,
  streamExperienceCopilot,
  type CopilotAskAnswerInput,
  type CopilotStreamOpts,
} from "../api/experience-copilot-api.js";
import {
  useExperienceCopilotTurnStore,
  parseTodoToolResult,
  parseTodoToolArgs,
  parseCopilotAskState,
} from "../stores/experience-copilot-turn-store.js";
import {
  coauthorSkillReadOutputSchema,
  experienceCopilotToolOutputSchema,
  experienceCopilotContextMetricsSchema,
  type ExperienceCopilotStep,
  type ExperienceCopilotContextMetrics,
  type CopilotTodoItem,
} from "@vibe-tavern/api-contracts";
import { ProviderStreamError } from "../api/provider-stream-error.js";

/**
 * Experience-Copilot send/stream controller (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 4 / ER-11b).
 *
 * The copilot has its own transport (`streamExperienceCopilot`, ER-10) and its
 * own turn store (`useExperienceCopilotTurnStore`, ER-8), so it cannot reuse
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

export interface UseExperienceCopilotControllerArgs {
  threadId: string | null;
  providerProfileId: string | null;
  model?: string;
  /** Called after a turn settles (done/cancelled/failed) so the shell can refetch persisted messages. */
  onTurnSettled?: () => void;
  /** CM-7: feed the segmented context metrics from the `finish` SSE event to
   *  the shell's meter immediately (before any context refetch round-trips).
   *  Null when the finish event carried no/ill-formed metrics. */
  onMetrics?: (metrics: ExperienceCopilotContextMetrics | null) => void;
  /** TAG-7: the current thread wire's `todo` (the durable `todo_json` truth).
   *  Seeds/resets the session-scoped live todo panel state on mount, thread
   *  switch, and every thread refetch that produces a new array; live `todo`
 *  tool events upsert on top between refetches. Omitted (undefined) leaves
   *  the store untouched — TAG-8 wires the shell to pass `thread.todo`. */
  threadTodo?: readonly CopilotTodoItem[];
}

/** Live draft buffers + active authoring step to send with a copilot message so
 *  the model sees the current (possibly unsaved) source and knows which buffer
 *  the user is editing. */
export interface ExperienceCopilotSendOptions {
  rules?: string;
  visual?: string;
  step?: ExperienceCopilotStep;
  /** The latest test/simulate digest the user sent back from the test panel
   *  (ER-14). Carried on the body as `testFeedback` and rendered as a JSON
   *  context section by the backend (surviving history compaction). */
  testFeedback?: Record<string, unknown> | null;
}

export interface ExperienceCopilotController {
  isSending: boolean;
  /** Live assistant text accumulated from text-deltas this turn (cleared on settle). */
  pendingText: string;
  /** Live model reasoning accumulated from reasoning-deltas this turn,
   *  rendered with the co-author's MessageReasoning "minimal" pattern (UX
   *  2026-08-16 remark 4). Cleared on settle alongside pendingText — the
   *  copilot's persisted turns do not carry reasoning (server-side TurnSegment
   *  has no reasoning kind), so the block is live-only for now. */
  pendingReasoning: string;
  /** The user's just-sent message, shown optimistically while the model
   *  generates — the persisted user row only appears after the turn settles
   *  and the shell refetches, so without this the user's own message is
   *  invisible for the entire generation. Cleared in `finally`. */
  pendingUserContent: string;
  /** TAG-9: the optimistic resolution of the just-answered `ask_user` card
   *  (status flipped immediately on submit so the card does not wait for the
   *  settle+refetch round-trip). Cleared at the next turn start or thread
   *  switch — by then the persisted row carries the same resolution, so the
   *  lingering entry is harmless. A PRE-stream failure (validation 400 /
   *  network before the SSE opened) rolls it back: the backend never rewrote
   *  the row, so the card must return to interactive. */
  pendingAskAnswer: ExperienceCopilotPendingAskAnswer | null;
  handleSend: (content: string, opts?: ExperienceCopilotSendOptions) => Promise<void>;
  /** TAG-9: answer a pending `ask_user` question (style B split-turn) —
   *  streams the continuation with the `answer` body (no new user row). */
  handleAnswer: (toolCallId: string, answer: CopilotAskAnswerInput, opts?: ExperienceCopilotSendOptions) => Promise<void>;
  handleCancel: () => void;
}

/** TAG-9: the optimistic resolution recorded when an ask card is submitted. */
export interface ExperienceCopilotPendingAskAnswer {
  toolCallId: string;
  status: "answered" | "skipped";
  /** The answer text — present iff `status === "answered"`. */
  answer?: string;
}

// Categories where the failure is likely transient (retry after a short wait) —
// the message alone is enough; we just add a "try again" hint. Mirrors the RP
// controller's `TRANSIENT_PROVIDER_CATEGORIES` set (see use-chat-controller.ts).
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["rate_limit", "timeout", "network", "server_error"]);

/**
 * Category-aware provider-error toast. `showProviderErrorToast` in
 * use-chat-controller.ts is module-private, so this is its minimal replica
 * (same category → description mapping), minus the `open_provider_settings`
 * modal action (which is tied to the RP `useModalStore`; the copilot shell owns
 * its own provider selection).
 */
function showProviderErrorToast(error: unknown, t: TFunc): void {
  const message = error instanceof Error && error.message ? error.message : t("message_send_failed");
  const category = error instanceof ProviderStreamError ? error.category : "unknown";

  if (category === "authentication") {
    toast.error(message, { description: t("provider_error_auth_desc") });
    return;
  }
  if (TRANSIENT_PROVIDER_CATEGORIES.has(category)) {
    toast.error(message, { description: t("provider_error_transient_desc") });
    return;
  }
  if (category === "empty_response" || category === "parse_error") {
    toast.error(message, { description: t("provider_error_empty_desc") });
    return;
  }
  toast.error(message);
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

export function useExperienceCopilotController(
  args: UseExperienceCopilotControllerArgs,
): ExperienceCopilotController {
  const { threadId, providerProfileId, model, onTurnSettled, onMetrics, threadTodo } = args;

  const [isSending, setIsSending] = useState(false);
  const [pendingText, setPendingText] = useState("");
  const [pendingReasoning, setPendingReasoning] = useState("");
  // Optimistic user message: shown immediately on send so the user sees their
  // own message while the model generates (the persisted row only arrives
  // after the turn settles + the shell refetches). Cleared in `finally` so
  // every exit path (success / error / abort) drops it once the turn is done.
  const [pendingUserContent, setPendingUserContent] = useState("");
  // TAG-9: the optimistic resolution of the just-answered ask card (see the
  // interface doc for the rollback/convergence contract).
  const [pendingAskAnswer, setPendingAskAnswer] = useState<ExperienceCopilotPendingAskAnswer | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous re-entrancy guard: `isSending` state flips on the next render,
  // so a rapid double-send in the same tick would otherwise both pass the
  // guard. Mirrors the RP controller reading generation state synchronously.
  const isSendingRef = useRef(false);

  // TAG-7: seed/reset the session-scoped todo panel state from the persisted
  // thread wire (the durable truth — `todo_json` on the thread row). Runs on
  // mount, thread switch, and every thread refetch producing a new array;
  // seeding with the wire value IS the thread-switch reset (an empty wire todo
  // clears the panel for a thread with no plan yet). Live `todo` tool events
  // upsert on top between refetches — the wire and the live state converge on
  // settle+refetch because both describe the same persisted list.
  useEffect(() => {
    if (threadId === null || threadTodo === undefined) return;
    useExperienceCopilotTurnStore.getState().setTodo(threadId, threadTodo);
  }, [threadId, threadTodo]);

  // TAG-9: drop a stale optimistic ask resolution on thread switch (the new
  // thread's persisted rows are the truth for its own asks).
  useEffect(() => {
    setPendingAskAnswer(null);
  }, [threadId]);

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
      useExperienceCopilotTurnStore.getState().appendTextDelta(activeThreadId, delta);
    },
    onReasoningChunk: (delta) => {
      setPendingReasoning((p) => p + delta);
    },
    onToolCall: (info) => {
      useExperienceCopilotTurnStore.getState().closeTextSegment(activeThreadId);
      useExperienceCopilotTurnStore.getState().appendActivityRef(activeThreadId, info.toolCallId);
      useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        args: info.args,
        status: "streaming",
      });
      // TAG-7: full-rewrite semantics — the todo tool-call's args ARE
      // the new session plan (Cline-style), so the panel updates
      // immediately while the call streams; the tool-result envelope
      // below re-confirms the same list. Object shape `{items}` (incident
      // fix 2026-08-21); ill-formed/partial args → null, silently skipped
      // (the result envelope is the fallback path).
      if (info.toolName === "todo") {
        const todo = parseTodoToolArgs(info.args);
        if (todo !== null) {
          useExperienceCopilotTurnStore.getState().setTodo(activeThreadId, todo);
        }
      }
    },
    onToolInputStart: (info) => {
      useExperienceCopilotTurnStore.getState().closeTextSegment(activeThreadId);
      useExperienceCopilotTurnStore.getState().appendActivityRef(activeThreadId, info.toolCallId);
      useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        status: "streaming",
      });
    },
    onToolResult: (info) => {
      useExperienceCopilotTurnStore.getState().closeTextSegment(activeThreadId);
      useExperienceCopilotTurnStore.getState().appendActivityRef(activeThreadId, info.toolCallId);
      // This routing MUST stay field-for-field with ER-8's
      // `extractPersistedExperienceCopilotActivities` so live activities
      // === persisted activities on snapshot refetch. The only addition
      // is the live-only `isError` signal, OR'd into the error status.
      if (info.toolName === "read_skill_file") {
        const read = coauthorSkillReadOutputSchema.safeParse(info.output);
        useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !read.success ? "error" : "done",
          ...(read.success ? { readPath: read.data.path } : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      if (info.toolName === "write_buffer" || info.toolName === "edit_buffer") {
        const output = experienceCopilotToolOutputSchema.safeParse(info.output);
        useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
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
      // TAG-7: a todo result is the {ok, items, activeTitle, remaining}
      // envelope. A successful envelope carries the card payload AND
      // confirms the panel state (same list the tool-call args already
      // upserted); a failed save (ok:false — not an isError) renders
      // the error card and leaves the panel at the optimistic value
      // (the model retries the rewrite next step).
      if (info.toolName === "todo") {
        const todo = parseTodoToolResult(info.output);
        if (todo) {
          useExperienceCopilotTurnStore.getState().setTodo(activeThreadId, todo.items);
        }
        useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !todo ? "error" : "done",
          ...(todo ? { todo } : { summary: summarizeToolOutput(info.output) }),
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
        const liveArgs = useExperienceCopilotTurnStore
          .getState()
          .getActivities(activeThreadId)
          .find((activity) => activity.toolCallId === info.toolCallId)?.args;
        const ask = parseCopilotAskState(liveArgs, info.output);
        useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          status: info.isError || !ask ? "error" : "done",
          ...(ask ? { ask } : { summary: summarizeToolOutput(info.output) }),
        });
        return;
      }
      // run_test / run_simulate / suggest_visual_binding — non-proposal
      // informational digests (never parsed as a proposal). Always a
      // done card with a best-effort string summary.
      useExperienceCopilotTurnStore.getState().upsertActivity(activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        status: "done",
        summary: summarizeToolOutput(info.output),
      });
    },
  });

  const handleSend = useCallback(
    async (content: string, opts?: ExperienceCopilotSendOptions): Promise<void> => {
      const trimmed = content.trim();

      // Silent guards (no toast): empty content, missing thread, already sending.
      if (!trimmed || !threadId || isSendingRef.current) return;
      // Missing provider is the one guard that deserves feedback.
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // Start the turn fresh: drop the previous turn's tool activities (same
      // rationale as the RP controller's co-author clearTurn). Also drop any
      // stale optimistic ask resolution (TAG-9) — by now the persisted rows
      // carry the true ask state.
      useExperienceCopilotTurnStore.getState().clearTurn(threadId);
      setPendingAskAnswer(null);

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      setIsSending(true);
      setPendingText("");
      setPendingReasoning("");
      setPendingUserContent(trimmed);

      try {
        const streamResult = await streamExperienceCopilot(
          threadId,
          {
            content: trimmed,
            providerProfileId,
            ...(model ? { model } : {}),
            ...(opts?.rules !== undefined ? { rules: opts.rules } : {}),
            ...(opts?.visual !== undefined ? { visual: opts.visual } : {}),
            ...(opts?.step ? { step: opts.step } : {}),
            ...(opts?.testFeedback !== undefined ? { testFeedback: opts.testFeedback } : {}),
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
        onTurnSettled?.();
      } catch (error) {
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          showProviderErrorToast(error, getT());
        }
        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.();
      } finally {
        abortRef.current = null;
        setPendingUserContent("");
      }
    },
    [threadId, providerProfileId, model, onTurnSettled, onMetrics],
  );

  const handleAnswer = useCallback(
    async (toolCallId: string, answer: CopilotAskAnswerInput, opts?: ExperienceCopilotSendOptions): Promise<void> => {
      const text = answer.text?.trim();
      const skipped = answer.skipped === true;

      // Silent guards: the wire schema's exactly-one-of (a chip click sends
      // `text`, the skip button sends `skipped`, free text sends `text` —
      // the card never produces both/neither; this pins it anyway), missing
      // target/thread, already sending.
      if (!toolCallId || (!text && !skipped) || (text !== undefined && text.length > 0 && skipped)) return;
      if (!threadId || isSendingRef.current) return;
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // The answer resumes the question turn (style B): clear the live turn
      // so the awaiting activity yields to the persisted row (TAG-7 note),
      // and drop any stale override from a previous answer.
      useExperienceCopilotTurnStore.getState().clearTurn(threadId);

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      setIsSending(true);
      setPendingText("");
      setPendingReasoning("");
      // NO pendingUserContent — the answer has no user row (it replaces the
      // awaiting tool-result row server-side).
      // Optimistic flip: the card shows the resolution immediately instead of
      // waiting for the settle+refetch round-trip.
      setPendingAskAnswer({
        toolCallId,
        status: skipped ? "skipped" : "answered",
        ...(text ? { answer: text } : {}),
      });

      const sawStreamEvent = { current: false };
      try {
        const streamResult = await answerCopilotAsk(
          threadId,
          {
            answer: {
              toolCallId,
              ...(text ? { text } : {}),
              ...(skipped ? { skipped: true } : {}),
            },
            providerProfileId,
            ...(model ? { model } : {}),
            ...(opts?.rules !== undefined ? { rules: opts.rules } : {}),
            ...(opts?.visual !== undefined ? { visual: opts.visual } : {}),
            ...(opts?.step ? { step: opts.step } : {}),
            ...(opts?.testFeedback !== undefined ? { testFeedback: opts.testFeedback } : {}),
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
        onTurnSettled?.();
      } catch (error) {
        // A failure BEFORE the stream opened (validation 400, network) means
        // the backend never rewrote the ask row — roll the optimistic flip
        // back so the card returns to interactive. A failure after the SSE
        // opened means the answer was already persisted; the override stays
        // (it matches the row the settle refetch shows).
        if (!sawStreamEvent.current) setPendingAskAnswer(null);
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          showProviderErrorToast(error, getT());
        }
        setPendingText("");
        setPendingReasoning("");
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.();
      } finally {
        abortRef.current = null;
      }
    },
    [threadId, providerProfileId, model, onTurnSettled, onMetrics],
  );

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    toast.info(getT()("cancelling_generation"));
  }, []);

  return { isSending, pendingText, pendingReasoning, pendingUserContent, pendingAskAnswer, handleSend, handleAnswer, handleCancel };
}
