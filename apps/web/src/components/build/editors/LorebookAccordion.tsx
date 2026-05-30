/**
 * LorebookAccordion — раскрывающийся аккордеон одного лорбука в списке.
 *
 * Показывает заголовок (имя, тогл enabled, действия) и
 * раскрывающийся список записей с настройками (token budget, scan depth).
 *
 * В режиме редактирования — inline-форма для имени + scope.
 * На мобильных — контекстное меню (⋮) вместо набора кнопок.
 */
import { useState, useEffect } from "react";

import { Ic, Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import {
  listLoreEntries,
  type LorebookRecord,
  type LoreEntryRecord,
} from "../../../app-client.js";

// ── Types ──────────────────────────────────────────────────────────────

export type Scope = "global" | "character" | "persona" | "chat";

interface LorebookAccordionProps {
  lorebook: LorebookRecord;
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
}

// ── Component ──────────────────────────────────────────────────────────

export function LorebookAccordion({
  lorebook,
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
}: LorebookAccordionProps) {
  // ── Entries: загружаются при раскрытии аккордеона ──
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    listLoreEntries(lorebook.id).then((data) => {
      if (!cancelled) setEntries(data);
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, lorebook.id]);

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
            {/* Scope selector — на мобиле растягивается */}
            <select
              className={cn(
                "h-7 rounded border border-accent bg-bg px-1.5 text-[11px] text-t1 outline-none",
                isMobile && "min-h-[44px] flex-1"
              )}
              value={editLbScope}
              onChange={(e) => onEditLbScope(e.target.value)}
            >
              <option value="global">{t("scope_global")}</option>
              <option value="character">{t("scope_char")}</option>
              <option value="persona">{t("scope_persona")}</option>
              <option value="chat">{t("scope_chat")}</option>
            </select>
            {/* Save (✓) и Cancel (✕) — на мобиле 44px touch target */}
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
        ) : (
          /* ── Обычный режим: имя + тогл + счётчик + действия ── */
          <>
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

            {/* Счётчик записей */}
            <span className="shrink-0 rounded-full bg-s3 px-2 py-0.5 font-ui text-[11px] text-t3">
              {entries.length}
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
                      className="absolute right-0 top-full z-[100] mt-1 min-w-[160px] overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-theme-lg"
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
                          onStartEdit();
                          onToggleActionMenu();
                        }}
                      >
                        <Ic.edit /> Edit
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
          {/* Настройки лорбука: token budget, scan depth, recursive scanning */}
          <div
            className={cn(
              "flex items-end gap-6 rounded-lg border border-border bg-s2/50 px-3 py-2.5",
              isMobile && "flex-col items-stretch gap-3"
            )}
          >
            <div className={cn("flex gap-4", isMobile && "gap-3")}>
              <CustomTooltip content={t("lore_token_budget_hint")}>
                <div className="flex-1">
                  <label className="mb-1 block text-[11px] font-medium uppercase leading-tight tracking-[0.05em] text-t3/70">
                    {t("lore_token_budget")}
                  </label>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="number"
                    min={0}
                    value={lorebook.tokenBudget}
                    onChange={(e) => {
                      const v = Math.max(0, parseInt(e.target.value) || 0);
                      onUpdateMeta({ tokenBudget: v });
                    }}
                  />
                </div>
              </CustomTooltip>
              <CustomTooltip content={t("lore_scan_depth_hint")}>
                <div className="flex-1">
                  <label className="mb-1 block text-[11px] font-medium uppercase leading-tight tracking-[0.05em] text-t3/70">
                    {t("lore_scan_depth")}
                  </label>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="number"
                    min={0}
                    value={lorebook.scanDepth}
                    onChange={(e) => {
                      const v = Math.max(0, parseInt(e.target.value) || 0);
                      onUpdateMeta({ scanDepth: v });
                    }}
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
          </div>

          {/* Пустое состояние */}
          {entries.length === 0 && (
            <div className="py-3 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
              {t("lore_no_entries")}
            </div>
          )}

          {/* Список записей */}
          {entries.map((e) => (
            <div
              key={e.id}
              className={cn(
                "cursor-pointer rounded-lg border transition-all min-h-[44px]",
                e.id === activeEntryId
                  ? "border-accent bg-accent-dim"
                  : "border-border bg-surface hover:bg-s2"
              )}
              style={{ padding: "10px 14px" }}
              onClick={() => onEntryClick(e.id)}
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    e.enabled ? "bg-success" : "bg-t3"
                  )}
                />
                <span
                  className={cn(
                    "flex-1 truncate text-[13px] font-medium",
                    e.enabled ? "text-t1" : "text-t3 line-through"
                  )}
                >
                  {e.title || t("lore_no_entries")}
                </span>
              </div>
              <div className="mt-1 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
                {e.keys.length > 0
                  ? `keys: ${e.keys.join(", ")}`
                  : t("lore_no_entries")}
              </div>
              {e.content && (
                <div
                  className="mt-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {e.content}
                </div>
              )}
              {e.content && (
                <TokenCounter
                  text={e.content}
                  className="mt-1 flex justify-end font-ui text-[11px] tabular-nums text-t3/50"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
