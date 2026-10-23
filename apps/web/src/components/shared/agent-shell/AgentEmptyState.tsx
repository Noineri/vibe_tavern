import { useMemo } from "react";
import { cn } from "../../../lib/cn.js";
import { EmptyState } from "../empty-state.js";
import { SECONDARY_OUTLINE_CORE } from "../destructive-confirm-modal.js";
import { Icons } from "../icons.js";
import { useT } from "../../../i18n/context.js";
import { getAgentHost, type AgentI18nKey, type AgentKind } from "../../../lib/agent-host-registry.js";

/** AP-18 starter button chrome — composed from the shared calm-secondary
 *  core (`SECONDARY_OUTLINE_CORE` in `destructive-confirm-modal.tsx`),
 *  plus this arm's specifics for the mockup §3 rows. Named deviations from
 *  the footer arm live ONLY in the second string: `flex w-full` +
 *  `justify-start` / `text-left` (full-width left-aligned rows, not a
 *  footer pair), `px-3 py-2` (a readable row height instead of the footer's
 *  fixed `h-8` / `px-3.5`), `text-t2` at rest (readable before hover;
 *  `hover:bg-s2` + `hover:text-t1` lifts it). Text sizes follow the ui-fs
 *  ladder (never raw `text-xs`). Composed string carries the same utilities
 *  as the pre-rework literal (CF13: verified joined, not the fragment). */
const STARTER_BTN_CLS = cn(
  SECONDARY_OUTLINE_CORE,
  "flex w-full items-center justify-start px-3 py-2 text-left text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s2 hover:text-t1",
);

export interface AgentEmptyStateProps {
  /** The host kind driving the shell — the starters resolve from its
   *  `starterPromptKeys` (AP-17), exactly like the list's AP-2 lookups. */
  kind: AgentKind;
  /** Already-translated empty-state title (the shell resolves the host's
   *  `emptyTitle` key — AS-8c3a, untouched by this unit). */
  title: string;
  /** Already-translated empty-state subtitle (omitted falls back to the
   *  shared line — AS-8c3a, untouched by this unit). */
  sub?: string;
  /** AP-18: starter-prompt pick — called with the TRANSLATED starter text.
   *  Absent = no starters render (a button without an action is a defect). */
  onStarterPick?: (text: string) => void;
}

/**
 * AP-18: the agent shell's empty session (mockup §3) — the shared
 * `EmptyState` (sparkles icon, per-host title/subtitle, byte-identical to
 * before) with the host's four starter prompts BELOW it as full-width
 * secondary buttons, stacked with a small gap. Extracted from
 * `AgentMessageList` (the arch-gate ratchet): the list's empty branch
 * renders this one element. A click hands the translated text to
 * `onStarterPick` — the pane turns it into a composer prefill and focuses
 * the composer; nothing here sends.
 */
export function AgentEmptyState({ kind, title, sub, onStarterPick }: AgentEmptyStateProps) {
  const { t } = useT();

  // AP-2 pattern: resolve once per kind; an unknown kind renders the bare
  // empty state (no starters), never a throw.
  const starterKeys = useMemo<readonly AgentI18nKey[]>(() => {
    try {
      return getAgentHost(kind).starterPromptKeys;
    } catch {
      return [];
    }
  }, [kind]);

  return (
    <div className="flex flex-1 items-center justify-center">
      {/* max-w-sm caps the rows on wide panes (mockup §3 draws them at pane
          width ≈ 400px); w-full stretches them on narrow ones. */}
      <div className="flex w-full max-w-sm flex-col items-center px-6">
        <EmptyState
          icon={<Icons.Sparkles className="h-6 w-6 text-t3" />}
          title={title}
          sub={sub}
        />
        {onStarterPick !== undefined && starterKeys.length > 0 && (
          // mt-3.5 = the mockup's 14px subtitle→starters gap; gap-1.5 =
          // its 6px stacked rows.
          <div className="mt-3.5 flex w-full flex-col items-stretch gap-1.5">
            {starterKeys.map((key, index) => {
              const text = t(key);
              return (
                <button
                  key={key}
                  type="button"
                  data-testid={`agent-starter-${index}`}
                  className={STARTER_BTN_CLS}
                  onClick={() => onStarterPick(text)}
                >
                  {text}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
