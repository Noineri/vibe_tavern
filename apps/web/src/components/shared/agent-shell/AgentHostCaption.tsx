/**
 * The agent feed's per-turn caption line (AGENT_SHELL_POLISH, AP-29) —
 * extracted from `AgentMessageList.tsx` under the file-size ratchet (the
 * inline-reasoning integration pushed the list past 800 lines).
 *
 * One quiet secondary `font-ui` caption per assistant turn («✦ {host title}»,
 * AP-4 mockup §1 — never a heading) that ALSO hosts the turn's kept
 * reasoning through the shared MessageReasoning `inline` preset: the toggle
 * sits ON the caption row; its body opens full-width under the row (the row
 * is `flex flex-wrap`, the body `basis-full`). The title is the host
 * descriptor's existing title — no new i18n key.
 */
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import { useAgentFeedDisclosure } from "./agent-feed-ui-state.js";

export function AgentHostCaption({ title, reasoning, reasoningDurationMs, stateKey }: {
  title: string;
  reasoning?: string | null;
  reasoningDurationMs?: number | null;
  /** AFP-4: the caption row's stable unit id (`caption:<slot message id>` —
   *  the window module's builder). Passed only where a feed session
   *  provider wraps the tree (AFP-6 threads it): the reasoning disclosure is
   *  then retained in the session store and survives row unmount. Absent
   *  (every current call site) the toggle stays component-local through
   *  MessageReasoning's uncontrolled default — byte-identical to before. */
  stateKey?: string;
}) {
  const retained = stateKey !== undefined;
  const disclosure = useAgentFeedDisclosure(stateKey ?? "caption:unkeyed", false);
  return (
    <div className="mb-[3px] flex flex-wrap items-center gap-x-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3" data-testid="copilot-host-caption">
      <span>✦ {title}</span>
      {reasoning?.trim() ? (
        <MessageReasoning
          reasoning={reasoning}
          reasoningDurationMs={reasoningDurationMs ?? null}
          variant="inline"
          open={retained ? disclosure.open : undefined}
          onOpenChange={retained ? disclosure.toggle : undefined}
        />
      ) : null}
    </div>
  );
}
