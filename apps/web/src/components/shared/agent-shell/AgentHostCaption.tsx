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

export function AgentHostCaption({ title, reasoning, reasoningDurationMs }: {
  title: string;
  reasoning?: string | null;
  reasoningDurationMs?: number | null;
}) {
  return (
    <div className="mb-[3px] flex flex-wrap items-center gap-x-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3" data-testid="copilot-host-caption">
      <span>✦ {title}</span>
      {reasoning?.trim() ? (
        <MessageReasoning reasoning={reasoning} reasoningDurationMs={reasoningDurationMs ?? null} variant="inline" />
      ) : null}
    </div>
  );
}
