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
import type { RevealScheduler } from "../../../lib/streaming-reveal.js";
import { useAgentDeltaBuffer } from "./use-agent-delta-buffer.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { useAgentStreamingStore } from "../../../stores/agent-streaming-store.js";
import { useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";
import { toSendAttachment } from "../../../lib/send-attachments.js";
import { createAgentStreamCallbacks } from "./agent-stream-callbacks.js";
import { guardAgentStreamCallbacks } from "./agent-stream-guard.js";
import { useAgentRunAttachment } from "./use-agent-run-attachment.js";
import type { Attachment } from "@vibe-tavern/domain";
import type { AgentFeedLocalMutation } from "./agent-feed-reconcile.js";
import {
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
 * StreamingReveal — the live stream text/reasoning accumulate in the
 * live-stream store (LAG-3), written once per FRAME (LAG-2: deltas buffer
 * in refs and flush through the same `RevealScheduler` seam
 * `lib/streaming-reveal.ts` owns; the buffering lives in
 * `use-agent-delta-buffer.ts`).
 *
 * State is LOCAL except the live stream pair (LAG-3: it lives in the
 * live-stream store so a flush re-renders only the message list, never
 * this hook's host — the AgentShell root): the copilot editor shell owns a
 * single controller instance and threads values down via props/context
 * (ER-11c/11d). The hook feeds the ER-8 turn store from the SSE tool events
 * (exactly what the shell renders as activity cards) and signals
 * `onTurnSettled` so the shell can refetch persisted messages once a turn
 * settles.
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
  /** BR-2c: flush host review state before clearing activities / opening a run. */
  prepareTurn?: (threadId: string, signal: AbortSignal) => void | Promise<void>;
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
   *  without a resolvable target — the shell wires this to `messages`.
   *  AFP-14: readonly — a paged host feeds the feed hook's covered-window
   *  rows (the last user row lives in the newest window); forwarded into
   *  the turn actions unchanged. */
  threadMessages?: readonly ExperienceCopilotMessageWire[];
  /** AFP-14: the paged feed's local-outcome seam (`useAgentFeed`'s
   *  `applyLocalOutcome` + `loadAround`), wired by the shell when the host
   *  transport carries `feed` and forwarded into the turn actions — a
   *  turn-originated delete/edit carries its row ids into the invalidation
   *  path (see use-agent-turn-actions.ts). Absent = a legacy host. */
  feedOutcome?: {
    applyLocalOutcome: (mutation: AgentFeedLocalMutation) => void;
    loadAround: (messageId: string) => void;
  };
  /** DR-11 (DIRECTOR_MODE_PLAN): when set, the controller publishes its
   *  `isSending` into `useAgentStreamingStore` under this key (the shell's
   *  `agentOwnerKey`) — a ONE-WAY mirror so readers OUTSIDE the shell (the
   *  story strip's call-director button disable while a sidechat turn
   *  streams) can subscribe without owning the turn. The controller stays
   *  the only truth; nothing ever reads the mirror back here. */
  streamingMirrorKey?: string;
  /** LAG-2 (AGENT_SHELL_RENDER_LAG_REPORT, fix step 3): schedules the
   *  frame-coalesced stream-delta flush — ONE `appendTextDelta` (the feed)
   *  and ONE `appendLiveDeltas` (the live-stream store) per frame. Defaults
   *  to the rAF scheduler exported from `lib/streaming-reveal.ts`; tests
   *  inject a manual stepper for deterministic flush timing. */
  scheduler?: RevealScheduler;
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
  // LAG-3: the live stream text/reasoning are NOT on this contract — they
  // live in the live-stream store (`agent-live-stream-store.ts`, the ONE
  // derivation) so a flush never re-renders this hook's host. The message
  // list subscribes to the store directly.
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
   *  bodies behave byte-identically to before. DMT-31: an allow decision may
   *  carry the optional `instruction` — the user-edited swipe text forwarded
   *  VERBATIM in the same answer body (never converted into a sidechat user
   *  message or the ask `text` slot); the wire refuses it on deny. */
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

export function useAgentController(
  args: UseAgentControllerArgs,
): AgentController {
  const { kind, transport, threadId, providerProfileId, model, onTurnSettled, onMetrics, applyPlanToolResult, threadTodo, threadMessages, feedOutcome, streamingMirrorKey, scheduler } = args;

  const [isSending, setIsSending] = useState(false);
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
  const currentThreadRef = useRef(threadId);
  currentThreadRef.current = threadId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const prepareTurn = useCallback((id: string, signal: AbortSignal): void | Promise<void> => {
    attachment.preparing();
    const checkTarget = () => {
      signal.throwIfAborted();
      if (!mountedRef.current || currentThreadRef.current !== id) {
        // No POST has opened yet. Release any host-owned preparation lease,
        // without turning an unmount into a stop of an already-running turn.
        if (abortRef.current?.signal === signal) abortRef.current.abort();
        throw new Error("Agent host changed during turn preparation");
      }
    };
    const prepared = args.prepareTurn?.(id, signal);
    // Preserve synchronous hosts: even awaiting undefined adds a microtask,
    // which can collapse a short stream's sending edge into its settlement.
    if (prepared) return prepared.then(checkTarget);
    checkTarget();
  }, [args.prepareTurn]);

  // LAG-2: frame-coalesced stream deltas — the buffering derivation lives in
  // its own module (the file-size ratchet); this hook drains the returned
  // flush handle before every tool event (via the stream callbacks below)
  // and every settle/abort/failure clear. LAG-3: the flush writes land in
  // the stores (feed + live-stream), never hook state — no flush render
  // reaches this hook's host.
  const { pushStreamDelta, flushDeltaBuffer } = useAgentDeltaBuffer({
    kind,
    scheduler,
  });

  // DR-11: publish the local streaming flag into the shared mirror store —
  // a derived copy only (see `streamingMirrorKey`). The cleanup drops the
  // flag so an owner switch or unmount can never leave a stuck "streaming"
  // key behind; the effect body then re-publishes the current value.
  useEffect(() => {
    if (streamingMirrorKey === undefined) return;
    useAgentStreamingStore.getState().setStreaming(streamingMirrorKey, isSending);
    return () => {
      useAgentStreamingStore.getState().setStreaming(streamingMirrorKey, false);
    };
  }, [streamingMirrorKey, isSending]);

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

  // TAG-9: ONE builder for the SSE→store callbacks, shared by every entry
  // point (field-for-field with the persisted extraction, CD-1); it lives in
  // `agent-stream-callbacks.ts` (the file-size ratchet).
  const createStreamCallbacks = (activeThreadId: string, sawStreamEvent: { current: boolean }): CopilotStreamOpts =>
    createAgentStreamCallbacks({
      kind, pushStreamDelta, flushDeltaBuffer, applyPlanToolResult,
      onObserving: () => attachment.observing(),
    }, activeThreadId, sawStreamEvent);
  const buildStreamCallbacks = (id: string, saw: { current: boolean }): CopilotStreamOpts => {
    const controller = abortRef.current;
    return guardAgentStreamCallbacks(createStreamCallbacks(id, saw),
      () => controller !== null && !controller.signal.aborted && attachment.isCurrent(controller, id));
  };

  const attachment = useAgentRunAttachment({
    kind, threadId, transport, abortRef, isSendingRef,
    setIsSending,
    buildCallbacks: buildStreamCallbacks,
    clearOptimistic: () => {
      setPendingUserContent("");
      setPendingUserAttachments([]);
      setPendingAskAnswer(null);
      setPendingPermissionAnswer(null);
    },
    reset: () => {
      // LAG-2/LAG-3: drain, then drop the live pair; the store outlives a
      // remount, and a replay rebuilds the text from cursor zero.
      flushDeltaBuffer();
      if (threadId !== null) useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
      setIsSending(false);
      setPendingUserContent("");
      setPendingUserAttachments([]);
    },
    settled: (result, error) => {
      if (threadId === null) return;
      writeTurnFailure(agentThreadKey(kind, threadId), error ? copilotTurnFailureOf(error) : null);
      const metrics = experienceCopilotContextMetricsSchema.safeParse(result?.metrics);
      onMetrics?.(metrics.success ? metrics.data : null);
      onTurnSettled?.(error === undefined && result !== null && result.finishReason !== "cancelled");
    },
  });

  const handleSend = useCallback(
    async (content: string, opts?: AgentSendOptions): Promise<void> => {
      const discovery = threadId ? attachment.waitForDiscovery(threadId) : undefined;
      if (discovery && !await discovery) return;
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

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      const failureKey = agentThreadKey(kind, threadId);
      const start = async () => {
        const prepared = prepareTurn(threadId, controller.signal);
        if (prepared) await prepared;
        // Preparation is durable before the old activities disappear or the
        // rising-edge effect takes the next turn's snapshot.
        useAgentTurnStore.getState().clearTurn(kind, threadId);
        setPendingAskAnswer(null);
        setPendingPermissionAnswer(null);
        writeTurnFailure(failureKey, null);

        setIsSending(true);
        // LAG-2: drain anything still buffered before the turn-start clear
        // (a settled turn already drained; this is the no-drop belt-and-braces).
        flushDeltaBuffer();
        useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
        setPendingUserContent(trimmed);
        setPendingUserAttachments(attachments);

        return transport.sendStream(
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
      };
      try {
        const streamResult = await start().catch((error: unknown) => attachment.followExisting(error, threadId, controller, buildStreamCallbacks(threadId, { current: false })));
        if (!attachment.isCurrent(controller, threadId)) return;

        // CM-7: surface the finish event's segmented metrics to the meter.
        // The stream return value carries `metrics` (unknown from the parser);
        // validate once here so the hook only ever sees the wire shape.
        const rawMetrics = streamResult.metrics;
        const parsedMetrics = rawMetrics != null
          ? experienceCopilotContextMetricsSchema.safeParse(rawMetrics)
          : null;
        onMetrics?.(parsedMetrics?.success ? parsedMetrics.data : null);

        // LAG-2: drain before the settle clear — the last frame's buffered
        // deltas land in the feed so the persisted/live text stays identical.
        flushDeltaBuffer();
        useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
        setIsSending(false);
        isSendingRef.current = false;
        // AP-13: the turn answered — the card clears with the failure.
        writeTurnFailure(failureKey, null);
        onTurnSettled?.(streamResult.finishReason !== "cancelled");
      } catch (error) {
        if (!attachment.isCurrent(controller, threadId)) return;
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          // AP-13: the turn failure owns the surface — the card renders the
          // category description, so the toast is gone.
          writeTurnFailure(failureKey, copilotTurnFailureOf(error));
        }
        // LAG-2: drain before the failure/abort clear — buffered deltas land
        // in the feed (byte-identical to per-token writes), the frame is
        // cancelled, and nothing can write after the clear.
        flushDeltaBuffer();
        useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
        setIsSending(false);
        isSendingRef.current = false;
        // A cancelled turn is NOT a success (SC-18): the pending chips stay
        // for a retry — same as a failure.
        onTurnSettled?.(false);
      } finally {
        if (attachment.isCurrent(controller, threadId)) {
          abortRef.current = null;
          setPendingUserContent("");
          setPendingUserAttachments([]);
        }
      }
    },
    [kind, threadId, providerProfileId, model, transport, onTurnSettled, onMetrics, applyPlanToolResult, pushStreamDelta, flushDeltaBuffer, prepareTurn],
  );

  const handleAnswer = useCallback(
    async (toolCallId: string, answer: CopilotAnswerInput, opts?: AgentSendOptions): Promise<void> => {
      const discovery = threadId ? attachment.waitForDiscovery(threadId) : undefined;
      if (discovery && !await discovery) return;
      // SC-23f: the decision is just another answer-union member on this
      // SAME path — `decision` present = the permission family, absent =
      // the ask family. The wire union members are both `.strict()`, so a
      // mixed body (decision + text/skipped) matches NEITHER and is refused
      // here, before any stream call. DMT-31: `instruction` is ALLOW-only
      // (the wire's refinement refuses it on deny; a prompt-read allow never
      // sends one) — refused here with the same silent guard, before any
      // stream call.
      const decision = "decision" in answer ? answer.decision : undefined;
      const text = "text" in answer ? answer.text?.trim() : undefined;
      const skipped = "skipped" in answer && answer.skipped === true;
      const instruction = "instruction" in answer ? answer.instruction : undefined;
      if (decision !== undefined && (text !== undefined || skipped)) return;
      if (decision !== undefined && decision !== "allow" && decision !== "deny") return;
      if (decision === "deny" && instruction !== undefined) return;

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

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      const failureKey = agentThreadKey(kind, threadId);
      const sawStreamEvent = { current: false };
      const start = async () => {
        const prepared = prepareTurn(threadId, controller.signal);
        if (prepared) await prepared;
        // Both split-turn answer families obey the same durable barrier.
        useAgentTurnStore.getState().clearTurn(kind, threadId);
        writeTurnFailure(failureKey, null);

        setIsSending(true);
        // LAG-2: drain anything still buffered before the turn-start clear
        // (same belt-and-braces as the send path).
        flushDeltaBuffer();
        useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
        // No new user row; flip only the submitted answer family.
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

        return transport.answerAsk(
          threadId,
          {
            answer: {
              toolCallId,
              ...(text ? { text } : {}),
              ...(skipped ? { skipped: true } : {}),
              ...(decision !== undefined ? { decision } : {}),
              // DMT-31: the user-edited swipe instruction rides the allow
              // decision VERBATIM — the exact UI-approved text reaches the
              // server through the original permission answer transport.
              // Never the ask `text` slot, never a sidechat user row; the
              // server runs it instead of the recorded draft and its
              // validation (min length / deny refusal) is the wire contract.
              ...(decision !== undefined && instruction !== undefined ? { instruction } : {}),
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
            // DMT-24b (owner ruling 2026-11-06): an allowed swipe's absorbed
            // run failure arrives as the ESTABLISHED generation-failure toast
            // — the answer request itself succeeded (the receipt stored, the
            // card keeps its granted state, no optimistic rollback), so the
            // failure owns no card; the toast is its only surface. Wired on
            // the LIVE answer path only — the shared callback builder stays
            // toast-free so a BR-3a run replay never re-fires it. Mapping:
            // failed → the swipe-failed key with the provider reason as the
            // description; no_output → the no-output key; cancelled → NO
            // toast here (pinned: every reachable cancelled frame already
            // has the established cancel toast — the RP chat's attached-run
            // Stop toasts `generation_cancelled` at use-chat-controller, and
            // cancelling the answer turn itself aborts the stream before the
            // tail frame can parse); completed is never emitted.
            onSwipeRunOutcome: ({ outcome }) => {
              if (outcome.status === "failed") {
                toast.error(getT()("copilot_permission_swipe_run_failed"), { description: outcome.reason });
                return;
              }
              if (outcome.status === "no_output") {
                toast.error(getT()("copilot_permission_swipe_run_no_output"));
              }
            },
          },
        );
      };
      try {
        const streamResult = await start().catch((error: unknown) => attachment.followExisting(error, threadId, controller, buildStreamCallbacks(threadId, sawStreamEvent)));
        if (!attachment.isCurrent(controller, threadId)) return;

        // Same CM-7 metrics surfacing as handleSend.
        const rawMetrics = streamResult.metrics;
        const parsedMetrics = rawMetrics != null
          ? experienceCopilotContextMetricsSchema.safeParse(rawMetrics)
          : null;
        onMetrics?.(parsedMetrics?.success ? parsedMetrics.data : null);

        // LAG-2: drain before the settle clear (the send path's invariant).
        flushDeltaBuffer();
        useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
        setIsSending(false);
        isSendingRef.current = false;
        // AP-13: the turn answered — the card clears with the failure.
        writeTurnFailure(failureKey, null);
        onTurnSettled?.(streamResult.finishReason !== "cancelled");
      } catch (error) {
        if (!attachment.isCurrent(controller, threadId)) return;
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
        // LAG-2: drain before the failure/abort clear (the send path's
        // invariant — nothing can write after the clear).
        flushDeltaBuffer();
        useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.(false);
      } finally {
        if (attachment.isCurrent(controller, threadId)) abortRef.current = null;
      }
    },
    [kind, threadId, providerProfileId, model, transport, onTurnSettled, onMetrics, applyPlanToolResult, pushStreamDelta, flushDeltaBuffer, prepareTurn],
  );

  // AP-10: the turn actions live in their own module (the file-size
  // ratchet) — fed with the controller's send, callback builder, and turn
  // state, re-exposed on the controller's contract below.
  const turnActions = useAgentTurnActions({
    waitForDiscovery: attachment.waitForDiscovery,
    isCurrentTurn: attachment.isCurrent,
    followExistingRun: attachment.followExisting,
    prepareTurn,
    kind,
    transport,
    threadId,
    providerProfileId,
    model,
    onTurnSettled,
    onMetrics,
    applyPlanToolResult,
    threadMessages,
    feedOutcome,
    sendTurn: handleSend,
    buildStreamCallbacks,
    turnState: {
      isSendingRef,
      abortRef,
      setIsSending,
      // LAG-3: the live stream pair clears through the live-stream store
      // (bound to the CURRENT thread — the regenerate guards it non-null).
      clearLiveStreamText: () => {
        if (threadId !== null) useAgentLiveStreamStore.getState().clearLiveStreamText(kind, threadId);
      },
      // LAG-2: the turn actions drain the shared buffer before their clears —
      // the ONE buffering derivation stays here in the controller.
      flushDeltaBuffer,
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

  const handleCancel = attachment.cancel;

  return { isSending, pendingUserContent, pendingUserAttachments, pendingAskAnswer, pendingPermissionAnswer, turnFailure, handleSend, handleAnswer, handleRegenerate: turnActions.handleRegenerate, handleDeleteTurn: turnActions.handleDeleteTurn, handleEditAssistant: turnActions.handleEditAssistant, handleEditLast: turnActions.handleEditLast, pendingDelete: turnActions.pendingDelete, requestDeleteTurn: turnActions.requestDeleteTurn, confirmDeleteTurn: turnActions.confirmDeleteTurn, cancelDeleteTurn: turnActions.cancelDeleteTurn, isRegenerating: turnActions.isRegenerating, hiddenRegeneratedIds: turnActions.hiddenRegeneratedIds, handleCancel };
}
