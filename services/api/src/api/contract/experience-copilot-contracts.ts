/** Runtime contracts for the experience-copilot subsystem — extracted from
 *  runtime-api.ts for the size ratchet (AS-2c); re-exported there so every
 *  existing import path keeps resolving. */

// ─── Experience Copilot (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 2 / ER-6) ───────

import type { ExperienceCopilotStreamRequest, ExperienceCopilotStreamEvent } from "../../domain/interactive/copilot/experience-copilot-stream.js";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextMetrics, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";

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

/** The experience-copilot streaming subsystem — a standalone, editor-embedded
 *  pair-editor (own endpoint, own tables — ER-3) that proposes rules/visual
 *  edits via tools (ER-4) and streams one turn at a time. NOT a chat-mode and
 *  NOT the multi-mode AI-assistant. The stream yields SSE-shaped
 *  `{ event, data }` chunks (same contract as `sendMessageStream`) so the route
 *  emits them verbatim through `streamSSE`. */
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
}
