/**
 * CTX-L3 — the structured lore review surface.
 *
 * Shown inside the co-author reviewing overlay when a turn proposes a
 * `lore_bundle` (alongside, or instead of, the profile/greeting body-diff).
 * Each proposed lorebook + entry carries a Checkbox; the user narrows the
 * selection before Apply. Parent-dependency is enforced at the SELECTION layer:
 * an entry whose proposed lorebook was deselected renders a DISABLED checkbox
 * (and is dropped from the Apply request by `selectLoreBundle`). CE-B2's
 * verified persisted-parent entries have no parent proposal to select; they
 * render in a separate existing-book group and are independently selectable.
 *
 * Reuses the shared `Checkbox` primitive (AGENTS.md §9) — no hand-rolled
 * toggle. Content is shown read-only (this is a review, not an editor): dense
 * worldbuilding prose in a capped scroll block, key chips as pills, activation
 * as badges.
 */
import { Fragment, useMemo } from "react";
import type { CoauthorDraftLoreEntry, CoauthorLoreBundle } from "@vibe-tavern/api-contracts";
import { Checkbox } from "../shared/Checkbox.js";
import { cn } from "../../lib/cn.js";

export interface CoauthorLoreReviewLabels {
  title: string;
  lorebook: string;
  keys: string;
  secondaryKeys: string;
  constant: string;
  /** CE-B2: badge for an edit node (mode:"edit") — modifying an existing persisted entity. */
  editing: string;
  /** CE-B2: group header for entries whose verified parent exists only in DB. */
  existingLorebook: string;
  entriesOne: string;
  entriesFew: string;
  entriesMany: string;
  /** Scope badge value labels. */
  scopeCharacter: string;
  scopePersona: string;
  scopeGlobal: string;
  scopeChat: string;
  noContent: string;
}

interface CoauthorLoreReviewProps {
  bundle: CoauthorLoreBundle;
  selectedLorebookIds: ReadonlySet<string>;
  selectedEntryIds: ReadonlySet<string>;
  onToggleLorebook: (id: string) => void;
  onToggleEntry: (id: string) => void;
  applying: boolean;
  labels: CoauthorLoreReviewLabels;
}

/** Pluralize an entry count using the provided one/few/many forms. */
function entriesLabel(n: number, labels: CoauthorLoreReviewLabels): string {
  // English ignores one/few/many distinction here (all "entries"); the three
  // forms exist for Russian pluralization (1/2-4/5+). Simple cardinal rule.
  if (n === 1) return labels.entriesOne;
  if (n >= 2 && n <= 4) return labels.entriesFew;
  return labels.entriesMany;
}

const SCOPE_LABEL: Record<string, keyof CoauthorLoreReviewLabels> = {
  character: "scopeCharacter",
  persona: "scopePersona",
  global: "scopeGlobal",
  chat: "scopeChat",
};

interface LoreEntryReviewCardProps {
  entry: CoauthorDraftLoreEntry;
  selected: boolean;
  parentSelected: boolean;
  applying: boolean;
  onToggle: (id: string) => void;
  labels: CoauthorLoreReviewLabels;
}

/** Shared entry-card renderer for proposed-parent and persisted-parent groups. */
function LoreEntryReviewCard({
  entry: e,
  selected,
  parentSelected,
  applying,
  onToggle,
  labels,
}: LoreEntryReviewCardProps) {
  const disabled = applying || !parentSelected;
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2 transition-colors",
        selected && parentSelected
          ? "border-accent/30 bg-surface"
          : "border-border/60 bg-surface/60",
        !parentSelected && "opacity-50",
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox checked={selected} disabled={disabled} onChange={() => onToggle(e.id)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-ui text-[12px] font-medium text-t1">
              {e.title || labels.lorebook}
            </span>
            {e.constant && (
              <span className="rounded-full border border-accent/50 bg-accent/10 px-1.5 py-px font-ui text-[9px] font-semibold uppercase tracking-wide text-accent">
                {labels.constant}
              </span>
            )}
            {e.mode === "edit" && (
              <span className="rounded-full border border-t2/40 bg-t2/10 px-1.5 py-px font-ui text-[9px] font-semibold uppercase tracking-wide text-t2">
                {labels.editing}
              </span>
            )}
          </div>
          {e.content ? (
            <pre className="mt-1 whitespace-pre-wrap break-words font-body text-[11.5px] leading-relaxed text-t2">
              {e.content}
            </pre>
          ) : (
            <p className="mt-1 font-ui text-[11px] italic text-t4">{labels.noContent}</p>
          )}
          {(e.keys.length > 0 || e.secondaryKeys.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {e.keys.map((k, i) => (
                <span key={`k${i}`} className="rounded-full bg-accent/15 px-1.5 py-px font-ui text-[10px] text-accent">
                  {k}
                </span>
              ))}
              {e.secondaryKeys.length > 0 && (
                <Fragment>
                  <span className="font-ui text-[9px] uppercase tracking-wide text-t4">{labels.secondaryKeys}</span>
                  {e.secondaryKeys.map((k, i) => (
                    <span key={`s${i}`} className="rounded-full bg-s3 px-1.5 py-px font-ui text-[10px] text-t3">
                      {k}
                    </span>
                  ))}
                </Fragment>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function CoauthorLoreReview({
  bundle,
  selectedLorebookIds,
  selectedEntryIds,
  onToggleLorebook,
  onToggleEntry,
  applying,
  labels,
}: CoauthorLoreReviewProps) {
  // Group entries under proposed parents, and verified persisted-parent entries
  // in a separate map. A persisted parent deliberately has no lorebook node in
  // the proposal (importing a no-op parent could rewrite ownership on Apply).
  const { entriesByBook, persistedEntriesByBook } = useMemo(() => {
    const bookIds = new Set(bundle.lorebooks.map((lb) => lb.id));
    const proposed = new Map<string, typeof bundle.entries>();
    const persisted = new Map<string, typeof bundle.entries>();
    for (const e of bundle.entries) {
      const target = bookIds.has(e.lorebookId)
        ? proposed
        : e.parentMode === "persisted"
          ? persisted
          : null;
      if (!target) continue; // malformed orphan: selection drops it defensively
      const list = target.get(e.lorebookId) ?? [];
      list.push(e);
      target.set(e.lorebookId, list);
    }
    return { entriesByBook: proposed, persistedEntriesByBook: persisted };
  }, [bundle]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        <div className="font-ui text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
          {labels.title}
        </div>
        {bundle.lorebooks.map((lb) => {
          const bookSelected = selectedLorebookIds.has(lb.id);
          const entries = entriesByBook.get(lb.id) ?? [];
          return (
            <div
              key={lb.id}
              className={cn(
                "rounded-lg border transition-colors",
                bookSelected ? "border-accent/40 bg-accent/[0.04]" : "border-border bg-s2/40",
              )}
            >
              {/* Lorebook header — selection + name + scope badge + entry count. */}
              <div className="flex items-center gap-2 px-2.5 py-2">
                <Checkbox
                  checked={bookSelected}
                  disabled={applying}
                  onChange={() => onToggleLorebook(lb.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-body text-[13px] font-medium text-t1">
                      {lb.name || labels.lorebook}
                    </span>
                    <span className="shrink-0 rounded-full border border-border/70 bg-surface px-1.5 py-px font-ui text-[9px] uppercase tracking-wide text-t3">
                      {labels[SCOPE_LABEL[lb.scopeType] ?? "scopeGlobal"]}
                    </span>
                    {lb.mode === "edit" && (
                      <span className="shrink-0 rounded-full border border-t2/40 bg-t2/10 px-1.5 py-px font-ui text-[9px] font-semibold uppercase tracking-wide text-t2">
                        {labels.editing}
                      </span>
                    )}
                  </div>
                  {lb.description && (
                    <p className="truncate font-ui text-[11px] text-t3">{lb.description}</p>
                  )}
                </div>
                <span className="shrink-0 font-ui text-[10px] text-t4">
                  {entries.length} {entriesLabel(entries.length, labels)}
                </span>
              </div>

              {/* Entries — nested, indented under the parent book. A deselected
                  book disables its entries' checkboxes (parent-dependency). */}
              {entries.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/40 px-2.5 py-2 pl-4">
                  {entries.map((e) => (
                    <LoreEntryReviewCard
                      key={e.id}
                      entry={e}
                      selected={selectedEntryIds.has(e.id)}
                      parentSelected={bookSelected}
                      applying={applying}
                      onToggle={onToggleEntry}
                      labels={labels}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* CE-B2: entries whose parent is a verified persisted lorebook. The
            parent is intentionally not a proposal node, so it has no checkbox;
            each entry is independently selectable and Apply validates the DB
            parent. Group by id so multiple existing books never mix. */}
        {[...persistedEntriesByBook.entries()].map(([lorebookId, entries]) => (
          <div key={`persisted-${lorebookId}`} className="rounded-lg border border-border bg-s2/40">
            <div className="flex items-center gap-2 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-body text-[13px] font-medium text-t1">{labels.existingLorebook}</span>
                  <span
                    className="max-w-[16rem] truncate rounded-full border border-border/70 bg-surface px-1.5 py-px font-mono text-[9px] text-t4"
                    title={lorebookId}
                  >
                    {lorebookId}
                  </span>
                </div>
              </div>
              <span className="shrink-0 font-ui text-[10px] text-t4">
                {entries.length} {entriesLabel(entries.length, labels)}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 border-t border-border/40 px-2.5 py-2 pl-4">
              {entries.map((e) => (
                <LoreEntryReviewCard
                  key={e.id}
                  entry={e}
                  selected={selectedEntryIds.has(e.id)}
                  parentSelected={true}
                  applying={applying}
                  onToggle={onToggleEntry}
                  labels={labels}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
