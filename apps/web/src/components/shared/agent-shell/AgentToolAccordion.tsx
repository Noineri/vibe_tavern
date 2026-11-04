import { useEffect, useRef, useState } from "react";
import type { AgentToolActivity } from "../../../stores/agent-turn-store.js";
import type { AgentKind } from "../../../lib/agent-host-registry.js";
import { useT } from "../../../i18n/context.js";
import { AnimatedDisclosure } from "../AnimatedDisclosure.js";
import { Icons } from "../icons.js";
import { AgentActivityCard } from "./AgentActivityCard.js";
import { useOptionalAgentFeedRowUiState } from "./agent-feed-ui-state.js";
import { agentFeedAccordionUnitId } from "./agent-feed-window.js";

export interface AgentToolAccordionProps {
  activities: readonly AgentToolActivity[];
  /** The host kind driving the shell — passed down so tool cards label
   *  targets with this host's buffer names. */
  kind: AgentKind;
  /** True only for the controller's active streamed turn. */
  isSending: boolean;
}

/**
 * Groups consecutive tool activity cards from one copilot turn. Live groups
 * stay open as cards arrive; settled and historical groups collapse to their
 * count header until the user opens them locally.
 */
export function AgentToolAccordion({ activities, kind, isSending }: AgentToolAccordionProps) {
  const { t } = useT();
  // AFP-4: the disclosure is session-retained when a feed provider wraps
  // the tree (keyed by the window's accordion unit id — the first tool
  // call), so a user-opened historical group survives virtual unmount;
  // without a provider the local fallback below is byte-identical to the
  // pre-AFP-4 useState path.
  const row = useOptionalAgentFeedRowUiState(
    activities.length > 0 ? agentFeedAccordionUnitId(activities[0]!.toolCallId) : "card:accordion:empty",
  );
  const [localExpanded, setLocalExpanded] = useState(isSending);

  // A new live turn must reveal incoming cards, while settling the same group
  // returns it to its compact audit header. Subsequent clicks are local state.
  // AFP-4: a REMOUNT (first run, `prev === isSending`) never overwrites a
  // restored retained open state — only a REAL live→settled transition
  // re-syncs the disclosure to the turn state.
  const prevSendingRef = useRef(isSending);
  useEffect(() => {
    if (prevSendingRef.current === isSending) return;
    prevSendingRef.current = isSending;
    if (row !== null) row.setDisclosed(isSending);
    else setLocalExpanded(isSending);
  });

  const expanded = row !== null ? (row.entry.disclosed ?? isSending) : localExpanded;
  const toggle = () => {
    if (row !== null) row.setDisclosed(!expanded);
    else setLocalExpanded((open) => !open);
  };

  return (
    <div data-testid="copilot-tool-accordion" className="overflow-hidden rounded-md">
      <button
        type="button"
        data-testid="copilot-tool-accordion-toggle"
        data-count={activities.length}
        aria-expanded={expanded}
        onClick={toggle}
        className="flex min-h-11 w-full cursor-pointer items-center gap-1.5 px-2 text-left font-ui text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.03em] text-t2 transition-colors hover:bg-s2/50 hover:text-t1"
      >
        <span>{t("agent_tools", { n: activities.length })}</span>
        <span className="ml-auto shrink-0 text-t3">
          <Icons.Caret direction={expanded ? "u" : "d"} />
        </span>
      </button>
      <AnimatedDisclosure
        open={expanded}
        keepMounted
        className="flex flex-col gap-3"
        data-testid="copilot-tool-accordion-body"
      >
        {activities.map((activity) => (
          <AgentActivityCard key={activity.toolCallId} activity={activity} kind={kind} />
        ))}
      </AnimatedDisclosure>
    </div>
  );
}
