import type {
  ExperienceCopilotLaunchContext,
  ExperienceCopilotStep,
} from "@vibe-tavern/api-contracts";

/** Answer to a pending `ask_user` question (TAG-5 split-turn, style B). The
 *  continuation turn runs with NO new user row — this answer is persisted as
 *  the answered ask tool-result instead, and the model resumes the logical
 *  turn from there. Wire twin of the api-contracts
 *  `experienceCopilotStreamAnswerSchema` (kept structural for direct domain
 *  callers as well as the validated route). */
export interface ExperienceCopilotStreamAnswer {
  /** The awaiting `ask_user` tool-result row being answered (in this thread). */
  toolCallId: string;
  /** The user's answer text (a tapped chip's label or free text). Mutually
   *  exclusive with `skipped` (wire-enforced). */
  text?: string;
  /** The user pressed skip. Mutually exclusive with `text`. */
  skipped?: boolean;
}

export interface ExperienceCopilotStreamRequest {
  /** The copilot thread id (path param on the route). */
  threadId: string;
  /** User's message text for this turn. Exactly-one-of with `answer` (the
   *  wire schema enforces it; the stream also guards direct domain callers). */
  content?: string;
  /** Answer to a pending `ask_user` question (TAG-5 split-turn): when set, NO
   *  user row is appended — the referenced awaiting tool-result row is
   *  rewritten with the answer and the turn continues the question turn. */
  answer?: ExperienceCopilotStreamAnswer;
  /** Provider profile ID to use. */
  providerProfileId: string;
  /** Model name override (optional, uses profile default). */
  model?: string;
  /** The current authoring step (inline 3-step creation flow). Default "rules". */
  step?: ExperienceCopilotStep;
  /** The LIVE rules draft the user is editing (the editor sends the current
   *  unsaved source). Preferred over the last-persisted buffer so the model is
   *  never blind to in-progress edits. */
  rules?: string;
  /** The LIVE visual draft the user is editing (see `rules`). */
  visual?: string;
  /** The latest test/simulate digest the user sent back from the test panel.
   *  Loosely typed on the wire (`Record<string, unknown>`) because the digest
   *  shapes live in the backend domain. */
  testFeedback?: Record<string, unknown> | null;
  /** Latest Try-panel roster, grants, settings and seed for diagnostic tools. */
  launchContext?: ExperienceCopilotLaunchContext;
}

/** SSE event the route forwards verbatim via `streamSSE`. */
export interface ExperienceCopilotStreamEvent {
  event: string;
  data: string;
}
