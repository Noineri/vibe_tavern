import { useEffect, useState } from "react";
import type { ExperienceCopilotToolActivity } from "../../../stores/experience-copilot-turn-store.js";
import { useT } from "../../../i18n/context.js";
import { AnimatedDisclosure } from "../AnimatedDisclosure.js";
import { Icons } from "../icons.js";
import { AgentActivityCard } from "./AgentActivityCard.js";

export interface AgentToolAccordionProps {
  activities: readonly ExperienceCopilotToolActivity[];
  /** True only for the controller's active streamed turn. */
  isSending: boolean;
}

/**
 * Groups consecutive tool activity cards from one copilot turn. Live groups
 * stay open as cards arrive; settled and historical groups collapse to their
 * count header until the user opens them locally.
 */
export function AgentToolAccordion({ activities, isSending }: AgentToolAccordionProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(isSending);

  // A new live turn must reveal incoming cards, while settling the same group
  // returns it to its compact audit header. Subsequent clicks are local state.
  useEffect(() => {
    setExpanded(isSending);
  }, [isSending]);

  return (
    <div data-testid="copilot-tool-accordion" className="overflow-hidden rounded-md">
      <button
        type="button"
        data-testid="copilot-tool-accordion-toggle"
        data-count={activities.length}
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex min-h-11 w-full cursor-pointer items-center gap-1.5 px-2 text-left font-ui text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.03em] text-t2 transition-colors hover:bg-s2/50 hover:text-t1"
      >
        <span>{t("experience_copilot_tools", { n: activities.length })}</span>
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
          <AgentActivityCard key={activity.toolCallId} activity={activity} />
        ))}
      </AnimatedDisclosure>
    </div>
  );
}
