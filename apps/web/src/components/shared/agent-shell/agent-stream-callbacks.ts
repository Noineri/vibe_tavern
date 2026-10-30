import type { AgentKind, CopilotStreamOpts } from "../../../lib/agent-host-registry.js";
import {
  useAgentTurnStore,
  parseTodoToolResult,
  parseTodoToolArgs,
  parseAgentAskState,
  parseAgentPermissionState,
} from "../../../stores/agent-turn-store.js";
import { parseAgentPlanToolResult } from "../../../hooks/use-agent-plan.js";
import {
  coauthorSkillReadOutputSchema,
  experienceCopilotToolOutputSchema,
} from "@vibe-tavern/api-contracts";

/**
 * The agent shell's SSE→store callbacks (TAG-9), moved out of
 * `use-agent-controller.ts` unchanged (the file-size ratchet). ONE builder
 * shared by every controller entry point — send, answer, regenerate and the
 * BR-3a replay reader: the live tool routing must stay field-for-field with
 * the persisted extraction (CD-1), so every path drives the IDENTICAL wiring;
 * `sawStreamEvent` lets the answer path distinguish a pre-stream failure
 * (backend never rewrote the ask row) from a mid-stream one. The controller
 * still owns the delta buffer (LAG-2), the plan cache hook and the run
 * attachment; this module only receives their handles.
 */
export interface AgentStreamCallbackDeps {
  kind: AgentKind;
  /** LAG-2: the frame-coalescing buffer's push/drain handles. */
  pushStreamDelta: (activeThreadId: string, slot: "text" | "reasoning", delta: string) => void;
  flushDeltaBuffer: () => void;
  /** PM-6: the shell's useAgentPlan applyToolResult. */
  applyPlanToolResult?: (args: unknown, output: unknown) => void;
  /** BR-3a: the run attachment learns the server owns the turn. */
  onObserving: () => void;
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

export function createAgentStreamCallbacks(
  deps: AgentStreamCallbackDeps,
  activeThreadId: string,
  sawStreamEvent: { current: boolean },
): CopilotStreamOpts {
  const { kind, pushStreamDelta, flushDeltaBuffer, applyPlanToolResult, onObserving } = deps;
  return {
    onStatus: (status) => {
      if (status === "preparing" || status === "streaming") onObserving();
      if (status === "streaming") sawStreamEvent.current = true;
    },
    onChunk: (delta) => {
      pushStreamDelta(activeThreadId, "text", delta);
    },
    onReasoningChunk: (delta) => {
      pushStreamDelta(activeThreadId, "reasoning", delta);
    },
    onToolCall: (info) => {
      // LAG-2: buffered text must never land after the activity that follows
      // it — drain BEFORE closeTextSegment closes the segment.
      flushDeltaBuffer();
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
      // LAG-2: same drain-before-close as onToolCall (the invariant holds for
      // every tool event that closes the text segment).
      flushDeltaBuffer();
      useAgentTurnStore.getState().closeTextSegment(kind, activeThreadId);
      useAgentTurnStore.getState().appendActivityRef(kind, activeThreadId, info.toolCallId);
      useAgentTurnStore.getState().upsertActivity(kind, activeThreadId, {
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        status: "streaming",
      });
    },
    onToolResult: (info) => {
      // LAG-2: same drain-before-close as onToolCall (the invariant holds for
      // every tool event that closes the text segment).
      flushDeltaBuffer();
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
  };
}
