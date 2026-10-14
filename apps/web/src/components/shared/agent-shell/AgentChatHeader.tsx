import { useT } from "../../../i18n/context.js";
import { Icons } from "../icons.js";
import { AgentSessionSwitcher } from "./AgentSessionSwitcher.js";
import type { ExperienceCopilotThreadWire } from "@vibe-tavern/api-contracts";

/**
 * AgentChatHeader (AS-6b2, moved from the copilot editors' CopilotChatHeader)
 * — the pinned toolbar row at the top of the agent chat pane: the session
 * switcher plus the agent-profile gear button. Extracted from the shell
 * (PM-7) for the arch-gate file ratchet; the row is one chrome unit used
 * once, and every callback stays owned by the shell.
 */
export function AgentChatHeader({
  sessions,
  activeThreadId,
  disabled,
  onActivate,
  onNew,
  onRename,
  onOpenProfile,
}: {
  sessions: ExperienceCopilotThreadWire[];
  activeThreadId: string;
  disabled: boolean;
  onActivate: (threadId: string) => void;
  onNew: () => void;
  onRename: (threadId: string, title: string) => void;
  onOpenProfile: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex shrink-0 items-center border-b border-border bg-surface px-2 py-1.5">
      <AgentSessionSwitcher
        sessions={sessions}
        activeThreadId={activeThreadId}
        disabled={disabled}
        onActivate={onActivate}
        onNew={onNew}
        onRename={onRename}
      />
      <button
        type="button"
        data-testid="copilot-profile-gear-btn"
        aria-label={t("copilot_profile_title")}
        title={t("copilot_profile_title")}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1"
        onClick={onOpenProfile}
      >
        <Icons.Settings className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
