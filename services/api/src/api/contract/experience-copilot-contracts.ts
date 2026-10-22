/** Runtime contracts for the experience-copilot subsystem — extracted from
 *  runtime-api.ts for the size ratchet (AS-2c); re-exported there so every
 *  existing import path keeps resolving. */

// ─── Experience Copilot (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 2 / ER-6) ───────

import type { ExperienceCopilotStreamRequest, ExperienceCopilotStreamEvent } from "../../domain/interactive/copilot/experience-copilot-stream.js";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextMetrics, ExperienceCopilotContextLink, AgentKindSettingsWire, AgentKindSettingsPatchRequest, AgentChatSettingsWire, AgentChatSettingsPatchRequest, AgentThreadEventWire, AgentBranchForkSidechatResult, AgentBranchSidechatSummary } from "@vibe-tavern/api-contracts";
import type { RecordProposal } from "@vibe-tavern/api-contracts";

/** GET/PATCH `/context` response: the thread's last-turn metrics (null before the
 *  first turn) plus its auto-compact toggle (CM-4). */
export interface ExperienceCopilotContextState {
  metrics: ExperienceCopilotContextMetrics | null;
  autoCompact: boolean;
}

/** POST `/compact` response (CM-5): the new digest message + the recomputed
 *  post-compaction metrics (source always "estimate" — the provider only
 *  reports usage on an actual turn; the next turn refines it). */
export interface ExperienceCopilotCompactResult {
  digest: ExperienceCopilotMessageWire;
  metrics: ExperienceCopilotContextMetrics;
}

/** POST `/turns/delete` request (AP-8): delete the turn resolved around
 *  `messageId`. The server resolves the ENCLOSING turn (the rows after a user
 *  row up to the next user row — continuation rows after an ask/permission
 *  answer included); `messageId` may point at ANY row of that turn, or at the
 *  user row itself (then only with `includeUserMessage: true`). */
export interface ExperienceCopilotTurnDeleteRequest {
  messageId: string;
  /** Also delete the turn's user row — the user's own delete on their
   *  message. Required `true` when `messageId` addresses a user row. */
  includeUserMessage: boolean;
}

/** POST `/turns/delete` response (AP-8): every deleted row id in timeline
 *  order (the user row included when it was deleted), plus which of them was
 *  the user row. The client removes exactly these ids from its local list. */
export interface ExperienceCopilotTurnDeleteResult {
  deletedMessageIds: string[];
  deletedUserMessageId: string | null;
}

/** The experience-copilot streaming subsystem — a standalone, editor-embedded
 *  pair-editor (own endpoint, own tables — ER-3) that proposes rules/visual
 *  edits via tools (ER-4) and streams one turn at a time. NOT a chat-mode and
 *  NOT the multi-mode AI-assistant. The stream yields SSE-shaped
 *  `{ event, data }` chunks (same contract as `sendMessageStream`) so the route
 *  emits them verbatim through `streamSSE`. */

/** The SC-11 apply/reject response: the resolved proposal with its final
 *  `status` (`applied` / `rejected`) — the same `RecordProposal` shape the
 *  tool row carries, so SC-13's review card re-renders from it directly. */
export interface AgentThreadProposalResolveWire {
  proposal: RecordProposal;
}

export interface ExperienceCopilotRuntimeApi {
	/** Resolve the agent kind serving a stream turn's script — the AS-2c
	 *  kind-resolution seam. Loads the thread (404 when missing), then the
	 *  script row, and resolves `script.scriptKind` through the agent-kind
	 *  registry; a script kind no registered kind serves throws
	 *  `NoAgentKindForScriptKindError` (the route maps it to a 400 BEFORE any
	 *  SSE headers are sent). Draft threads (no scriptId) and dangling script
	 *  links resolve nothing — the turn streams exactly as before. */
	experienceCopilotAssertStreamKind: (threadId: string) => Promise<void>;

	/** Stream one copilot turn for a thread. Loads the thread context, assembles
	 *  the prompt (ER-5), builds the tools (ER-4), streams via `streamText`, and
	 *  yields SSE events (`text-delta`, `reasoning-delta`, `tool-call`,
	 *  `tool-result`, `finish`, `error`). Persists the turn (user message + tool
	 *  calls/results + final assistant text) to the ER-3 store. */
	experienceCopilotStream: (threadId: string, body: Omit<ExperienceCopilotStreamRequest, "threadId">, signal?: AbortSignal) => AsyncGenerator<ExperienceCopilotStreamEvent>;

	/** The single active (unarchived) thread for a script, or null. Delegates to
	 *  the ER-3 store's `getActive`. */
	experienceCopilotGetActive: (scriptId: string) => Promise<ExperienceCopilotThreadWire | null>;

	/** All messages for a thread, oldest → newest. Delegates to the ER-3 store's
	 *  `listMessages`. */
	experienceCopilotListMessages: (threadId: string) => Promise<ExperienceCopilotMessageWire[]>;

	/** Archive the current active thread (if any) and create a fresh active one.
	 *  Delegates to the ER-3 store's `startNewSession` (single-tx archive-then-
	 *  insert). */
	experienceCopilotStartNewSession: (scriptId: string, title?: string) => Promise<ExperienceCopilotThreadWire>;

	/** All sessions (active + archived) for a script, newest first. Delegates
	 *  to the ER-3 store's `listSessions`. */
	experienceCopilotListSessions: (scriptId: string) => Promise<ExperienceCopilotThreadWire[]>;

	/** Resume an archived session (archiving its active sibling, if any), or a
	 *  no-op when it is already active. Delegates to the ER-3 store's
	 *  `activate`. Returns null when the thread does not exist. */
	experienceCopilotActivate: (sessionId: string) => Promise<ExperienceCopilotThreadWire | null>;

	/** Archive a single session (idempotent). Delegates to the ER-3 store's
	 *  `archive`. Returns null when the thread does not exist. */
	experienceCopilotArchive: (sessionId: string) => Promise<ExperienceCopilotThreadWire | null>;
	/** Rename a session (trim; empty title clears back to the auto-numbered
	 *  fallback). Returns the updated wire thread, or null when not found. */
	experienceCopilotRenameSession: (
		sessionId: string,
		title: string,
	) => Promise<ExperienceCopilotThreadWire | null>;

	/** Read a thread's last-turn context metrics + auto-compact toggle (CM-4).
	 *  `metrics` is null before the first turn. */
	experienceCopilotGetContext: (threadId: string) => Promise<ExperienceCopilotContextState>;

	/** Toggle the thread's auto-compact flag (CM-4). Returns the full context
	 *  state (`{ metrics, autoCompact }`) so the client can replace its local copy. */
	experienceCopilotPatchContext: (threadId: string, body: { autoCompact?: boolean }) => Promise<ExperienceCopilotContextState>;

	// CX-4: pinned-context links — GET reads, set is a full replace (the client computes add/remove).
	experienceCopilotGetContextLinks: (threadId: string) => Promise<ExperienceCopilotContextLink[]>;
	experienceCopilotSetContextLinks: (threadId: string, links: ExperienceCopilotContextLink[]) => Promise<ExperienceCopilotContextLink[]>;

	/** Manually compact a thread (CM-5): LLM-summarize everything older than the
	 *  keep-window into a new `role: "digest"` message (anchor in `toolCallId`).
	 *  `providerProfileId`/`model` are required when the thread has no last-used
	 *  pair. Rejects 400 when there is nothing to compact; 409 when a compaction
	 *  is already in-flight; provider errors surface as 502 via the global handler. */
	experienceCopilotCompact: (threadId: string, body: { providerProfileId?: string; model?: string }, signal?: AbortSignal) => Promise<ExperienceCopilotCompactResult>;

	/** Delete one turn of a thread (AP-8): resolve the turn enclosing the
	 *  request's `messageId` (user-row boundaries — continuation rows after an
	 *  ask/permission answer belong to the same turn) and delete its message
	 *  rows, together with the turn's user row when `includeUserMessage` is
	 *  set. Rows a context digest already folded are refused — the digest is a
	 *  floor, the user deletes from the newest turn backward (409, the compact
	 *  conflict family). A `messageId` on a user row without the flag is a 400;
	 *  a missing thread/message is a 404. Chat-owned threads delete message
	 *  rows only: frozen context events and the frontier are never touched
	 *  (an event left between turns keeps its seq on the merged timeline). */
	experienceCopilotDeleteTurn: (
		threadId: string,
		body: ExperienceCopilotTurnDeleteRequest,
	) => Promise<ExperienceCopilotTurnDeleteResult>;

	// ─── Chat-owner lifecycle (SIDECHAT_PLAN SC-0b) ─────────────────────────────
	//
	// The chat-branch-owner twins of the script lifecycle above: a
	// (chat, branch, kind) triple instead of a script id, on the same store.
	// Every member validates the kind through the registry FIRST (a 400-class
	// client error needs no store I/O), then the (chat, branch) pair (404).

	/** The single active (unarchived) thread for a (chat, branch, kind) triple,
	 * or null — the chat-owner twin of {@link experienceCopilotGetActive}.
	 * Delegates to the ER-3 store's `getActiveForChat`. */
	agentChatGetActive: (chatId: string, branchId: string, kind: string) => Promise<ExperienceCopilotThreadWire | null>;

	/** All sessions (active + archived) for a (chat, branch, kind) triple,
	 * newest first — the chat-owner twin of {@link experienceCopilotListSessions}.
	 * Delegates to the ER-3 store's `listSessionsForChat`. */
	agentChatListSessions: (chatId: string, branchId: string, kind: string) => Promise<ExperienceCopilotThreadWire[]>;

	/** Archive the current active sibling of the (chat, branch, kind) triple
	 * (if any) and create+return a fresh active one — the chat-owner twin of
	 * {@link experienceCopilotStartNewSession}. Delegates to the ER-3 store's
	 * `startNewChatSession` (single-tx archive-then-insert). */
	agentChatStartNewSession: (chatId: string, branchId: string, kind: string, title?: string) => Promise<ExperienceCopilotThreadWire>;

	// ─── Per-kind model settings (SIDECHAT_PLAN SC-0d) ─────────────────────
	//
	// The kind-scoped model binding + profile default behind
	// `GET/PATCH /api/agent/kinds/:kind/settings`. Serves EVERY registered
	// kind (no chat-owner restriction — a kind's remembered default exists
	// regardless of who owns its threads). The binding is a UI default only:
	// the stream and compaction keep taking provider/model from each request.

	/** One kind's effective settings: the kind's row, or the legacy
	 *  `ui_settings` copilot pair when the kind has no row yet (owner
	 *  decision 2 — nobody loses their choice). Validates the kind through
	 *  the registry first (an unregistered kind is the 400-class
	 *  `UnknownAgentKindError`, no store I/O). */
	agentKindGetSettings: (kind: string) => Promise<AgentKindSettingsWire>;

	/** Upsert one kind's row: only the fields the body carries are written
	 *  (absent keeps the stored value, `null` clears it). Same registry
	 *  validation as {@link agentKindGetSettings}. */
	agentKindPatchSettings: (kind: string, body: AgentKindSettingsPatchRequest) => Promise<AgentKindSettingsWire>;

	// ─── Per-(chat, kind) profile choice (SIDECHAT_PLAN SC-0f) ───────────────
	//
	// The chat-scoped profile choice behind `GET/PATCH
	// /api/agent/chats/:chatId/:kind/settings` — the "use here" override the
	// stream's profile chain consults BEFORE the kind default (SC-0d's
	// `default_profile_id`). Unlike the kind-scoped twin these routes are
	// CHAT-OWNER routes: the kind must be chat-owned (`getChatOwnedAgentKind` —
	// a script-owned kind is the 400 `AGENT_KIND_NOT_CHAT_OWNED`, the SC-0b
	// family), and the chat must exist (404).

	/** One (chat, kind) pair's settings: the pair's row, or `profileId: null`
	 *  with `updatedAt: null` when the pair has no row yet (a chat row has no
	 *  legacy fallback). Validates the kind through the registry first (400
	 *  class, no store I/O), then the chat's existence (404). */
	agentChatGetSettings: (chatId: string, kind: string) => Promise<AgentChatSettingsWire>;

	/** Upsert one (chat, kind) pair's row: only the fields the body carries
	 *  are written (absent keeps the stored value, `null` clears it). Same
	 *  validation order as {@link agentChatGetSettings}. */
	agentChatPatchSettings: (chatId: string, kind: string, body: AgentChatSettingsPatchRequest) => Promise<AgentChatSettingsWire>;

	// ─── Agent-thread frozen events (SIDECHAT_PLAN Wave 5 / SC-19a) ─────────
	//
	// The per-thread events read behind `GET
	// /api/agent/threads/:threadId/events` — the chat-owned twin family of
	// the SC-11 proposal routes (same `/api/agent/threads/:threadId/...`
	// prefix). The messages route is untouched: the message wire carries no
	// `seq`, so the events get their own route with a server-computed anchor.

	/** A chat-owned thread's frozen context events in merged-timeline order
	 *  (SC-1 `listTimeline`), each `{ id, kind, payload, beforeMessageId }`:
	 *  the payload is the event mapped through the SAME parser the context
	 *  loader uses (`mapTimelineEvent`, sidechat-context.ts — one derivation,
	 *  its corrupt-payload refusal included); `beforeMessageId` is the first
	 *  message row after the event on the merged timeline, `null` when the
	 *  event is the newest row. A script-owned / draft thread → `[]`; a
	 *  missing thread is the 404 `notFound` (the sibling convention). */
	agentThreadListEvents: (threadId: string) => Promise<AgentThreadEventWire[]>;

	// ─── Branch-sidechat fork + summary (SIDECHAT_PLAN Wave 5 / SC-20) ─────
	//
	// The route pair behind `POST …/branches/:branchId/fork-sidechat` and
	// `GET …/branches/:branchId/sidechat-summary` — the chat-owner family of
	// SC-0b's session routes. The whole fork (ownership, the typed 400 for a
	// non-child target, the id remap, the store copy, the plan copy) lives in
	// domain/sidechat/branch-sidechat-fork.ts; these members are thin wiring.

	/** Copy the source branch's ACTIVE chat-owned threads (every kind the
	 *  store has rows for) onto `targetBranchId`, with the branch plan; the
	 *  source is never modified, archived sessions are not copied, metrics
	 *  reset. 404 for a missing chat / source / target branch (the SC-0b
	 *  family); the typed 400 `target_branch_not_child_of_source` when the
	 *  target's `parent_branch_id` is not the source (or its fork point no
	 *  longer resolves there). Returns the copied threads. */
	agentBranchForkSidechat: (
		chatId: string,
		sourceBranchId: string,
		targetBranchId: string,
	) => Promise<AgentBranchForkSidechatResult>;

	/** Whether the branch has any ACTIVE (non-archived) chat-owned thread
	 *  sessions, and how many — SC-21's web confirms read this before
	 *  offering the fork. Same 404 pair as the fork. */
	agentBranchSidechatSummary: (chatId: string, branchId: string) => Promise<AgentBranchSidechatSummary>;
}

// ─── Thread proposal resolution (SIDECHAT_PLAN SC-11) ───────────────────────
//
// The user-side Accept/Reject of a sidechat `propose_objective` proposal
// behind `POST /api/agent/threads/:threadId/proposals/:toolCallId/{apply,
// reject}`. Body-less: the proposal payload lives in the addressed tool
// row, the chat comes from the thread row, and the tracker's on/off +
// mode are read at ACCEPT time (never at proposal time). The resolution
// (ownership, typed errors, the reused insights services, the status
// write through setToolResultOutput) lives in
// `domain/sidechat/sidechat-objective-proposal.ts`; its own adapter slice
// (`AgentThreadProposalAdapter`) implements the interface below so the big
// copilot adapter stays under its size ratchet.

/** The thread-proposal resolution runtime contract — implemented by the
 *  dedicated `AgentThreadProposalAdapter` (SC-11), consumed by
 *  `api/routes/agent-thread-proposals.ts`. */
export interface AgentThreadProposalsRuntimeApi {
	/** Apply one pending objective proposal: add the item through the reused
	 *  insights service for the tracker's CURRENT mode (route → a task via
	 *  the insights runtime's `addObjectiveTask`, goals → a short-term goal
	 *  via `ObjectiveService.addShortTermGoal`) and mark the tool row
	 *  `applied`. Typed 409s: `objective_tracker_disabled` (tracker off at
	 *  Accept time), `objective_proposal_already_resolved` (repeat apply);
	 *  404 for a foreign/non-proposal toolCallId or a thread that is not a
	 *  chat-owned `sidechat-ooc` row. */
	agentThreadApplyObjectiveProposal: (
		threadId: string,
		toolCallId: string,
	) => Promise<AgentThreadProposalResolveWire>;

	/** Reject one pending objective proposal: write nothing to the tracker,
	 *  mark the tool row `rejected`. Same 404/409 contract as
	 *  {@link agentThreadApplyObjectiveProposal}. */
	agentThreadRejectObjectiveProposal: (
		threadId: string,
		toolCallId: string,
	) => Promise<AgentThreadProposalResolveWire>;
}
