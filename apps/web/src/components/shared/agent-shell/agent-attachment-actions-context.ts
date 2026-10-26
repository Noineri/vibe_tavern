/**
 * The agent shell's attachment-action context (CA-4f) — everything a SENT
 * attachment's action mount needs that the message tree already holds:
 * the thread id, the shell picker's CURRENT provider profile + model
 * (summarize addresses them explicitly — a thread whose first turn failed
 * has no last-used pair), and the ONE settle refresh the delete flow uses
 * (`AgentShell.handleTurnSettled` → `refreshThread`), so attachment actions
 * refetch through the same path as a turn settle and no second refetch
 * exists. Provided by `AgentChatPane` (a single site above the message
 * list), consumed by `agent-file-attachment.tsx` — `AgentMessageList` and
 * `AgentMessageBlock` take no new props for it.
 */
import { createContext, useContext } from "react";

export interface AgentAttachmentActionsContextValue {
  threadId: string;
  /** The shell picker's current profile — nullable exactly like the picker. */
  providerProfileId: string | null;
  model?: string;
  /** The settle refetch (`AgentShell.handleTurnSettled`'s message/events
   *  reload) — called after every attachment action lands. */
  refreshMessages: () => void;
}

export const AgentAttachmentActionsContext = createContext<AgentAttachmentActionsContextValue | null>(null);

/** Narrowed consumer: null outside the pane's thread branch — callers fall
 *  back to the menu-less chip there (never rendered in practice: the mounts
 *  live inside the pane). */
export function useAgentAttachmentActions(): AgentAttachmentActionsContextValue | null {
  return useContext(AgentAttachmentActionsContext);
}
