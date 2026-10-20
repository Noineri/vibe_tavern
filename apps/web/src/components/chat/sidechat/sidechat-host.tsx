/**
 * The `sidechat-ooc` agent host (SIDECHAT_PLAN, Wave 4 / SC-13b) — the
 * out-of-character discussion beside an RP chat as the THIRD registered host
 * of the generic `AgentShell`, and the FIRST chat-owned one (module-load
 * registration, like `script-agent-host.tsx`; SC-14's panel imports this
 * module for the descriptor and the owner selector).
 *
 * Everything the shell deliberately does not know lives here: the chat+branch
 * owner (the snapshot store's active chat + active branch), the transport
 * (the experience client's thread-keyed members — the server dispatches the
 * thread routes by the thread's kind — composed with the SC-0c chat client's
 * owner-keyed members), the branch plan owner, the chat profile assignment,
 * the kind's five tool toggles, the RP-model default binding, the five meter
 * segment labels, and the search/read tool captions.
 *
 * Chat-only host: no `renderEditorPane` (the shell renders the mini-app
 * assistant's chat pane), no record-proposal renderers yet (the objective
 * card is SC-13c's — the AS-5 fallback covers every recordType until then).
 */
import { SIDECHAT_OOC_TOOL_KEYS } from "@vibe-tavern/api-contracts";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import {
  chatOwnerTriple,
  registerAgentHost,
  type AgentDefaultModelContext,
  type AgentPlanOwnerContext,
} from "../../../lib/agent-host-registry.js";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { parseAgentToolOutput } from "../../../lib/agent-tool-output.js";
import {
  activateExperienceCopilotSession,
  answerCopilotAsk,
  listExperienceCopilotMessages,
  renameExperienceCopilotSession,
  setExperienceCopilotContextLinks,
  streamExperienceCopilot,
} from "../../../api/experience-copilot-api.js";
import {
  getAgentChatActive,
  listAgentChatSessions,
  startAgentChatSession,
} from "../../../api/agent-chat-api.js";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";

/**
 * The sidechat's thread owner for the active chat + active branch (SC-14's
 * panel builds its shell owner through this — the host module is the pair).
 * Null while either is missing (no chat open yet) — the panel renders nothing
 * then. Mode-agnostic on purpose: whether the chat's mode is served is the
 * `selectSidechatServedChatModes` selector's answer, never a second
 * hard-coded mode check here.
 */
export function selectSidechatOwner(
  activeChat: { id: string } | null,
  activeBranch: { id: string } | null,
): AgentThreadOwner | null {
  if (activeChat === null || activeBranch === null) return null;
  return { kind: "chat", chatId: activeChat.id, branchId: activeBranch.id, agentKind: SIDECHAT_AGENT_KIND };
}

/** Read one non-empty string field off an opaque tool-call args object. */
function readArgsField(args: unknown, field: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The sidechat's `search_context` / `read_context_item` captions (owner 6) —
 * the machine-shaped result envelopes must never render as raw JSON titles
 * (live `summarizeToolOutput` or the persisted tool-result text on reload).
 * `search_context`: the query comes from `activity.args` (the search output
 * carries `{ results }` but no query), the count is the output's
 * `results.length`. `read_context_item`: the title comes from the output.
 * Anything unparseable → undefined (the shell's fallback). Any other tool →
 * undefined.
 */
function sidechatToolCaption(activity: AgentToolActivity): {
  titleKey: "sidechat_search_caption" | "sidechat_read_caption";
  titleParams: Record<string, string | number>;
} | undefined {
  if (activity.toolName === "search_context") {
    const query = readArgsField(activity.args, "query");
    if (query === undefined) return undefined;
    const record = parseAgentToolOutput(activity);
    const results = record !== undefined ? record.results : undefined;
    if (!Array.isArray(results)) return undefined;
    return { titleKey: "sidechat_search_caption", titleParams: { query, count: results.length } };
  }
  if (activity.toolName === "read_context_item") {
    const record = parseAgentToolOutput(activity);
    if (record === undefined) return undefined;
    const title = readArgsField(record, "title");
    if (title === undefined) return undefined;
    return { titleKey: "sidechat_read_caption", titleParams: { title } };
  }
  return undefined;
}

/**
 * The sidechat's first model default (owner 2, corrected SC-7): the RP chat's
 * active provider profile (`isActive`) with its `defaultModel` — the very
 * pair SC-7's route returns (`providers.getActive()` + `defaultModel`), read
 * without a fetch (the hook is synchronous and pure, and a fetched default
 * loses the race to the shell's first-profile fallback). A saved binding
 * still wins (SC-0e: the hook consults this ONLY with no usable saved pair).
 * No active profile (or no default model on it) → undefined (the shell's
 * first-available fallback). Must stay pure.
 */
function sidechatDefaultModelBinding(ctx: AgentDefaultModelContext): {
  providerProfileId: string;
  modelName?: string | null;
} | undefined {
  const active = ctx.profiles.find((profile) => profile.isActive);
  if (active === undefined) return undefined;
  return {
    providerProfileId: active.id,
    ...(typeof active.defaultModel === "string" && active.defaultModel !== "" ? { modelName: active.defaultModel } : {}),
  };
}

registerAgentHost({
  kind: SIDECHAT_AGENT_KIND,
  i18n: {
    title: "agent_title",
    placeholder: "sidechat_input_placeholder",
    loading: "agent_loading",
    emptyTitle: "agent_title",
    emptySub: "sidechat_empty_hint",
  },
  // The toggleable tool keys of the sidechat profiles — the wire contract's
  // five keys (the single source for toggleable-tool names), so the shared
  // profile modal never branches on the kind.
  toolKeys: SIDECHAT_OOC_TOOL_KEYS,
  // SC-0g: the sidechat's profile choice is chat-owned (the modal's "use
  // here" writes the (chat, kind) row, "use by default" the kind default).
  profileAssignment: { target: "chat" },
  // Chat-only host: no editor pane (absent = the shell's chat pane, the
  // mini-app assistant's chat pane) and no buffers to edit.
  bufferSpecs: [],
  // The transport seam — the experience client's thread-keyed members (the
  // server dispatches the thread routes by the thread's kind) composed with
  // the SC-0c chat client's owner-keyed members (chat owners route to the
  // SC-0b routes, narrowed back to chat+branch+kind in one line each).
  transport: {
    sendStream: streamExperienceCopilot,
    answerAsk: answerCopilotAsk,
    getActiveThread: (owner) => {
      const triple = chatOwnerTriple(owner);
      return getAgentChatActive(triple.chatId, triple.branchId, triple.agentKind);
    },
    listMessages: listExperienceCopilotMessages,
    startSession: (owner, title?) => {
      const triple = chatOwnerTriple(owner);
      return startAgentChatSession(triple.chatId, triple.branchId, triple.agentKind, title);
    },
    listSessions: (owner) => {
      const triple = chatOwnerTriple(owner);
      return listAgentChatSessions(triple.chatId, triple.branchId, triple.agentKind);
    },
    activateSession: activateExperienceCopilotSession,
    renameSession: renameExperienceCopilotSession,
    setContextLinks: setExperienceCopilotContextLinks,
  },
  buildSendOptions: (ctx) => ctx.bridge.session?.buildSendOptions() ?? {},
  // SC-0i: the sidechat's plan is branch-owned (the shell's plan section
  // reads/writes the branch route through this owner).
  planOwner: (ctx: AgentPlanOwnerContext) => {
    const triple = chatOwnerTriple(ctx.owner);
    return { kind: "chatBranch", chatId: triple.chatId, branchId: triple.branchId };
  },
  toolCaption: (activity) => sidechatToolCaption(activity),
  defaultModelBinding: (ctx) => sidechatDefaultModelBinding(ctx),
  // SC-0j: the kind-provided meter segment labels — the five SC-9 segment
  // keys with their i18n keys (the meter resolves each through `useT`).
  meterSegmentLabels: {
    context: "sidechat_meter_context",
    rp_summaries: "sidechat_meter_rp_summaries",
    rp_messages: "sidechat_meter_rp_messages",
    digest: "sidechat_meter_digest",
    discussion: "sidechat_meter_discussion",
  },
  // No record-proposal renderers yet — the AS-5 fallback card covers every
  // recordType until SC-13c registers the objective card.
  recordProposalRenderers: {},
});
