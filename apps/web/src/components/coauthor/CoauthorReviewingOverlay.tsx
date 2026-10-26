import type { CoauthorLoreBundle, CoauthorTrackerTemplateOutput } from "@vibe-tavern/api-contracts";
import type { TrackerTemplate } from "@vibe-tavern/domain";
import type { TFunc } from "../../i18n/context.js";
import { buildLineDiff } from "../shared/TextDiffPreview.js";
import { HunkSelectionDiff } from "./HunkSelectionDiff.js";
import { groupHunks } from "../../lib/coauthor-hunk-merge.js";
import { CoauthorLoreReview, type CoauthorLoreReviewLabels } from "./CoauthorLoreReview.js";
import { CoauthorTrackerTemplateReview, type CoauthorTrackerTemplateReviewLabels } from "./CoauthorTrackerTemplateReview.js";

/**
 * The reviewing overlay (CA-11): the turn's proposed edits shown as an inline
 * diff over the editor, with Apply / Reject. Extracted from CoauthorCharacterForm
 * for the architecture file-size cap; props retain its existing wiring.
 */
export function CoauthorReviewingOverlay({
  summary,
  t,
  diff,
  hunks,
  selectedHunkIds,
  onToggleHunk,
  onSelectAll,
  onSelectNone,
  applying,
  onApply,
  onReject,
  loreBundle,
  trackerTemplate,
  trackerTemplateSummary,
  currentTrackerTemplate,
  trackerTemplateSelected,
  onToggleTrackerTemplate,
  selectedLorebookIds,
  selectedEntryIds,
  onToggleLorebook,
  onToggleEntry,
  trackerTemplateLabels,
  loreLabels,
  labels,
}: {
  summary: string;
  t: TFunc;
  diff: ReturnType<typeof buildLineDiff> | null;
  hunks: ReturnType<typeof groupHunks>;
  selectedHunkIds: Set<number>;
  onToggleHunk: (id: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  applying: boolean;
  onApply: () => void;
  onReject: () => void;
  /** CTX-L3: the proposed lore bundle (absent on profile/greeting-only turns). */
  loreBundle?: CoauthorLoreBundle;
  /** CT-7b: the proposed character-owned tracker template. */
  trackerTemplate?: CoauthorTrackerTemplateOutput["trackerTemplate"];
  trackerTemplateSummary?: string;
  currentTrackerTemplate: TrackerTemplate | null;
  trackerTemplateSelected: boolean;
  onToggleTrackerTemplate: () => void;
  selectedLorebookIds: ReadonlySet<string>;
  selectedEntryIds: ReadonlySet<string>;
  onToggleLorebook: (id: string) => void;
  onToggleEntry: (id: string) => void;
  trackerTemplateLabels: CoauthorTrackerTemplateReviewLabels;
  loreLabels: CoauthorLoreReviewLabels;
  labels: {
    title: string;
    tooLarge: string;
    noChanges: string;
    apply: string;
    reject: string;
    applying: string;
    selectAll: string;
    selectNone: string;
    applyingCount: string;
    hunkN: string;
    skipped: string;
  };
}) {
  // The diff section only fills the column when it actually has selectable
  // hunks. When the diff is empty / too-large it renders a one-line message
  // (no flex-1 inside HunkSelectionDiff) — if THIS wrapper still took flex-1,
  // that message would sit at the top with a dead gap below it, and a mixed
  // turn (empty diff + lore) would split the column 50/50 against empty space.
  // shrink-0 lets the message take natural height and gives the rest to lore.
  const hasDiffContent = !!diff && !diff.tooLarge && hunks.length > 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {/* Summary — pinned top, frosted (.glass-blur) so it doesn't see-through
          on glass themes; the editor underneath is display:none, so the blur
          reads against the page background, not the editor. */}
      <div className="shrink-0 px-3 pt-3">
        <div className="glass-blur rounded-md border border-border/70 bg-glass-bg px-3 py-2">
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{summary}</div>
        </div>
      </div>
      {/* Body diff (profile/greeting) — shown iff proposed. Each section takes
          flex-1 so a mixed turn (diff + tracker + lore) shares the column
          evenly and each scrolls internally; a single-section turn fills the
          whole area. */}
      {diff && (
        <div data-testid="coauthor-diff-section" className={"flex flex-col px-1 py-2 " + (hasDiffContent ? "min-h-0 flex-1 " : "shrink-0 ")}>
          <HunkSelectionDiff
            diff={diff}
            hunks={hunks}
            selectedIds={selectedHunkIds}
            onToggleHunk={onToggleHunk}
            onSelectAll={onSelectAll}
            onSelectNone={onSelectNone}
            labels={{
              title: labels.title,
              tooLarge: labels.tooLarge,
              noChanges: labels.noChanges,
              selectAll: labels.selectAll,
              selectNone: labels.selectNone,
              applyingCount: labels.applyingCount,
              hunkN: labels.hunkN,
              skipped: labels.skipped,
            }}
          />
        </div>
      )}
      {/* CT-7b: one tracker-template proposal, selected wholesale for Apply.
          Bounded like its siblings: the outer wrapper takes its flex-1 share
          of the column (min-h-0 so it can shrink under long content) and the
          inner div owns the scroll, so a long template never pushes the
          footer off-screen. The review card itself is unchanged. */}
      {trackerTemplate && (
        <div data-testid="coauthor-tracker-section" className="flex min-h-0 flex-1 flex-col py-2">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CoauthorTrackerTemplateReview
              template={trackerTemplate}
              summary={trackerTemplateSummary ?? summary}
              currentTemplate={currentTrackerTemplate}
              selected={trackerTemplateSelected}
              applying={applying}
              onToggle={onToggleTrackerTemplate}
              labels={trackerTemplateLabels}
              t={t}
            />
          </div>
        </div>
      )}
      {/* CTX-L3: structured lore review (lorebooks + entries). Shown iff proposed. */}
      {loreBundle && (
        <div data-testid="coauthor-lore-section" className="flex min-h-0 flex-1 flex-col">
          <CoauthorLoreReview
            bundle={loreBundle}
            selectedLorebookIds={selectedLorebookIds}
            selectedEntryIds={selectedEntryIds}
            onToggleLorebook={onToggleLorebook}
            onToggleEntry={onToggleEntry}
            applying={applying}
            labels={loreLabels}
          />
        </div>
      )}
      <div data-testid="coauthor-review-footer" className="flex shrink-0 items-center justify-end gap-2 border-t border-border/50 bg-surface px-4 py-2.5">
        <button
          type="button"
          className="rounded-md border border-border bg-bg px-3.5 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-t2 transition-all hover:bg-s2 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          disabled={applying}
          onClick={onReject}
        >
          {labels.reject}
        </button>
        <button
          type="button"
          className="rounded-md border-0 bg-accent px-4 py-1.5 font-ui text-[calc(var(--ui-fs)-1px)] font-semibold text-on-accent transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
          disabled={applying}
          onClick={onApply}
        >
          {applying ? labels.applying : labels.apply}
        </button>
      </div>
    </div>
  );
}
