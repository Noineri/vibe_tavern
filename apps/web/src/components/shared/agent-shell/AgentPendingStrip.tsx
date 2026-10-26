import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import { agentThreadKey, type AgentI18nKey, type AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentPendingReviewStore } from "../../../stores/agent-pending-review-store.js";
import { useT } from "../../../i18n/context.js";
import { Icons } from "../icons.js";

/**
 * AgentPendingStrip (AGENT_SHELL_POLISH AP-16) — the pending-changes strip
 * above both composers (mockup §1: «Правила · 3 · Внешний вид · 5»,
 * «Открыть», «Принять всё»). Chrome only: it reads the ONE plain
 * pending-review store AP-15 built and calls the published callables
 * verbatim — never saves (acceptAll accepts hunks only; saving stays the
 * editor pane's own step, and the pane's review bar is untouched).
 *
 * THE LABEL-MAPPING DECISION (plan row owns this copy): the store carries
 * the descriptors' EXISTING labelKeys (`agent_rules`, `agent_visual`,
 * `script_code_label` — AP-15's contract), but the strip renders the
 * mockup's verbatim text — `agent_visual` displays as «Внешний вид» (en
 * «Appearance»), NOT «Визуал». The mapping lives in `STRIP_LABEL_KEYS`
 * below (the ONE place); the store keys are never re-typed. `open` is the
 * publisher's own callable (desktop: the editor pane's review tab; phone:
 * the edit tab — the publishers already handle platform, the strip just
 * calls it). No isSending gate: the store is the single source (AP-15
 * clears the entry while a turn streams, so the strip follows it).
 *
 * Mounted ONCE in `AgentChatPane` above the composer branch (both composer
 * arms sit under the pane, so one site covers desktop + phone — the mockup
 * strip is viewport-agnostic). Hides itself when nothing is pending for
 * this thread and in the sidechat (chat-only host: no editor pane, never
 * publishes — the kind guard here is belt and braces per the plan).
 */

const STRIP_TESTID = "copilot-pending-changes-strip";
const OPEN_TESTID = "copilot-pending-open";
const ACCEPT_ALL_TESTID = "copilot-pending-accept-all";

/** Store labelKey → the strip's display key (see the header decision). */
const STRIP_LABEL_KEYS: Record<string, AgentI18nKey> = {
  agent_rules: "agent_pending_rules",
  agent_visual: "agent_pending_appearance",
  script_code_label: "agent_pending_code",
};

/** Test id of one buffer's chip — keyed by the STORE labelKey. */
export function agentPendingChipTestId(labelKey: string): string {
  return `copilot-pending-chip-${labelKey}`;
}

export function AgentPendingStrip({ kind, threadId }: { kind: AgentKind; threadId: string }) {
  const { t } = useT();
  const summary = useAgentPendingReviewStore((s) => s.summariesByThread[agentThreadKey(kind, threadId)] ?? null);
  if (kind === SIDECHAT_AGENT_KIND || summary === null) return null;
  return (
    <div
      data-testid={STRIP_TESTID}
      className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-4 py-1.5"
    >
      <Icons.fileText className="h-3.5 w-3.5 shrink-0 text-accent-t" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center font-ui text-[calc(var(--ui-fs)-2px)] text-t2">
        {summary.buffers.map((buffer, index) => (
          <span key={buffer.labelKey} className="flex min-w-0 items-center">
            {index > 0 && (
              <span aria-hidden="true" className="px-1">
                ·
              </span>
            )}
            <span data-testid={agentPendingChipTestId(buffer.labelKey)} className="whitespace-nowrap">
              {t(STRIP_LABEL_KEYS[buffer.labelKey] ?? buffer.labelKey)} · {buffer.pending}
            </span>
          </span>
        ))}
      </div>
      {/* «Открыть» — the ask-skip quiet-button canon verbatim
          (`AgentAskCard.tsx`: rounded-md + px-2 py-1 + -3px ladder + t3,
          hover bg-s2). */}
      <button
        type="button"
        data-testid={OPEN_TESTID}
        onClick={summary.open}
        className="shrink-0 rounded-md px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t2"
      >
        {t("agent_pending_open")}
      </button>
      {/* «Принять всё» — the same quiet shape in the mockup's accent (the
          ask title's `text-accent-t` token); hunks only, never a save. */}
      <button
        type="button"
        data-testid={ACCEPT_ALL_TESTID}
        onClick={summary.acceptAll}
        className="shrink-0 rounded-md px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-colors hover:bg-s2"
      >
        {t("agent_pending_accept_all")}
      </button>
    </div>
  );
}
