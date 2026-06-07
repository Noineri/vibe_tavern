/**
 * LoreEntryEditor — форма редактирования одной записи лорбука.
 *
 * Управляет собственной UI-state:
 *   - keyInput / secKeyInput — ввод ключевых слов
 *   - testText — текст для теста активации
 *   - advancedOpen — раскрытие расширенных настроек
 *   - confirmDeleteEntry — модалка подтверждения удаления
 *
 * Получает от родителя:
 *   - entry (данные записи)
 *   - updateAct (коллбэк для изменения полей → автосохранение)
 *   - onDeleted (коллбэк после успешного удаления)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useActiveCharacter, useActivePersona } from "../../../stores/snapshot-store.js";
import { Ic, Icons } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { ToggleChips } from "../../shared/ToggleChips.js";
import { Toggle } from "../../shared/Toggle.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { AiQuickPill, type AiQuickSettings } from "../../shared/AiQuickPill.js";
import { AiAssistantModal } from "../../shared/AiAssistantModal.js";
import { useT } from "../../../i18n/context.js";
import {
  testLoreActivation,
  deleteLoreEntry,
  streamAiAssistant,
  updateUiSettings,
  type AiAssistantRequestBody,
  type LoreEntryRecord,
} from "../../../app-client.js";

// ── Types ──────────────────────────────────────────────────────────────

interface LoreEntryEditorProps {
  entry: LoreEntryRecord;
  entryId: string;
  lorebookId: string;
  updateAct: (field: string, value: unknown) => void;
  onDeleted: () => void;
  isMobile: boolean;
  t: (key: string) => string;
}

// ── Component ──────────────────────────────────────────────────────────

export function LoreEntryEditor({
  entry,
  entryId,
  lorebookId,
  updateAct,
  onDeleted,
  isMobile,
  t,
}: LoreEntryEditorProps) {
  // ── Локальная UI-state ──
  const [keyInput, setKeyInput] = useState("");
  const [secKeyInput, setSecKeyInput] = useState("");
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testMutData, setTestMutData] = useState<{
    activatedIds: string[];
    totalEntries: number;
  } | null>(null);
  const [testingActivation, setTestingActivation] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState(false);

  const [aiHelperOpen, setAiHelperOpen] = useState(false);
  const activeCharacter = useActiveCharacter();
  const activePersona = useActivePersona();

  // ── Обработчики ключевых слов ──
  const handleKeyAdd = (
    e: React.KeyboardEvent,
    type: "keys" | "secondaryKeys"
  ) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const val = (type === "keys" ? keyInput : secKeyInput).trim();
    if (!val) return;
    const arr = entry[type];
    if (!arr.includes(val)) updateAct(type, [...arr, val]);
    type === "keys" ? setKeyInput("") : setSecKeyInput("");
  };

  const removeKey = (type: "keys" | "secondaryKeys", keyToRemove: string) => {
    const arr = entry[type];
    updateAct(type, arr.filter((k) => k !== keyToRemove));
  };

  // ── Тест активации ──
  const runTest = async () => {
    if (!testText.trim()) return;
    setTestingActivation(true);
    try {
      const result = await testLoreActivation(lorebookId, testText);
      setTestMutData(result);
      setTestResult({ ok: result.activatedIds.length > 0, msg: "" });
    } catch {
      setTestResult({ ok: false, msg: "Error" });
    } finally {
      setTestingActivation(false);
    }
  };

  // ── Удаление записи ──
  const handleDelete = async () => {
    setDeletingEntry(true);
    try {
      await deleteLoreEntry(lorebookId, entryId);
      onDeleted();
    } finally {
      setDeletingEntry(false);
      setConfirmDeleteEntry(false);
    }
  };

  return (
    <>
      <div className="mx-auto max-w-[860px] flex flex-col gap-6">
        {/* ── Заголовок: название + тогл enabled + удаление ── */}
        <div className="flex items-center gap-3">
          <input
            className="flex-1 rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[15px] font-semibold text-t1 outline-none focus:border-accent"
            type="text"
            value={entry.title}
            onChange={(e) => updateAct("title", e.target.value)}
            placeholder={t("lore_entry_title")}
          />
          <Toggle
            checked={entry.enabled}
            onChange={(v) => updateAct("enabled", v)}
            className="ml-1"
          />
          <CustomTooltip content={t("lore_save_entry")}>
            <button type="button"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-danger"
              onClick={() => setConfirmDeleteEntry(true)}
            >
              <Ic.del />
            </button>
          </CustomTooltip>
        </div>

        {/* ── Ключевые слова ── */}
        <div>
          <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
            {t("lore_entry_keys")}
          </label>
          <div className="flex items-start gap-2">
            <div
              className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
              style={{ minHeight: 38 }}
            >
              {entry.keys.map((k) => (
                <span
                  key={k}
                  className="flex cursor-pointer items-center gap-1 rounded bg-accent-dim px-2 py-0.5 text-[12px] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                  onClick={() => removeKey("keys", k)}
                >
                  {k} <Icons.Close />
                </span>
              ))}
              <input
                className="min-w-[80px] flex-1 border-0 bg-transparent text-[13px] text-t1 outline-none"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => handleKeyAdd(e, "keys")}
                placeholder={
                  entry.keys.length === 0
                    ? t("lore_entry_keys_placeholder")
                    : ""
                }
              />
            </div>
            <LoreKeysAiPill entry={entry} updateAct={updateAct} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
            onClick={() => setAiHelperOpen(true)}
          >
            <Ic.brain /> {t("script_ai_helper")}
          </button>
        </div>

        {/* ── Контент + тест активации ── */}
        <div>
          <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
            {t("lore_entry_content")}
          </label>
          <MobileExpandTextarea
            value={entry.content}
            onChange={(v) => updateAct("content", v)}
            label={t("lore_entry_content")}
          >
            <AutoTextarea
              className="w-full min-h-[180px] rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[13px] text-t1 outline-none focus:border-accent leading-[1.6]"
              style={{}}
              maxHeight={500}
              value={entry.content}
              onChange={(e) => updateAct("content", e.target.value)}
              placeholder={t("lore_entry_content_placeholder")}
            />
          </MobileExpandTextarea>
          <TokenCounter text={entry.content} />
        </div>

        {/* ── Тест активации (сразу под контентом) ── */}
        <div className={cn("flex gap-2", isMobile && "flex-col")}>
          <input
            className={cn(
              "h-8 flex-1 rounded-md border border-border bg-s2 px-3 text-[13px] text-t1 outline-none focus:border-accent",
              isMobile && "min-h-[44px]"
            )}
            type="text"
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runTest()}
            placeholder={t("lore_test_placeholder")}
          />
          <button type="button"
            className={cn(
              "h-8 cursor-pointer rounded-md bg-accent px-4 text-[12px] font-medium text-on-accent transition-all hover:opacity-90",
              isMobile && "min-h-[44px]"
            )}
            onClick={runTest}
            disabled={testingActivation}
          >
            {testingActivation ? "..." : t("lore_test_run")}
          </button>
        </div>
        {testResult && (
          <div
            className={cn(
              "flex items-center gap-2 rounded-md text-[12px] font-medium px-3 py-2",
              testResult.ok
                ? "border border-success bg-success-dim text-success-text"
                : "border border-danger bg-danger-dim text-danger-text"
            )}
          >
            {testResult.ok ? <Ic.check /> : <Ic.close />} {testResult.msg}
          </div>
        )}
        {testMutData && (
          <div className="flex items-center gap-2 rounded-md border border-success bg-success-dim px-3 py-2 text-[12px] font-medium text-success-text">
            <Ic.check /> Activated: {testMutData.activatedIds.length} /{" "}
            {testMutData.totalEntries} entries
          </div>
        )}

        {/* ── Тогл расширенных настроек ── */}
        <button type="button"
          className="flex items-center gap-1.5 text-[13px] font-medium text-accent-t transition-all hover:text-accent"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <span className="text-[10px]">{advancedOpen ? "▲" : "▼"}</span>
          {advancedOpen
            ? t("lore_cancel_edit")
            : t("lore_advanced_settings")}
        </button>

        {/* ── Расширенные настройки ── */}
        {advancedOpen && (
          <div
            className="flex flex-col gap-0"
            style={{
              paddingBottom: isMobile
                ? "calc(2rem + env(safe-area-inset-bottom, 0px))"
                : undefined,
            }}
          >
            {/* ═══ Группа 1: Триггеры и сопоставление ═══ */}
            <div className="pb-7 border-b border-border/50">
              <div className="mb-3 text-[13px] font-medium text-t1">
                {t("lore_activation_section")}
              </div>

              {/* Вторичные ключевые слова */}
              <div className="mb-4">
                <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                  {t("lore_entry_secondary_keys")}
                </label>
                <div
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
                  style={{ minHeight: 38 }}
                >
                  {entry.secondaryKeys.map((k) => (
                    <span
                      key={k}
                      className="flex cursor-pointer items-center gap-1 rounded bg-accent-dim px-2 py-0.5 text-[12px] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                      onClick={() => removeKey("secondaryKeys", k)}
                    >
                      {k} <Icons.Close />
                    </span>
                  ))}
                  <input
                    className="min-w-[80px] flex-1 border-0 bg-transparent text-[13px] text-t1 outline-none"
                    value={secKeyInput}
                    onChange={(e) => setSecKeyInput(e.target.value)}
                    onKeyDown={(e) => handleKeyAdd(e, "secondaryKeys")}
                  />
                </div>
              </div>

              {/* Логика + Роль */}
              <div className="flex flex-wrap gap-4 mb-4">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                    {t("lore_logic_label")}
                  </label>
                  <SegmentedControl
                    value={entry.logic}
                    options={[
                      { value: "AND_ANY", label: "AND ANY" },
                      { value: "AND_ALL", label: "AND ALL" },
                      { value: "NOT_ANY", label: "NOT ANY" },
                      { value: "NOT_ALL", label: "NOT ALL" },
                    ]}
                    onChange={(v) => updateAct("logic", v)}
                    compact
                  />
                </div>
                <CustomTooltip content={t("role_hint")}>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_role_label")}
                    </label>
                    <SegmentedControl
                      value={entry.role}
                      options={[
                        { value: "system", label: "System" },
                        { value: "user", label: "User" },
                        { value: "assistant", label: "Assistant" },
                      ]}
                      onChange={(v) => updateAct("role", v)}
                      compact
                    />
                  </div>
                </CustomTooltip>
              </div>

              {/* Триггеры */}
              <div className="mb-4">
                <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                  {t("lore_triggers_section")}
                </label>
                <ToggleChips
                  selected={entry.triggers}
                  options={(
                    [
                      "normal",
                      "continue",
                      "impersonate",
                      "swipe",
                      "regenerate",
                      "quiet",
                    ] as const
                  ).map((trig) => ({
                    value: trig,
                    label: t("trigger_" + trig),
                  }))}
                  onChange={(v) => updateAct("triggers", v)}
                />
              </div>

              {/* Источники сопоставления */}
              <div className="mb-4">
                <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                  {t("lore_matchsources_section")}
                </label>
                <ToggleChips
                  selected={entry.matchSources}
                  options={(
                    [
                      "character_desc",
                      "character_personality",
                      "character_note",
                      "persona_desc",
                      "scenario",
                      "creator_notes",
                    ] as const
                  ).map((src) => ({
                    value: src,
                    label: t("match_src_" + src),
                  }))}
                  onChange={(v) => updateAct("matchSources", v)}
                />
              </div>

              {/* Фильтр по персонажам */}
              <div>
                <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                  {t("lore_charfilter_section")}
                </label>
                <div
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
                  style={{ minHeight: 38 }}
                >
                  {entry.characterFilter.map((c) => (
                    <span
                      key={c}
                      className="flex cursor-pointer items-center gap-1 rounded bg-accent-dim px-2 py-0.5 text-[12px] text-accent-t transition-all hover:bg-border2 hover:text-t1"
                      onClick={() =>
                        updateAct(
                          "characterFilter",
                          entry.characterFilter.filter((x) => x !== c)
                        )
                      }
                    >
                      {c} ✕
                    </span>
                  ))}
                  <input
                    className="min-w-[80px] flex-1 border-0 bg-transparent text-[13px] text-t1 outline-none placeholder:text-t3/70"
                    placeholder={t("lore_char_filter_placeholder")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (v && !entry.characterFilter.includes(v)) {
                          updateAct("characterFilter", [
                            ...entry.characterFilter,
                            v,
                          ]);
                        }
                        (e.target as HTMLInputElement).value = "";
                      }
                    }}
                  />
                </div>
                <div className="mt-2">
                  <Checkbox
                    checked={entry.characterFilterExclude}
                    onChange={(v) => updateAct("characterFilterExclude", v)}
                    label={t("lore_char_filter_exclude")}
                  />
                </div>
              </div>
            </div>

            {/* ═══ Группа 2: Размещение и форматирование ═══ */}
            <div className="py-7 border-b border-border/50">
              <CustomTooltip content={t("lore_position_hint")} side="right" align="start">
                <div className="mb-3 inline-flex cursor-help items-center gap-1 text-[13px] font-medium text-t1">
                  {t("lore_position_label")}
                  <span className="text-[11px] text-t3">?</span>
                </div>
              </CustomTooltip>

              {/* Позиция — сетка pill-кнопок (2 колонки на мобиле) */}
              <div
                className={cn(
                  "grid gap-1.5 mb-4",
                  isMobile ? "grid-cols-2" : "grid-cols-4"
                )}
              >
                {(
                  [
                    "before_char",
                    "after_char",
                    "before_examples",
                    "after_examples",
                    "top_an",
                    "bottom_an",
                    "at_depth",
                    "outlet",
                  ] as const
                ).map((pos) => (
                  <CustomTooltip key={pos} content={t("pos_" + pos + "_hint")} side="top">
                    <button
                      type="button"
                      onClick={() => updateAct("position", pos)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-[11px] font-ui font-medium transition-all",
                        entry.position === pos
                          ? "border-accent bg-accent-dim text-accent-t"
                          : "border-border bg-s3 text-t2 hover:border-t3 hover:text-t1"
                      )}
                    >
                      {t("pos_" + pos)}
                    </button>
                  </CustomTooltip>
                ))}
              </div>

              {/* Числовые поля — 1 колонка на мобиле */}
              <div
                className={cn(
                  "grid gap-4",
                  isMobile && "grid-cols-1"
                )}
                style={{
                  gridTemplateColumns: isMobile
                    ? undefined
                    : "repeat(auto-fill, minmax(170px, 1fr))",
                }}
              >
                {(entry.position === "at_depth" ||
                  entry.position === "top_an" ||
                  entry.position === "bottom_an") && (
                  <CustomTooltip content={t("lore_depth_hint")} side="top" align="start">
                    <div>
                      <label className="mb-1.5 block cursor-help text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                        {t("lore_depth_label")}
                      </label>
                      <NumberInput
                        min={0}
                        value={entry.depth}
                        onChange={(v) => updateAct("depth", v)}
                      />
                    </div>
                  </CustomTooltip>
                )}
                <CustomTooltip content={t("lore_priority_hint")} side="top" align="start">
                  <div>
                    <label className="mb-1.5 block cursor-help text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_priority_label")}
                    </label>
                    <NumberInput
                      min={0}
                      value={entry.priority}
                      onChange={(v) => updateAct("priority", v)}
                    />
                  </div>
                </CustomTooltip>
                <div>
                  <CustomTooltip content={t("probability_hint")}>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_probability")}
                    </label>
                  </CustomTooltip>
                  <NumberInput
                    min={0}
                    max={100}
                    value={entry.probability}
                    onChange={(v) => updateAct("probability", v)}
                  />
                </div>
                <div>
                  <CustomTooltip content={t("scan_depth_override_hint")}>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_scan_depth_override")}
                    </label>
                  </CustomTooltip>
                  <NumberInput
                    min={-1}
                    value={entry.scanDepthOverride ?? -1}
                    onChange={(v) => updateAct("scanDepthOverride", v)}
                  />
                </div>
              </div>

              {/* Стратегия — чекбоксы */}
              <div
                className={cn(
                  "mt-4 grid gap-3",
                  isMobile ? "grid-cols-1" : "grid-cols-2"
                )}
              >
                <CustomTooltip content={t("constant_hint")}>
                  <Checkbox
                    checked={entry.constant}
                    onChange={(v) => updateAct("constant", v)}
                    label={t("lore_constant")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("case_sensitive_hint")}>
                  <Checkbox
                    checked={entry.caseSensitive}
                    onChange={(v) => updateAct("caseSensitive", v)}
                    label={t("lore_case_sensitive")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("match_whole_words_hint")}>
                  <Checkbox
                    checked={entry.matchWholeWords}
                    onChange={(v) => updateAct("matchWholeWords", v)}
                    label={t("lore_match_whole_words")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("ignore_budget_hint")}>
                  <Checkbox
                    checked={entry.ignoreBudget}
                    onChange={(v) => updateAct("ignoreBudget", v)}
                    label={t("lore_ignore_budget")}
                  />
                </CustomTooltip>
              </div>
            </div>

            {/* ═══ Группа 3: Продвинутая логика ═══ */}
            <div className="py-7">
              <div className="mb-3 text-[13px] font-medium text-t1">
                {t("lore_timed_section")}
              </div>

              {/* Тайминги — sticky/cooldown/delay */}
              <div
                className={cn(
                  "grid gap-4 mb-7",
                  isMobile && "grid-cols-1"
                )}
                style={{
                  gridTemplateColumns: isMobile
                    ? undefined
                    : "repeat(auto-fill, minmax(170px, 1fr))",
                }}
              >
                <CustomTooltip content={t("sticky_win_hint")}>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_sticky_window")}
                    </label>
                    <NumberInput
                      min={0}
                      value={entry.stickyWindow}
                      onChange={(v) => updateAct("stickyWindow", v)}
                    />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("cooldown_hint")}>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_cooldown_window")}
                    </label>
                    <NumberInput
                      min={0}
                      value={entry.cooldownWindow}
                      onChange={(v) => updateAct("cooldownWindow", v)}
                    />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("delay_hint")}>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_delay_window")}
                    </label>
                    <NumberInput
                      min={0}
                      value={entry.delayWindow}
                      onChange={(v) => updateAct("delayWindow", v)}
                    />
                  </div>
                </CustomTooltip>
              </div>

              {/* Рекурсия */}
              <div className="mb-7 pb-7 border-b border-border/50">
                <CustomTooltip content={t("lore_recursion_section_hint")} side="right" align="start">
                  <div className="mb-3 inline-flex cursor-help items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.07em] text-t3">
                    {t("lore_recursion_section")}
                    <span className="text-[11px] normal-case tracking-normal text-t3">?</span>
                  </div>
                </CustomTooltip>
                <div className="flex flex-wrap gap-4">
                  <CustomTooltip content={t("exclude_recursion_hint")}>
                    <Checkbox
                      checked={entry.excludeRecursion}
                      onChange={(v) => updateAct("excludeRecursion", v)}
                      label={t("lore_exclude_recursion")}
                    />
                  </CustomTooltip>
                  <CustomTooltip content={t("prevent_recursion_hint")}>
                    <Checkbox
                      checked={entry.preventRecursion}
                      onChange={(v) => updateAct("preventRecursion", v)}
                      label={t("lore_prevent_recursion")}
                    />
                  </CustomTooltip>
                  <CustomTooltip content={t("delay_until_recursion_hint")}>
                    <Checkbox
                      checked={entry.delayUntilRecursion}
                      onChange={(v) => updateAct("delayUntilRecursion", v)}
                      label={t("lore_delay_until_recursion")}
                    />
                  </CustomTooltip>
                </div>
                {entry.delayUntilRecursion && (
                  <div className="mt-3 max-w-[160px]">
                    <CustomTooltip content={t("recursion_level_hint")}>
                      <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                        {t("lore_recursion_label")}
                      </label>
                    </CustomTooltip>
                    <NumberInput
                      min={0}
                      value={entry.recursionLevel}
                      onChange={(v) => updateAct("recursionLevel", v)}
                    />
                  </div>
                )}
              </div>

              {/* Группа включения */}
              <div
                className={cn(
                  "flex flex-wrap gap-4 items-end",
                  isMobile && "flex-col items-stretch"
                )}
              >
                <div className="min-w-[140px] flex-1 max-w-[200px]">
                  <CustomTooltip content={t("group_hint")}>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_group_name")}
                    </label>
                  </CustomTooltip>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="text"
                    value={entry.groupName}
                    onChange={(e) => updateAct("groupName", e.target.value)}
                  />
                </div>
                <div className="min-w-[100px]">
                  <CustomTooltip content={t("group_weight_hint")}>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_group_weight")}
                    </label>
                  </CustomTooltip>
                  <NumberInput
                    min={0}
                    value={entry.groupWeight}
                    onChange={(v) => updateAct("groupWeight", v)}
                  />
                </div>
                <CustomTooltip content={t("prioritize_inclusion_hint")}>
                  <Checkbox
                    checked={entry.prioritizeInclusion}
                    onChange={(v) => updateAct("prioritizeInclusion", v)}
                    label={t("lore_prioritize_inclusion")}
                  />
                </CustomTooltip>
                <CustomTooltip content={t("group_scoring_hint")}>
                  <Checkbox
                    checked={entry.useGroupScoring}
                    onChange={(v) => updateAct("useGroupScoring", v)}
                    label={t("lore_use_group_scoring")}
                  />
                </CustomTooltip>
              </div>
            </div>
          </div>
        )}
      </div>

      <AiAssistantModal
        isOpen={aiHelperOpen}
        onClose={() => setAiHelperOpen(false)}
        apiMode="lore_entry"
        existingContent={entry.content}
        onReplace={(text) => updateAct("content", text)}
        onInsert={(text) => updateAct("content", entry.content ? `${entry.content.trimEnd()}\n\n${text}` : text)}
        mode="full"
        scopeContext={{
          characterId: activeCharacter?.id,
          personaId: activePersona?.id,
        }}
      />

      {/* ── Модалка подтверждения удаления записи ── */}
      {confirmDeleteEntry && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={() => setConfirmDeleteEntry(false)}
        >
          <div
            className="flex w-[400px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between border-b border-border"
              style={{ padding: "16px 20px" }}
            >
              <span className="text-sm font-semibold text-t1">
                {t("delete_entry_confirm")}
              </span>
              <div
                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1"
                onClick={() => setConfirmDeleteEntry(false)}
              >
                <Ic.close />
              </div>
            </div>
            <div className="p-5 text-[13px] text-t2">
              {t("delete_entry_msg")}
            </div>
            <div
              className="flex justify-end gap-2 border-t border-border"
              style={{ padding: "12px 20px" }}
            >
              <button type="button"
                className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
                onClick={() => setConfirmDeleteEntry(false)}
              >
                {t("lore_cancel_edit")}
              </button>
              <button type="button"
                className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all"
                onClick={handleDelete}
                disabled={deletingEntry}
              >
                {t("delete_entry_confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Lore Keys AI Pill ──────────────────────────────────────────────────

function LoreKeysAiPill({
  entry,
  updateAct,
}: {
  entry: LoreEntryRecord;
  updateAct: (field: string, value: unknown) => void;
}) {
  const { t } = useT();
  const [settings, setSettings] = useState<AiQuickSettings>({
    providerId: "",
    modelName: "",
  });
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);

  // Bootstrap persisted provider/model
  useEffect(() => {
    if (settings.providerId || !bootstrapUiSettings) return;
    setSettings((s) => ({
      ...s,
      providerId: bootstrapUiSettings.aiAssistantProviderId ?? "",
      modelName: bootstrapUiSettings.aiAssistantModelName ?? "",
    }));
  }, [settings.providerId, bootstrapUiSettings]);

  const handleGenerate = async () => {
    const providerId = settings.providerId || bootstrapUiSettings?.aiAssistantProviderId || "";
    const modelName = settings.modelName || bootstrapUiSettings?.aiAssistantModelName || "";
    if (!entry.content.trim()) return;
    if (!providerId) {
      toast.error("Select an AI provider in the gear settings first.");
      return;
    }
    setLoading(true);
    abortRef.current = new AbortController();
    try {
      const request: AiAssistantRequestBody = {
        mode: "lore_keys",
        instruction: "",
        existingContent: entry.content,
        providerProfileId: providerId,
        model: modelName || undefined,
        enabledLayers: [],
        existingKeys: entry.keys,
        existingSecondaryKeys: entry.secondaryKeys,
        logic: entry.logic,
      };
      let raw = "";
      for await (const chunk of streamAiAssistant(request, { signal: abortRef.current.signal })) {
        if (chunk.type === "text" && chunk.text) raw += chunk.text;
        if (chunk.type === "error" && chunk.error) throw new Error(chunk.error);
        if (chunk.type === "done") break;
      }
      // Parse JSON response
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(cleaned) as { keys?: string[]; secondaryKeys?: string[] };
      if (settings.appendMode) {
        const newKeys = (parsed.keys ?? []).filter((k) => !entry.keys.includes(k));
        const newSec = (parsed.secondaryKeys ?? []).filter((k) => !entry.secondaryKeys.includes(k));
        if (newKeys.length) updateAct("keys", [...entry.keys, ...newKeys]);
        if (newSec.length) updateAct("secondaryKeys", [...entry.secondaryKeys, ...newSec]);
      } else {
        if (parsed.keys?.length) updateAct("keys", parsed.keys);
        if (parsed.secondaryKeys?.length) updateAct("secondaryKeys", parsed.secondaryKeys);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error(err instanceof Error ? err.message : "Key generation failed");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const handleSettingsChange = (s: AiQuickSettings) => {
    setSettings(s);
    void updateUiSettings({
      aiAssistantProviderId: s.providerId || null,
      aiAssistantModelName: s.modelName || null,
    }).catch(() => {});
  };

  return (
    <AiQuickPill
      onGenerate={() => void handleGenerate()}
      onCancel={() => { abortRef.current?.abort(); }}
      onSettingsChange={handleSettingsChange}
      settings={settings}
      loading={loading}
      disabled={!entry.content.trim()}
      showAppendToggle
      starTooltip={t("ai_pill_generate_keys")}
      gearTooltip={t("ai_pill_generate_keys_settings")}
      size="md"
    />
  );
}
