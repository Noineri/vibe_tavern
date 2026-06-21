/**
 * LorebookAccordion — раскрывающийся аккордеон одного лорбука в списке.
 *
 * Показывает заголовок (имя, тогл enabled, действия) и
 * раскрывающийся список записей с настройками (token budget, scan depth).
 *
 * В режиме редактирования — inline-форма для имени + scope.
 * На мобильных — контекстное меню (⋮) вместо набора кнопок.
 */
import { useState, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

import { Ic, Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { NumberInput } from "../../shared/NumberInput.js";
import {
  listLoreEntries,
  type LorebookRecord,
  type LoreEntryRecord,
  type LorebookLinkRecord,
} from "../../../app-client.js";
import { LoreEntryList } from "./LoreEntryList.js";
import { LinkBindingPopover, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { countTokens } from "../../../utils/tokenizer.js";

// ── Helpers ────────────────────────────────────────────────────────────

/** Compact token count: 999 → "999", 1200 → "1.2k", 1500000 → "1.5M". */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Derive a single binding icon for a lorebook row, showing what it is bound to.
 * Uses the primary-owner FK columns (not the multi-bind `lorebook_links` rows):
 * precedence is chat → character → persona, since chat is the most specific
 * scope. Global lorebooks return null (no binding icon — they are unbound by
 * definition). Multi-bind surface is a follow-up.
 */
function lorebookBindingIcon(lb: LorebookRecord): { icon: ReactNode; tooltipKey: string } | null {
  if (lb.scopeType === "global") return null;
  if (lb.chatId) return { icon: <Ic.chat />, tooltipKey: "scope_chat" };
  if (lb.characterId) return { icon: <Ic.book />, tooltipKey: "scope_char" };
  if (lb.personaId) return { icon: <Ic.user />, tooltipKey: "scope_persona" };
  return null;
}

// ── Types ──────────────────────────────────────────────────────────────

export type Scope = "global" | "character" | "persona" | "chat" | "all";

interface LorebookAccordionProps {
  lorebook: LorebookRecord;
  links: LorebookLinkRecord[];
  expanded: boolean;
  editing: boolean;
  editLbName: string;
  editLbScope: string;
  activeEntryId: string | null;
  isMobile: boolean;
  actionMenuOpen: boolean;
  onToggleActionMenu: () => void;
  t: (key: string) => string;
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
    recursiveScanning?: boolean;
  }) => void;
  onReorderEntries: (updates: Array<{ id: string; sortOrder: number; position?: string }>) => Promise<LoreEntryRecord[]>;
  onToggleEntryEnabled: (entryId: string, enabled: boolean) => Promise<LoreEntryRecord>;
  onSetLinks: (links: Array<{ targetType: "character" | "persona"; targetId: string }>) => void;
  onDuplicate: () => void;
  onExport: () => void;
  characters: LinkTarget[];
  personas: LinkTarget[];
  isRu: boolean;
}

// ── Component ──────────────────────────────────────────────────────────

export function LorebookAccordion({
  lorebook,
  links,
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
  isRu,
}: LorebookAccordionProps) {
  // ── Entries: загружаются сразу (для счётчика и токенов в шапке),
  //    и остаются доступными при раскрытии.
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    listLoreEntries(lorebook.id).then((data) => {
      if (!cancelled) setEntries(data);
    });
    return () => {
      cancelled = true;
    };
  }, [lorebook.id]);

  // Суммарная оценка токенов всех записей (по content).
  const totalTokens = useMemo(
    () =>
      entries.length === 0
        ? 0
        : countTokens(entries.map((e) => e.content).join("\n")),
    [entries],
  );

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
      {/* ── Заголовок аккордеона ── */}
      <div
        className="flex items-center gap-1.5"
        style={{
          padding: isMobile ? "12px 12px" : "10px 12px",
          borderRadius: expanded ? "12px 12px 0 0" : 12,
        }}
      >
        {/* Кнопка раскрытия ▶/▼ */}
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

        {/* ── Режим редактирования: inline-форма имени + scope ── */}
        {editing ? (
          <div
            className={cn(
              "flex flex-1 items-center gap-2",
              isMobile && "flex-wrap"
            )}
          >
            {/* Имя лорбука — на мобиле занимает всю строку */}
            <input
              className={cn(
                "flex-1 rounded border border-accent bg-bg px-2 py-0.5 text-[13px] font-medium text-t1 outline-none",
                isMobile && "min-w-0 basis-full"
              )}
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
                { value: "character", label: t("scope_char") },
                { value: "persona", label: t("scope_persona") },
                { value: "chat", label: t("scope_chat") },
              ]}
              onChange={onEditLbScope}
              compact
              fill={isMobile}
              className={cn(isMobile && "[&_button]:py-0.5")}
            />
            {/* Save (✓) и Cancel (✕) — на мобиле 44px touch target, новая строка */}
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
          /* ── Обычный режим: имя + тогл + счётчик + действия ── */
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

            {/* Тогл enabled/disabled */}
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

            {/* Счётчик записей + оценка токенов */}
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

            {/* ── Мобильное контекстное меню (⋮) ── */}
            {isMobile ? (
              <div className="relative ml-1">
                <div
                  className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded text-t2 text-xl leading-none transition-all hover:bg-s2 select-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleActionMenu();
                  }}
                >
                  ⋮
                </div>
                {actionMenuOpen && (
                  <>
                    {/* Backdrop для закрытия */}
                    <div
                      className="fixed inset-0 z-[99]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleActionMenu();
                      }}
                    />
                    <div
                      className="glass-blur absolute right-0 top-full z-[100] mt-1 min-w-[160px] overflow-hidden rounded-lg border border-border bg-glass-bg py-1 shadow-theme-lg"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-t1 transition-colors hover:bg-s2 active:bg-s3"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddEntry();
                          onToggleActionMenu();
                        }}
                      >
                        <Ic.plus /> {t("lore_add_entry")}
                      </div>
                      <div
                        className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-t1 transition-colors hover:bg-s2 active:bg-s3"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicate();
                          onToggleActionMenu();
                        }}
                      >
                        <span>⧉</span> {t("lore_duplicate")}
                      </div>
                      <div
                        className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-t1 transition-colors hover:bg-s2 active:bg-s3"
                        onClick={(e) => {
                          e.stopPropagation();
                          onExport();
                          onToggleActionMenu();
                        }}
                      >
                        <Ic.download /> {t("lore_export_st")}
                      </div>
                      <div
                        className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-t1 transition-colors hover:bg-s2 active:bg-s3"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStartEdit();
                          onToggleActionMenu();
                        }}
                      >
                        <Ic.edit /> {t("edit")}
                      </div>
                      <div
                        className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-danger transition-colors hover:bg-s2 active:bg-s3"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete();
                          onToggleActionMenu();
                        }}
                      >
                        <Ic.del /> {t("delete_lorebook_confirm")}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              /* ── Десктоп: набор мелких кнопок ── */
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

      {/* ── Раскрытое содержимое: настройки + список записей ── */}
      {expanded && !editing && (
        <div
          className="flex flex-col gap-3 border-t border-border"
          style={{ padding: "10px 12px" }}
        >
          {/* Настройки лорбука: token budget, scan depth, recursive scanning, links */}
          <div
            className={cn(
              "flex items-end gap-6 rounded-lg border border-border bg-s2/50 px-3 py-2.5",
              isMobile && "flex-col items-stretch gap-3"
            )}
          >
            <div className={cn("flex gap-4", isMobile && "flex-col gap-3")}>
              <CustomTooltip content={t("lore_token_budget_hint")}>
                <div className="flex-1">
                  <label className="mb-1 block text-[11px] font-medium uppercase leading-tight tracking-[0.05em] text-t3/70">
                    {t("lore_token_budget")}
                  </label>
                  <NumberInput
                    className="w-full"
                    hideControls
                    min={0}
                    value={lorebook.tokenBudget}
                    onChange={(v) => onUpdateMeta({ tokenBudget: v })}
                  />
                </div>
              </CustomTooltip>
              <CustomTooltip content={t("lore_scan_depth_hint")}>
                <div className="flex-1">
                  <label className="mb-1 block text-[11px] font-medium uppercase leading-tight tracking-[0.05em] text-t3/70">
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
            </div>
            <div className="pb-0.5">
              <CustomTooltip content={t("lore_recursive_scanning_hint")}>
                <div>
                  <Checkbox
                    checked={lorebook.recursiveScanning}
                    onChange={(v) => onUpdateMeta({ recursiveScanning: v })}
                    label={t("lore_recursive_scanning")}
                  />
                </div>
              </CustomTooltip>
            </div>
            {/* Link targets — only for non-chat scopes */}
            {lorebook.scopeType !== 'chat' && (
              <div className={cn("w-fit self-start", !isMobile && "flex-1 pb-0.5")}>
                <label className="mb-1 block text-[11px] font-medium uppercase leading-tight tracking-[0.05em] text-t3/70">
                  {t("lore_link_targets")}
                </label>
                <LinkBindingPopover
                  links={links}
                  characters={characters}
                  personas={personas}
                  onSetLinks={(nextLinks) => onSetLinks(
                    nextLinks.filter((l): l is { targetType: "character" | "persona"; targetId: string } =>
                      l.targetType === "character" || l.targetType === "persona",
                    ),
                  )}
                  t={t}
                  isMobile={isMobile}
                />
              </div>
            )}
          </div>

          {/* Drag-and-drop entry list grouped by position */}
          <LoreEntryList
            entries={entries}
            activeEntryId={activeEntryId}
            isMobile={isMobile}
            isRu={isRu}
            t={t}
            onEntryClick={onEntryClick}
            onReorder={handleReorderEntries}
            onToggleEnabled={handleToggleEntryEnabled}
          />

          {/* Add entry button */}
          <button
            type="button"
            className="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent"
            onClick={onAddEntry}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <line x1="8" y1="2" x2="8" y2="14" />
              <line x1="2" y1="8" x2="14" y2="8" />
            </svg>
            {t("lore_add_entry")}
          </button>
        </div>
      )}
    </div>
  );
}
