/**
 * LorebookAccordion — expandable accordion for a single lorebook in the list.
 *
 * Shows a header (name, enabled toggle, actions) and
 * an expandable list of entries with settings (token budget, scan depth).
 *
 * In edit mode — an inline form for the name + scope.
 * On mobile — a context menu (⋮) instead of a button row.
 */
import { useState, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { ActionSheet } from "../../shared/ActionSheet.js";

import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { Ic, Icons } from "../../shared/icons.js";
import { AddButton } from "../../shared/add-button.js";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { SliderField } from "../../shared/SliderField.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { InlineRenameInput } from "../../shared/InlineRenameInput.js";
import { listLoreEntries } from "../../../api/lorebook-api.js";
import type { LorebookRecord, LoreEntryRecord, LorebookLinkRecord } from "../../../api/types.js";
import { LoreEntryList } from "./LoreEntryList.js";
import { ListSearchPanel } from "../../shared/ListSearchPanel.js";
import type { LinkTarget } from "../../shared/LinkBindingPopover.js";
import { LorebookOwnerPicker } from "./LorebookOwnerPicker.js";
import { LorebookActivationSettings } from "./lorebook-activation-settings.js";
import { countTokens } from "../../../utils/tokenizer.js";
import type { TFunc } from "../../../i18n/locale-helpers.js";
import type Resources from "../../../i18n/resources.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Compact token count: 999 → "999", 1200 → "1.2k", 1500000 → "1.5M". */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Derive a binding icon from the book's scope, not from a legacy owner field.
 * Exported for its colocated test (the pure scope→icon mapping is pinned
 * directly; the rendered tooltip is hover-gated in happy-dom).
 */
export function lorebookBindingIcon(lb: LorebookRecord): { icon: ReactNode; tooltipKey: keyof Resources["en"] } | null {
  if (lb.scopeType === "chat") return { icon: <Ic.chat />, tooltipKey: "scope_chat" };
  if (lb.scopeType === "entity") return { icon: <Ic.book />, tooltipKey: "scope_entity" };
  return null;
}

// ── Types ──────────────────────────────────────────────────────────────

export type Scope = "global" | "entity" | "chat" | "all" | "current";

interface LorebookAccordionProps {
  lorebook: LorebookRecord;
  links: LorebookLinkRecord[];
  linksLoaded: boolean;
  expanded: boolean;
  editing: boolean;
  editLbName: string;
  editLbScope: string;
  activeEntryId: string | null;
  isMobile: boolean;
  actionMenuOpen: boolean;
  onToggleActionMenu: () => void;
  t: TFunc;
  onToggle: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditLbName: (name: string) => void;
  onEditLbScope: (scope: string) => void;
  onDelete: () => void;
  onAddEntry: () => void;
  onEntryClick: (entryId: string) => void;
  onToggleEnabled: () => void;
  onUpdateMeta: (body: {
    scanDepth?: number;
    tokenBudget?: number;
    tokenBudgetPercent?: number | null;
    tokenBudgetCap?: number;
    recursiveScanning?: boolean;
    useGroupScoring?: boolean;
    caseSensitive?: boolean;
    matchWholeWords?: boolean;
    maxRecursionSteps?: number;
    includeNames?: boolean;
    minActivations?: number;
    minActivationsDepthMax?: number;
    overflowAlert?: boolean;
    characterStrategy?: number;
  }) => void;
  onReorderEntries: (updates: Array<{ id: string; sortOrder: number; position?: string }>) => Promise<LoreEntryRecord[]>;
  onToggleEntryEnabled: (entryId: string, enabled: boolean) => Promise<LoreEntryRecord>;
  onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
  onDuplicate: () => void;
  onExport: () => void;
  characters: LinkTarget[];
  personas: LinkTarget[];
}

// ── Component ──────────────────────────────────────────────────────────

export function LorebookAccordion({
  lorebook,
  links,
  linksLoaded,
  expanded,
  editing,
  editLbName,
  editLbScope,
  activeEntryId,
  isMobile,
  actionMenuOpen,
  onToggleActionMenu,
  t,
  onToggle,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditLbName,
  onEditLbScope,
  onDelete,
  onAddEntry,
  onEntryClick,
  onToggleEnabled,
  onUpdateMeta,
  onReorderEntries,
  onToggleEntryEnabled,
  onSetLinks,
  onDuplicate,
  onExport,
  characters,
  personas,
}: LorebookAccordionProps) {
  // ── Entries: loaded up front (for the counter and token estimate in the header),
  //    and remain available when expanded.
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);

  // ── In-accordion search: name/content text query + activation-key tag
  //    filter. Owned here (not in the parent) because the accordion loads its
  //    own entries and the filter is a local view concern. Reuses ListSearchPanel
  //    (the sidebar character-search pattern); tag chips combine with AND.
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  // Secondary activation keys get their OWN combobox (a distinct input, not a
  // merged pool) so users can target them specifically — primary and secondary
  // are different activation surfaces in the lorebook model.
  const [selectedSecondaryKeys, setSelectedSecondaryKeys] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    listLoreEntries(lorebook.id).then((data) => {
      if (!cancelled) setEntries(data);
    });
    return () => {
      cancelled = true;
    };
  }, [lorebook.id]);

  // Total estimated tokens across all entries (by content).
  const totalTokens = useMemo(
    () =>
      entries.length === 0
        ? 0
        : countTokens(entries.map((e) => e.content).join("\n")),
    [entries],
  );

  // Distinct activation keys across all entries — the tag pool for the
  // search combobox. Sorted for stable dropdown order.
  const availableKeys = useMemo(
    () =>
      Array.from(
        new Set(entries.flatMap((e) => e.keys).filter((k): k is string => !!k)),
      ).sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  // Same for secondary keys — a separate pool for the separate input.
  const availableSecondaryKeys = useMemo(
    () =>
      Array.from(
        new Set(entries.flatMap((e) => e.secondaryKeys).filter((k): k is string => !!k)),
      ).sort((a, b) => a.localeCompare(b)),
    [entries],
  );

  // Filtered view of entries for the expanded list. Text query matches title
  // OR content (case-insensitive); primary key chips AND over entry.keys;
  // secondary key chips AND over entry.secondaryKeys. The primary and secondary
  // filters are independent (both must match). The header counter stays on the
  // full `entries.length` (total), not the filtered count.
  const isFiltering =
    searchQuery.trim() !== "" ||
    selectedKeys.length > 0 ||
    selectedSecondaryKeys.length > 0;
  const filteredEntries = useMemo(() => {
    if (!isFiltering) return entries;
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((e) => {
      if (q && !`${e.title} ${e.content}`.toLowerCase().includes(q)) return false;
      if (selectedKeys.length > 0 && !selectedKeys.every((k) => e.keys.includes(k)))
        return false;
      if (
        selectedSecondaryKeys.length > 0 &&
        !selectedSecondaryKeys.every((k) => e.secondaryKeys.includes(k))
      )
        return false;
      return true;
    });
  }, [entries, isFiltering, searchQuery, selectedKeys, selectedSecondaryKeys]);

  // ── Advanced book settings (resweep step 6): min activations, depth max,
//    max recursion steps, overflow alert. Collapsed by default, local state
//    (never persisted) — the entry editor's disclosure pattern.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Slider drag drafts — the range fires onChange per drag tick, but
  // onUpdateMeta is an RPC per call (updateLorebookMeta + refreshLorebooks),
  // so the tick only paints local state and SliderField.onCommit persists
  // on release (NumberInput's half commits on blur — same boundary).
  const [stepsDraft, setStepsDraft] = useState<number | null>(null);
  const [minActDraft, setMinActDraft] = useState<number | null>(null);
  const [depthMaxDraft, setDepthMaxDraft] = useState<number | null>(null);
  // Which control was auto-zeroed by the ST mutual exclusion (setting one of
  // minActivations / maxRecursionSteps to non-zero zeroes the other,
  // world-info.js 6118-6124 / 6184-6192 — UI-only there, UI-only here). The
  // note shows in the zeroed control's caption slot until that control next
  // changes or the section collapses.
  const [exclusionNote, setExclusionNote] = useState<"steps" | "minActivations" | null>(null);

  const stepsValue = stepsDraft ?? lorebook.maxRecursionSteps;
  const minActValue = minActDraft ?? lorebook.minActivations;
  const depthMaxValue = depthMaxDraft ?? lorebook.minActivationsDepthMax;

  // Drop each draft once the refreshed record catches up (commit keeps the
  // draft painted so the thumb does not snap back while the RPC round-trips;
  // this returns control to the canonical prop).
  useEffect(() => {
    if (stepsDraft != null && lorebook.maxRecursionSteps === stepsDraft) setStepsDraft(null);
  }, [lorebook.maxRecursionSteps, stepsDraft]);
  useEffect(() => {
    if (minActDraft != null && lorebook.minActivations === minActDraft) setMinActDraft(null);
  }, [lorebook.minActivations, minActDraft]);
  useEffect(() => {
    if (depthMaxDraft != null && lorebook.minActivationsDepthMax === depthMaxDraft) setDepthMaxDraft(null);
  }, [lorebook.minActivationsDepthMax, depthMaxDraft]);

  // Commits — the mutual-exclusion pair writes BOTH fields in ONE
  // onUpdateMeta call (never two writes) and parks the note on the zeroed
  // control. No-op releases (value unchanged) persist nothing.
  const commitSteps = (v: number) => {
    if (v === lorebook.maxRecursionSteps) return;
    setExclusionNote(null);
    if (v > 0 && minActValue > 0) {
      onUpdateMeta({ maxRecursionSteps: v, minActivations: 0 });
      setExclusionNote("minActivations");
    } else {
      onUpdateMeta({ maxRecursionSteps: v });
    }
  };
  const commitMinActivations = (v: number) => {
    if (v === lorebook.minActivations) return;
    setExclusionNote(null);
    if (v > 0 && stepsValue > 0) {
      onUpdateMeta({ minActivations: v, maxRecursionSteps: 0 });
      setExclusionNote("steps");
    } else {
      onUpdateMeta({ minActivations: v });
    }
  };
  const commitDepthMax = (v: number) => {
    if (v === lorebook.minActivationsDepthMax) return;
    onUpdateMeta({ minActivationsDepthMax: v });
  };

  // Collapsing the section clears the transient exclusion note (and stale
  // drafts fall back to the canonical record).
  const toggleAdvanced = () => {
    setAdvancedOpen((v) => {
      if (v) setExclusionNote(null);
      return !v;
    });
  };

  // Search panel disclosure (owner request 2026-09-29): the panel is
//    collapsed by default — the advanced-toggle pattern again. The badge on
//    the toggle keeps an ACTIVE filter visible while collapsed (a filtered
//    list with no visible reason is a trap).
  const [searchOpen, setSearchOpen] = useState(false);
  const activeFilterCount =
    (searchQuery.trim() !== "" ? 1 : 0) + selectedKeys.length + selectedSecondaryKeys.length;

  const handleReorderEntries = async (
    updates: Array<{ id: string; sortOrder: number; position?: string }>
  ) => {
    const nextEntries = await onReorderEntries(updates);
    setEntries(nextEntries);
  };

  // Toggle a single entry's enabled flag. Optimistically updates the local
  // list so the switch flips immediately, then commits via the parent's
  // updateLoreEntry call. On error we refetch to reconcile.
  const handleToggleEntryEnabled = async (entryId: string, enabled: boolean) => {
    const prev = entries;
    setEntries((cur) => cur.map((e) => (e.id === entryId ? { ...e, enabled } : e)));
    try {
      const updated = await onToggleEntryEnabled(entryId, enabled);
      setEntries((cur) => cur.map((e) => (e.id === entryId ? updated : e)));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to toggle lore entry enabled", error);
      setEntries(prev);
    }
  };

  return (
    <div className="mb-3 rounded-xl border border-border bg-surface">
      {/* ── Accordion header ── */}
      <div
        className="flex items-center gap-1.5"
        style={{
          padding: isMobile ? "12px 12px" : "10px 12px",
          borderRadius: expanded ? "12px 12px 0 0" : 12,
        }}
      >
        {/* Expand button ▶/▼ — hidden while editing on mobile: the inline
            create/edit form then owns the full row width and its stacked rows
            (name / scope / confirm) align with the card edge instead of being
            pushed right of a caret that is dead weight mid-edit (MUI step 6). */}
        {(!editing || !isMobile) && (
          <div
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2"
            onClick={onToggle}
          >
            {expanded ? (
              <span className="text-[10px]">{"\u25BC"}</span>
            ) : (
              <span className="text-[10px]">{"\u25B6"}</span>
            )}
          </div>
        )}

        {/* ── Edit mode: inline name + scope form ── */}
        {editing ? (
          <div
            className={cn(
              "flex flex-1 items-center gap-2",
              isMobile && "flex-wrap"
            )}
          >
            {/* Lorebook name — takes the full row on mobile */}
            <InlineRenameInput
              className={cn("flex-1", isMobile && "basis-full")}
              value={editLbName}
              onChange={(e) => onEditLbName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSaveEdit()}
              autoFocus
            />
            {/* Scope selector */}
            <SegmentedControl
              value={editLbScope}
              options={[
                { value: "global", label: t("scope_global") },
                { value: "entity", label: t("scope_entity") },
                { value: "chat", label: t("scope_chat") },
              ]}
              onChange={onEditLbScope}
              compact
              fill={isMobile}
              className={cn(isMobile && "[&_button]:py-0.5")}
            />
            {editLbScope === "entity" && (
              <LorebookOwnerPicker
                links={links} characters={characters} personas={personas} onSetLinks={onSetLinks} t={t} isMobile={isMobile}
                className={cn("w-fit max-w-[150px] shrink-0", isMobile && "basis-full max-w-none")}
              />
            )}
            {/* Save (✓) and Cancel (✕) — 44px touch target on mobile, new row */}
            <div className={cn("flex items-center gap-1", isMobile && "w-full justify-end")}>
              <div
                className={cn(
                  "flex shrink-0 cursor-pointer items-center justify-center rounded text-accent-t hover:bg-s2",
                  isMobile ? "h-11 w-11" : "h-5 w-5"
                )}
                onClick={onSaveEdit}
              >
                <Ic.check />
              </div>
              <div
                className={cn(
                  "flex shrink-0 cursor-pointer items-center justify-center rounded text-t3 hover:bg-s2",
                  isMobile ? "h-11 w-11" : "h-5 w-5"
                )}
                onClick={onCancelEdit}
              >
                <Ic.close />
              </div>
            </div>
          </div>
        ) : (
          /* ── Normal mode: name + toggle + counter + actions ── */
          <>
            {(() => {
              const binding = lorebookBindingIcon(lorebook);
              if (!binding) return null;
              return (
                <CustomTooltip content={t(binding.tooltipKey)} key="binding">
                  <span className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center text-t4">{binding.icon}</span>
                </CustomTooltip>
              );
            })()}
            <span
              className="flex-1 cursor-pointer truncate text-[13px] font-medium text-t1"
              onClick={onToggle}
            >
              {lorebook.name}
            </span>
            {lorebook.scopeType === "entity" && linksLoaded && links.length === 0 && (
              <span className="shrink-0 font-ui text-[calc(var(--ui-fs)-3px)] text-warning">
                {t("lore_unbound_warning")}
              </span>
            )}

            {/* Enabled/disabled toggle */}
            <div
              className="relative ml-1 mr-1 h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full transition-[background-color] duration-200 ease-out"
              style={{
                backgroundColor: lorebook.enabled
                  ? "var(--accent)"
                  : "var(--s3)",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleEnabled();
              }}
            >
              <div
                className="absolute top-[3px] h-4 w-4 rounded-full shadow-sm transition-[left,background-color] duration-200 ease-out"
                style={{
                  left: lorebook.enabled ? 19 : 3,
                  backgroundColor: lorebook.enabled ? "#fff" : "var(--t3)",
                }}
              />
            </div>

            {/* Entry counter + token estimate */}
            <span
              className="shrink-0 rounded-full bg-s3 px-2 py-0.5 font-ui text-[11px] text-t3 tabular-nums"
              title={`${entries.length} · ${totalTokens.toLocaleString()} ${t("tokens_label")}`}
            >
              {entries.length}
              {totalTokens > 0 && (
                <span className="ml-1 text-t3/70">
                  · {formatTokenCount(totalTokens)}
                </span>
              )}
            </span>

            {/* ── Mobile context menu (⋮) → ActionSheet (bottom sheet) ──
                Mobile rule: every popover surfaces as a bottom sheet, no
                exceptions. The ⋮ trigger opens an ActionSheet (vaul Drawer
                via shared/BottomSheet) listing add/duplicate/export/edit/
                delete. The desktop branch below renders the same actions as a
                row of inline icon buttons (not a menu). */}
            {isMobile ? (
              <>
                <button
                  type="button"
                  className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded text-t2 text-xl leading-none transition-all hover:bg-s2 select-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleActionMenu();
                  }}
                >
                  ⋮
                </button>
                <ActionSheet
                  open={actionMenuOpen}
                  onClose={onToggleActionMenu}
                  title={lorebook.name}
                  items={[
                    { icon: <Ic.plus />, label: t("lore_add_entry"), action: onAddEntry },
                    { icon: <span>⧉</span>, label: t("lore_duplicate"), action: onDuplicate },
                    { icon: <Ic.download />, label: t("lore_export_st"), action: onExport },
                    { icon: <Ic.edit />, label: t("edit"), action: onStartEdit },
                    { icon: <Ic.del />, label: t("delete_lorebook_confirm"), danger: true, action: onDelete },
                  ]}
                />
              </>
            ) : (
              /* ── Desktop: a row of small buttons ── */
              <div className="flex shrink-0 items-center gap-0.5 ml-1">
                <CustomTooltip content={t("lore_add_entry")}>
                  <div
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddEntry();
                    }}
                  >
                    <Ic.plus />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("lore_duplicate")}>
                  <div
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate();
                    }}
                  >
                    <span className="text-[11px]">⧉</span>
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("lore_export_st")}>
                  <div
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExport();
                    }}
                  >
                    <Ic.download />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={"Edit"}>
                  <div
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartEdit();
                    }}
                  >
                    <Ic.edit />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("delete_lorebook_confirm")}>
                  <div
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                  >
                    <Ic.del />
                  </div>
                </CustomTooltip>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Expanded content: settings + entry list ── */}
      <AnimatedDisclosure
        open={expanded && !editing}
        className="flex flex-col gap-3 border-t border-border"
        style={{ padding: "10px 12px" }}
      >
          {/* Lorebook settings: token budget, scan depth, recursive scanning, links.
              The card is a column: [inputs row] → [advanced toggle] → [advanced
              section] (resweep step 6). */}
          <div
            className={cn(
              "flex flex-col gap-2.5 rounded-lg border border-border bg-s2/50 px-3 py-2.5",
            )}
          >
          <div
            className={cn(
              "flex items-end gap-6",
              isMobile && "flex-col items-stretch gap-3"
            )}
          >
            <div className={cn("flex gap-4", isMobile && "flex-col gap-3")}>
              <CustomTooltip content={t("lore_token_budget_hint")}>
                <div className="flex-1">
                  <label className={lblCls}>
                    {t("lore_token_budget")}
                  </label>
                  <div className="flex items-center gap-1.5">
                    {lorebook.tokenBudgetPercent == null ? (
                      <NumberInput
                        className="w-full"
                        hideControls
                        min={0}
                        value={lorebook.tokenBudget}
                        onChange={(v) => onUpdateMeta({ tokenBudget: v })}
                      />
                    ) : (
                      <NumberInput
                        className="w-full"
                        hideControls
                        min={0}
                        max={100}
                        value={lorebook.tokenBudgetPercent}
                        onChange={(v) => onUpdateMeta({ tokenBudgetPercent: Math.max(0, Math.min(100, v)) })}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => onUpdateMeta({
                        tokenBudgetPercent: lorebook.tokenBudgetPercent == null ? 25 : null,
                      })}
                      className="flex h-8 !min-h-8 shrink-0 cursor-pointer items-center rounded-md border border-border bg-s3 px-3 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-t3 hover:text-t1"
                      title={lorebook.tokenBudgetPercent == null ? t("lore_token_budget_switch_to_percent") : t("lore_token_budget_switch_to_fixed")}
                    >
                      {lorebook.tokenBudgetPercent == null ? t("lore_token_budget_mode_fixed") : t("lore_token_budget_mode_percent")}
                    </button>
                  </div>
                </div>
              </CustomTooltip>
              <CustomTooltip content={t("lore_scan_depth_hint")}>
                <div className="flex-1">
                  <label className={lblCls}>
                    {t("lore_scan_depth")}
                  </label>
                  <NumberInput
                    className="w-full"
                    hideControls
                    min={0}
                    value={lorebook.scanDepth}
                    onChange={(v) => onUpdateMeta({ scanDepth: v })}
                  />
                </div>
              </CustomTooltip>
              {lorebook.tokenBudgetPercent != null && (
                <CustomTooltip content={t("lore_token_budget_cap_hint")}>
                  <div className="flex-1">
                    <label className={lblCls}>
                      {t("lore_token_budget_cap")}
                    </label>
                    <NumberInput
                      className="w-full"
                      hideControls
                      min={0}
                      value={lorebook.tokenBudgetCap}
                      onChange={(v) => onUpdateMeta({ tokenBudgetCap: Math.max(0, v) })}
                    />
                  </div>
                </CustomTooltip>
              )}
            </div>
            <div className="flex flex-col gap-2 pb-0.5">
              <CustomTooltip content={t("lore_recursive_scanning_hint")}>
                <div>
                  <Checkbox
                    checked={lorebook.recursiveScanning}
                    onChange={(v) => onUpdateMeta({ recursiveScanning: v })}
                    label={t("lore_recursive_scanning")}
                  />
                </div>
              </CustomTooltip>
              <CustomTooltip content={t("lore_book_group_scoring_hint")}>
                <div>
                  <Checkbox
                    checked={lorebook.useGroupScoring}
                    onChange={(v) => onUpdateMeta({ useGroupScoring: v })}
                    label={t("lore_book_group_scoring")}
                  />
                </div>
              </CustomTooltip>
              <CustomTooltip content={t("lore_book_case_sensitive_hint")}>
                <div>
                  <Checkbox
                    checked={lorebook.caseSensitive}
                    onChange={(v) => onUpdateMeta({ caseSensitive: v })}
                    label={t("lore_book_case_sensitive")}
                  />
                </div>
              </CustomTooltip>
              <CustomTooltip content={t("lore_book_match_whole_words_hint")}>
                <div>
                  <Checkbox
                    checked={lorebook.matchWholeWords}
                    onChange={(v) => onUpdateMeta({ matchWholeWords: v })}
                    label={t("lore_book_match_whole_words")}
                  />
                </div>
              </CustomTooltip>
              <LorebookActivationSettings includeNames={lorebook.includeNames} characterStrategy={lorebook.characterStrategy} t={t} onUpdateMeta={onUpdateMeta} />
            </div>
            {/* Link targets — only for non-chat scopes */}
            {lorebook.scopeType !== "chat" && (
              <LorebookOwnerPicker
                links={links} characters={characters} personas={personas} onSetLinks={onSetLinks} t={t} isMobile={isMobile} showLabel
                className={cn("w-fit self-start", !isMobile && "flex-1 pb-0.5")}
              />
            )}
          </div>

            {/* fork #1 of the LoreEntryEditor advanced toggle — collapsed by
                default, local state, same ▲/▼ text-link shape (resweep step 6). */}
            <button type="button"
              className="flex items-center gap-1.5 self-start text-[13px] font-medium text-accent-t transition-all hover:text-accent"
              onClick={toggleAdvanced}
            >
              <span className="text-[10px]">{advancedOpen ? "▲" : "▼"}</span>
              {advancedOpen
                ? t("lore_advanced_collapse")
                : t("lore_advanced_settings")}
            </button>

            {/* Advanced book settings body (min activations / depth max /
                recursion steps / overflow alert). Desktop: auto-fit grid —
                minmax(200px,1fr) keeps RU uppercase labels one-or-two lines
                (ПРЕДЕЛ ГЛУБИНЫ ДЛЯ МИНИМУМА ≈ 27 chars is the worst case;
                AD-022); the grid collapses to 2 columns when the panel is
                narrow. Mobile: one column like the row above. */}
            <AnimatedDisclosure open={advancedOpen} className="flex flex-col gap-3">
              <div
                className={cn(
                  "grid gap-x-6 gap-y-3",
                  isMobile ? "grid-cols-1" : "grid-cols-[repeat(auto-fit,minmax(200px,1fr))]",
                )}
              >
                <CustomTooltip content={t("lore_max_recursion_steps_hint")}>
                  <div>
                    <SliderField
                      label={t("lore_max_recursion_steps")}
                      value={stepsValue}
                      min={0}
                      max={10}
                      step={1}
                      disabled={!lorebook.recursiveScanning}
                      onChange={setStepsDraft}
                      onCommit={commitSteps}
                      rangeTestId="lore-steps-range"
                      numberTestId="lore-steps-number"
                    />
                    {stepsValue === 0 && (
                      <p className="mt-1 text-[calc(var(--ui-fs)-2px)] text-t3">
                        {exclusionNote === "steps"
                          ? t("lore_reset_by_min_act")
                          : t("lore_steps_zero")}
                      </p>
                    )}
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("lore_min_activations_hint")}>
                  <div>
                    <SliderField
                      label={t("lore_min_activations")}
                      value={minActValue}
                      min={0}
                      max={100}
                      step={1}
                      onChange={setMinActDraft}
                      onCommit={commitMinActivations}
                      rangeTestId="lore-min-act-range"
                      numberTestId="lore-min-act-number"
                    />
                    {minActValue === 0 && (
                      <p className="mt-1 text-[calc(var(--ui-fs)-2px)] text-t3">
                        {exclusionNote === "minActivations"
                          ? t("lore_reset_by_steps")
                          : t("lore_min_act_zero")}
                      </p>
                    )}
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("lore_min_activations_depth_max_hint")}>
                  <div>
                    <SliderField
                      label={t("lore_min_activations_depth_max")}
                      value={depthMaxValue}
                      min={0}
                      max={100}
                      step={1}
                      disabled={minActValue === 0}
                      onChange={setDepthMaxDraft}
                      onCommit={commitDepthMax}
                      rangeTestId="lore-depth-max-range"
                      numberTestId="lore-depth-max-number"
                    />
                    {depthMaxValue === 0 && minActValue !== 0 && (
                      <p className="mt-1 text-[calc(var(--ui-fs)-2px)] text-t3">
                        {t("lore_depth_max_zero")}
                      </p>
                    )}
                  </div>
                </CustomTooltip>
              </div>
              <CustomTooltip content={t("lore_overflow_alert_hint")}>
                <div>
                  <Checkbox
                    checked={lorebook.overflowAlert}
                    onChange={(v) => onUpdateMeta({ overflowAlert: v })}
                    label={t("lore_overflow_alert")}
                  />
                </div>
              </CustomTooltip>
            </AnimatedDisclosure>
          </div>

          {/* Drag-and-drop entry list grouped by position */}
          {/* fork #2 of the LoreEntryEditor advanced toggle — collapsed by
              default, same ▲/▼ text-link shape; the ·N suffix surfaces active
              filters while collapsed (owner request 2026-09-29). */}
          <button type="button"
            className="flex items-center gap-1.5 self-start text-[13px] font-medium text-accent-t transition-all hover:text-accent"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <span className="text-[10px]">{searchOpen ? "▲" : "▼"}</span>
            {searchOpen ? t("lore_search_collapse") : t("lore_search_toggle")}
            {activeFilterCount > 0 && (
              <span className="text-t3">· {activeFilterCount}</span>
            )}
          </button>
          <AnimatedDisclosure open={searchOpen} className="flex flex-col">
            <ListSearchPanel
              query={searchQuery}
              onQueryChange={setSearchQuery}
              selectedTags={selectedKeys}
              onSelectedTagsChange={setSelectedKeys}
              availableTags={availableKeys}
              tagInputPlaceholder={t("lore_search_keys_placeholder")}
              secondarySelectedTags={selectedSecondaryKeys}
              onSecondarySelectedTagsChange={setSelectedSecondaryKeys}
              secondaryAvailableTags={availableSecondaryKeys}
              secondaryTagInputPlaceholder={t("lore_search_secondary_keys_placeholder")}
            />
          </AnimatedDisclosure>
          <LoreEntryList
            entries={filteredEntries}
            activeEntryId={activeEntryId}
            isMobile={isMobile}
            t={t}
            onEntryClick={onEntryClick}
            onReorder={handleReorderEntries}
            onToggleEnabled={handleToggleEntryEnabled}
            dndDisabled={isFiltering}
          />

          {/* Add entry button */}
          <AddButton
            onClick={onAddEntry}
            className="justify-center"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <line x1="8" y1="2" x2="8" y2="14" />
              <line x1="2" y1="8" x2="14" y2="8" />
            </svg>
            {t("lore_add_entry")}
          </AddButton>
      </AnimatedDisclosure>
    </div>
  );
}
