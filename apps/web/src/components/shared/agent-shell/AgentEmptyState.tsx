import { useMemo, type ReactNode } from "react";
import { cn } from "../../../lib/cn.js";
import { EmptyState } from "../empty-state.js";
import { SECONDARY_OUTLINE_CORE } from "../destructive-confirm-modal.js";
import { Icons } from "../icons.js";
import { useT } from "../../../i18n/context.js";
import { getAgentHost, type AgentI18nKey, type AgentKind } from "../../../lib/agent-host-registry.js";
import type { AgentBuiltinProfileHandoff } from "../../../lib/agent-builtin-profiles.js";

/** AP-18 starter button chrome — composed from the shared calm-secondary
 *  core (`SECONDARY_OUTLINE_CORE` in `destructive-confirm-modal.tsx`),
 *  plus this arm's specifics for the mockup §3 rows. Named deviations from
 *  the footer arm live ONLY in the second string: `flex w-full` +
 *  `justify-start` / `text-left` (full-width left-aligned rows, not a
 *  footer pair), `px-3 py-2` (a readable row height instead of the footer's
 *  fixed `h-8` / `px-3.5`), `text-t2` at rest (readable before hover;
 *  `hover:bg-s2` + `hover:text-t1` lifts it). Text sizes follow the ui-fs
 *  ladder (never raw Tailwind size classes). Composed string carries the same utilities
 *  as the pre-rework literal (CF13: verified joined, not the fragment). */
const STARTER_BTN_CLS = cn(
  SECONDARY_OUTLINE_CORE,
  "flex w-full items-center justify-start px-3 py-2 text-left text-[calc(var(--ui-fs)-2px)] text-t2 hover:bg-s2 hover:text-t1",
);

/** DR-7 accent hand-off row (mockup §3 `btn lead`) — the starter-row shape
 *  in the accent key: accent border + accent text + the film glyph, a notch
 *  bolder (font-medium). Deliberately NOT composed from SECONDARY_OUTLINE_CORE:
 *  cn is join-only (CF13), so the core's `border-border` and this row's
 *  `border-accent` would both land on the element and the stylesheet's own
 *  order would pick the winner — the full string is written here with
 *  `border-accent` in the core's place instead of gambling on it. Same
 *  footprint, sizing and text tier as the starter rows above it. */
const HANDOFF_ROW_CLS =
  "flex w-full cursor-pointer items-center justify-start gap-1.5 rounded-md border border-accent bg-transparent px-3 py-2 text-left font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-accent-t transition-colors hover:bg-accent-dim";

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
  /** DR-7: the empty-state icon override — the ACTIVE built-in profile's
   *  own glyph (the sidechat director's film strip) replaces the shared
   *  sparkles; absent = the sparkles, byte-identical to before. */
  icon?: ReactNode;
  /** DR-7: the ACTIVE built-in profile's own starter keys (from
   *  `builtinProfilePresentation`) — absent = the host's `starterPromptKeys`
   *  (also the fallback for every user profile — owner ruling 2026-10-27). */
  starterKeys?: readonly AgentI18nKey[];
  /** DR-7: the OOC hand-off row (mockup §3 `btn lead`) under the
   *  starters — switches the chat to the built-in it points at
   *  (`onActivate`, the DR-6 write) and prefills the composer with
   *  `prefillKey` through the SAME AP-18 starter path (never sent). Absent
   *  = no row, byte-identical to before. The plan-hides-it rule lives in
   *  the shell (it owns the branch-plan read). */
  handoffRow?: AgentBuiltinProfileHandoff & { onActivate: () => void };
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
export function AgentEmptyState({ kind, title, sub, icon, starterKeys, handoffRow, onStarterPick }: AgentEmptyStateProps) {
  const { t } = useT();

  // AP-2 pattern: resolve once per kind; an unknown kind renders the bare
  // empty state (no starters), never a throw. DR-7: a profile-provided
  // starter tuple wins over the host's (the sidechat director's four).
  const resolvedStarterKeys = useMemo<readonly AgentI18nKey[]>(() => {
    if (starterKeys !== undefined) return starterKeys;
    try {
      return getAgentHost(kind).starterPromptKeys;
    } catch {
      return [];
    }
  }, [kind, starterKeys]);

  return (
    <div className="flex flex-1 items-center justify-center">
      {/* max-w-sm caps the rows on wide panes (mockup §3 draws them at pane
          width ≈ 400px); w-full stretches them on narrow ones. */}
      <div className="flex w-full max-w-sm flex-col items-center px-6">
        <EmptyState
          icon={icon ?? <Icons.Sparkles className="h-6 w-6 text-t3" />}
          title={title}
          sub={sub}
        />
        {onStarterPick !== undefined && resolvedStarterKeys.length > 0 && (
          // mt-3.5 = the mockup's 14px subtitle→starters gap; gap-1.5 =
          // its 6px stacked rows.
          <div className="mt-3.5 flex w-full flex-col items-stretch gap-1.5">
            {resolvedStarterKeys.map((key, index) => {
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
            {/* DR-7 (mockup §3): the accent hand-off row rides UNDER the
                starters (mt-1.5 = its 6px offset); its prefill goes through
                the SAME onStarterPick path (composer prefill + focus), with
                the profile switch alongside — never a second send seam. */}
            {handoffRow !== undefined && (
              <button
                type="button"
                data-testid="agent-handoff-row"
                className={cn(HANDOFF_ROW_CLS, "mt-1.5")}
                onClick={() => {
                  handoffRow.onActivate();
                  onStarterPick(t(handoffRow.prefillKey));
                }}
              >
                <Icons.film className="h-3.5 w-3.5 shrink-0" />
                <span>{t(handoffRow.rowKey)}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
