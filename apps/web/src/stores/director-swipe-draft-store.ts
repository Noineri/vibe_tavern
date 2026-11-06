import { create } from "zustand";

/**
 * Director swipe instruction drafts (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-32) —
 * the UNSUBMITTED edits a user types into the swipe permission card's
 * instruction field, keyed by thread + tool-call identity so they SURVIVE
 * feed virtualization and remounts: the card's React state dies with the
 * mount, the edited text must not (the user's half-typed correction
 * reappears when the card scrolls back into view).
 *
 * In-memory UI state only (canon: plain store, the `agent-streaming-store`
 * pattern) — no localStorage, no persistence, no duplicate of the server's
 * review state. The PERSISTED truth stays the permission tool row: the
 * awaiting marker carries the Director's PROPOSED draft, the granted receipt
 * the FINAL approved text; this store only bridges edits between remounts.
 *
 * Keying: `agentThreadKey(kind, threadId)` → `toolCallId` → the draft text.
 * A real thread switch therefore keeps drafts namespaced (each thread's
 * entries live under their own key; switching back remounts the card onto
 * its own draft). An EMPTY string is stored verbatim — the card needs the
 * distinction between "unedited" (no entry → fall back to the proposed
 * instruction) and "user cleared the field" (entry `""` → the Allow gate's
 * empty-text protection must fire, never silently revert to the draft).
 *
 * Lifecycle: `clearDraft` fires when the request RESOLVES (the persisted row
 * flips granted/denied — never on the optimistic send flip, so a transport
 * refusal keeps the edit for retry); `pruneMissing` drops the entries whose
 * request no longer renders anywhere in its thread (the turn/row was
 * DELETED). Both are driven by the consumers that observe those facts
 * (`AgentPermissionCard` / `AgentMessageList`), never by timers.
 */
interface DirectorSwipeDraftState {
  /** Thread key → tool call id → the unsubmitted field text (may be `""`). */
  draftsByThread: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Retain the field's current text for this request (create or update). */
  setDraft: (threadKey: string, toolCallId: string, text: string) => void;
  /** Drop one request's transient draft (the request resolved). */
  clearDraft: (threadKey: string, toolCallId: string) => void;
  /** Drop every draft under `threadKey` whose tool call id is absent from
   *  `keepToolCallIds` (the requests were deleted — the feed no longer
   *  renders them anywhere). Other threads' drafts are untouched. */
  pruneMissing: (threadKey: string, keepToolCallIds: readonly string[]) => void;
}

export const useDirectorSwipeDraftStore = create<DirectorSwipeDraftState>((set) => ({
  draftsByThread: {},
  setDraft: (threadKey, toolCallId, text) =>
    set((s) => {
      const thread = s.draftsByThread[threadKey];
      if (thread?.[toolCallId] === text) return s;
      return {
        draftsByThread: {
          ...s.draftsByThread,
          [threadKey]: { ...thread, [toolCallId]: text },
        },
      };
    }),
  clearDraft: (threadKey, toolCallId) =>
    set((s) => {
      const thread = s.draftsByThread[threadKey];
      if (thread === undefined || thread[toolCallId] === undefined) return s;
      const nextThread = { ...thread };
      delete nextThread[toolCallId];
      const next: Record<string, Record<string, string>> = { ...s.draftsByThread };
      if (Object.keys(nextThread).length === 0) delete next[threadKey];
      else next[threadKey] = nextThread;
      return { draftsByThread: next };
    }),
  pruneMissing: (threadKey, keepToolCallIds) =>
    set((s) => {
      const thread = s.draftsByThread[threadKey];
      if (thread === undefined) return s;
      const keep = new Set(keepToolCallIds);
      const nextThread: Record<string, string> = {};
      let dropped = false;
      for (const [toolCallId, text] of Object.entries(thread)) {
        if (keep.has(toolCallId)) nextThread[toolCallId] = text;
        else dropped = true;
      }
      if (!dropped) return s;
      const next: Record<string, Record<string, string>> = { ...s.draftsByThread };
      if (Object.keys(nextThread).length === 0) delete next[threadKey];
      else next[threadKey] = nextThread;
      return { draftsByThread: next };
    }),
}));
