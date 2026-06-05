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
import { useCallback, useEffect, useRef, useState } from "react";

import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { fetchProviderModelsAction } from "../../../stores/api-actions/provider-actions.js";
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
import { TokenCounter } from "../../shared/TokenCounter.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import {
  testLoreActivation,
  deleteLoreEntry,
  listAllLorebooks,
  countAiAssistantTokens,
  streamAiAssistant,
  updateUiSettings,
  type AiAssistantRequestBody,
  type LoreEntryRecord,
  type LorebookRecord,
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
  const [aiProviderId, setAiProviderId] = useState("");
  const [aiModelName, setAiModelName] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiIncludeCharacter, setAiIncludeCharacter] = useState(true);
  const [aiIncludePersona, setAiIncludePersona] = useState(true);
  const [aiLorebookIds, setAiLorebookIds] = useState<string[]>([]);
  const [aiLorebooks, setAiLorebooks] = useState<LorebookRecord[]>([]);
  const [aiStreaming, setAiStreaming] = useState(false);
  const [aiStreamedContent, setAiStreamedContent] = useState("");
  const [aiStreamedReasoning, setAiStreamedReasoning] = useState("");
  const [aiPromptTokenCount, setAiPromptTokenCount] = useState<number | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);
  const activeCharacter = useActiveCharacter();
  const activePersona = useActivePersona();
  const selectedProfile = providerProfiles.find((p) => p.id === aiProviderId);
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label?: string }>>([]);

  const characterContextTarget: LinkTarget | null = activeCharacter ? {
    id: activeCharacter.id,
    name: activeCharacter.name,
    avatarAssetId: activeCharacter.avatarAssetId ?? null,
  } : null;
  const personaContextTarget: LinkTarget | null = activePersona ? {
    id: activePersona.id,
    name: activePersona.name,
    avatarAssetId: activePersona.avatarAssetId ?? null,
  } : null;
  const lorebookContextTargets: LinkTarget[] = aiLorebooks
    .filter((lb) => lb.enabled)
    .map((lb) => ({ id: lb.id, name: lb.name, avatarAssetId: null }));
  const availableLorebookIds = new Set(lorebookContextTargets.map((lb) => lb.id));
  const selectedLorebookIds = aiLorebookIds.filter((id) => availableLorebookIds.has(id));
  const aiContextLinks: LinkBindingRecord[] = [
    ...(aiIncludeCharacter && activeCharacter ? [{ targetType: "character" as const, targetId: activeCharacter.id }] : []),
    ...(aiIncludePersona && activePersona ? [{ targetType: "persona" as const, targetId: activePersona.id }] : []),
    ...selectedLorebookIds.map((id) => ({ targetType: "lorebook" as const, targetId: id })),
  ];

  useEffect(() => {
    if (!bootstrapUiSettings || aiProviderId) return;
    if (bootstrapUiSettings.aiAssistantProviderId) setAiProviderId(bootstrapUiSettings.aiAssistantProviderId);
    if (bootstrapUiSettings.aiAssistantModelName) setAiModelName(bootstrapUiSettings.aiAssistantModelName);
  }, [aiProviderId, bootstrapUiSettings]);

  useEffect(() => {
    if (!activeCharacter) setAiIncludeCharacter(false);
  }, [activeCharacter]);

  useEffect(() => {
    if (!activePersona) setAiIncludePersona(false);
  }, [activePersona]);

  useEffect(() => {
    if (!aiProviderId) { setProviderModels([]); return; }
    let cancelled = false;
    void fetchProviderModelsAction(aiProviderId).then((response) => {
      if (!cancelled) {
        const models = (response && "models" in response ? response.models : []) as Array<{ id: string; label?: string }>;
        setProviderModels(models);
      }
    });
    return () => { cancelled = true; };
  }, [aiProviderId]);

  useEffect(() => {
    if (!aiHelperOpen) return;
    let cancelled = false;
    void listAllLorebooks().then((rows) => {
      if (!cancelled) setAiLorebooks(rows);
    });
    return () => { cancelled = true; };
  }, [aiHelperOpen]);

  const persistAiModelSelection = (providerId: string, modelName: string | null) => {
    void updateUiSettings({ aiAssistantProviderId: providerId || null, aiAssistantModelName: modelName || null }).catch(() => {});
  };

  const handleAiProviderChange = (id: string) => {
    setAiProviderId(id);
    setAiModelName("");
    persistAiModelSelection(id, null);
  };

  const handleAiModelChange = (id: string) => {
    setAiModelName(id);
    persistAiModelSelection(aiProviderId, id || null);
  };

  const buildLoreEntryAiRequest = useCallback((): AiAssistantRequestBody | null => {
    if (!aiProviderId) return null;
    const lorebookIds = selectedLorebookIds;
    return {
      mode: "lore_entry",
      instruction: aiPrompt,
      existingContent: entry.content || undefined,
      providerProfileId: aiProviderId,
      model: aiModelName || undefined,
      enabledLayers: [
        ...(aiIncludeCharacter && activeCharacter ? ["character_base"] : []),
        ...(aiIncludePersona && activePersona ? ["persona"] : []),
        ...(lorebookIds.length > 0 ? ["lore"] : []),
      ],
      characterIds: aiIncludeCharacter && activeCharacter ? [activeCharacter.id] : [],
      personaIds: aiIncludePersona && activePersona ? [activePersona.id] : [],
      lorebookIds,
    };
  }, [activeCharacter, activePersona, aiIncludeCharacter, aiIncludePersona, aiModelName, aiPrompt, aiProviderId, entry.content, selectedLorebookIds.join("\u0000")]);

  useEffect(() => {
    if (!aiHelperOpen) return;
    const request = buildLoreEntryAiRequest();
    if (!request) {
      setAiPromptTokenCount(null);
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => {
      countAiAssistantTokens(request, { signal: ac.signal })
        .then((result) => setAiPromptTokenCount(result.tokens))
        .catch((err: unknown) => {
          if (!(err instanceof Error && err.name === "AbortError")) setAiPromptTokenCount(null);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [aiHelperOpen, buildLoreEntryAiRequest]);

  const handleAiGenerate = async () => {
    const request = buildLoreEntryAiRequest();
    if (!request || !aiPrompt.trim()) return;
    persistAiModelSelection(aiProviderId, aiModelName || null);
    setAiStreaming(true);
    setAiError(null);
    setAiStreamedContent("");
    setAiStreamedReasoning("");
    const ac = new AbortController();
    aiAbortRef.current = ac;
    try {
      for await (const chunk of streamAiAssistant(request, { signal: ac.signal })) {
        if (chunk.type === "reasoning" && chunk.text) setAiStreamedReasoning((prev) => prev + chunk.text);
        if (chunk.type === "text" && chunk.text) setAiStreamedContent((prev) => prev + chunk.text);
        if (chunk.type === "error" && chunk.error) { setAiError(chunk.error); setAiStreaming(false); return; }
        if (chunk.type === "done") { setAiStreaming(false); return; }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") setAiError(String(err));
      setAiStreaming(false);
    }
  };

  const resetAiHelper = () => {
    setAiHelperOpen(false);
    setAiStreamedContent("");
    setAiStreamedReasoning("");
    setAiPrompt("");
  };
  const handleAiStop = () => { aiAbortRef.current?.abort(); setAiStreaming(false); };
  const handleAiInsert = () => {
    const generated = aiStreamedContent.trim();
    if (!generated) return;
    updateAct("content", entry.content ? `${entry.content.trimEnd()}\n\n${generated}` : generated);
    resetAiHelper();
  };
  const handleAiReplace = () => {
    const generated = aiStreamedContent.trim();
    if (!generated) return;
    updateAct("content", generated);
    resetAiHelper();
  };

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
          <div
            className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2 px-2.5 py-1.5"
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
            <textarea
              className="w-full min-h-[180px] rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[13px] text-t1 outline-none focus:border-accent leading-[1.6]"
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
                      <input
                        className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                        type="number"
                        min="0"
                        value={entry.depth}
                        onChange={(e) =>
                          updateAct("depth", parseInt(e.target.value))
                        }
                      />
                    </div>
                  </CustomTooltip>
                )}
                <CustomTooltip content={t("lore_priority_hint")} side="top" align="start">
                  <div>
                    <label className="mb-1.5 block cursor-help text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_priority_label")}
                    </label>
                    <input
                      className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                      type="number"
                      min="0"
                      value={entry.priority}
                      onChange={(e) =>
                        updateAct("priority", parseInt(e.target.value))
                      }
                    />
                  </div>
                </CustomTooltip>
                <div>
                  <CustomTooltip content={t("probability_hint")}>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_probability")}
                    </label>
                  </CustomTooltip>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="number"
                    min="0"
                    max="100"
                    value={entry.probability}
                    onChange={(e) =>
                      updateAct("probability", parseInt(e.target.value))
                    }
                  />
                </div>
                <div>
                  <CustomTooltip content={t("scan_depth_override_hint")}>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_scan_depth_override")}
                    </label>
                  </CustomTooltip>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="number"
                    min="-1"
                    value={entry.scanDepthOverride ?? -1}
                    onChange={(e) =>
                      updateAct("scanDepthOverride", parseInt(e.target.value))
                    }
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
                    <input
                      className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                      type="number"
                      min="0"
                      value={entry.stickyWindow}
                      onChange={(e) =>
                        updateAct("stickyWindow", parseInt(e.target.value))
                      }
                    />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("cooldown_hint")}>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_cooldown_window")}
                    </label>
                    <input
                      className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                      type="number"
                      min="0"
                      value={entry.cooldownWindow}
                      onChange={(e) =>
                        updateAct("cooldownWindow", parseInt(e.target.value))
                      }
                    />
                  </div>
                </CustomTooltip>
                <CustomTooltip content={t("delay_hint")}>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium uppercase leading-tight tracking-[0.05em] text-t3">
                      {t("lore_delay_window")}
                    </label>
                    <input
                      className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                      type="number"
                      min="0"
                      value={entry.delayWindow}
                      onChange={(e) =>
                        updateAct("delayWindow", parseInt(e.target.value))
                      }
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
                    <input
                      className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                      type="number"
                      min="0"
                      value={entry.recursionLevel}
                      onChange={(e) =>
                        updateAct("recursionLevel", parseInt(e.target.value))
                      }
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
                  <input
                    className="h-8 w-full rounded-md border border-border bg-s2 px-2.5 text-[13px] text-t1 outline-none focus:border-accent"
                    type="number"
                    min="0"
                    value={entry.groupWeight}
                    onChange={(e) =>
                      updateAct("groupWeight", parseInt(e.target.value))
                    }
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

      {aiHelperOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
          <div
            className="flex w-[560px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface"
            style={{ maxHeight: "85vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between border-b border-border"
              style={{ padding: "16px 20px" }}
            >
              <span className="text-sm font-semibold text-t1">{t("script_ai_helper")}</span>
              <div
                className={cn(
                  "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1",
                  aiStreaming && "pointer-events-none opacity-30"
                )}
                onClick={() => setAiHelperOpen(false)}
              >
                <Ic.close />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
              {providerProfiles.length === 0 ? (
                <div className="py-6 text-center font-ui text-[13px] text-t3">{t("script_ai_no_providers")}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 16 }}>
                    <div>
                      <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_connection")}</label>
                      <DropdownSelect
                        value={aiProviderId}
                        options={providerProfiles.map((p) => ({ id: p.id, label: p.name }))}
                        placeholder={t("script_ai_select_provider")}
                        searchPlaceholder={t("script_ai_search_provider")}
                        onChange={handleAiProviderChange}
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_model")}</label>
                      <DropdownSelect
                        value={aiModelName}
                        options={providerModels.map((m) => ({ id: m.id, label: m.label || m.id }))}
                        placeholder={selectedProfile?.defaultModel || "Default"}
                        searchPlaceholder={t("script_ai_search_model")}
                        defaultOption={selectedProfile?.defaultModel || "Default"}
                        onChange={handleAiModelChange}
                        disabled={!aiProviderId}
                      />
                    </div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_context")}</label>
                    <LinkBindingPopover
                      links={aiContextLinks}
                      characters={characterContextTarget ? [characterContextTarget] : []}
                      personas={personaContextTarget ? [personaContextTarget] : []}
                      lorebooks={lorebookContextTargets}
                      onSetLinks={(links) => {
                        setAiIncludeCharacter(Boolean(activeCharacter && links.some((l) => l.targetType === "character" && l.targetId === activeCharacter.id)));
                        setAiIncludePersona(Boolean(activePersona && links.some((l) => l.targetType === "persona" && l.targetId === activePersona.id)));
                        setAiLorebookIds(links.filter((l) => l.targetType === "lorebook").map((l) => l.targetId));
                      }}
                      t={t}
                      isMobile={isMobile}
                      tooltipLabel={t("script_ai_context")}
                      emptyLabel={t("script_ai_context_empty")}
                      characterSectionLabel={t("script_ai_context_character")}
                      personaSectionLabel={t("script_ai_context_persona")}
                      lorebookSectionLabel={t("script_ai_context_lorebooks")}
                    />
                    <div className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t("script_ai_context_hint")}</div>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_entry_ai_prompt_label")}</label>
                    <MobileExpandTextarea value={aiPrompt} onChange={setAiPrompt} label={t("script_ai_helper")}>
                      <textarea
                        className="w-full min-h-[100px] rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none"
                        placeholder={t("lore_entry_ai_prompt_placeholder")}
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
                      />
                    </MobileExpandTextarea>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <div className="font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t("lore_entry_ai_prompt_hint")}</div>
                      {aiPromptTokenCount !== null && <TokenCounter text="" count={aiPromptTokenCount} />}
                    </div>
                  </div>
                  {aiStreamedReasoning && (
                    <div className="mb-3">
                      <MessageReasoning reasoning={aiStreamedReasoning} />
                    </div>
                  )}
                  {aiStreamedContent && (
                    <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("lore_entry_ai_generated")}</div>
                      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">
                        {aiStreamedContent}{aiStreaming && <span className="animate-pulse text-accent">▌</span>}
                      </pre>
                    </div>
                  )}
                  {aiError && (
                    <div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10, marginBottom: 12 }}>
                      <div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_ai_error")}</div>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{aiError}</pre>
                    </div>
                  )}
                </>
              )}
            </div>
            {providerProfiles.length > 0 && (
              <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
                {aiStreamedContent && !aiStreaming && (
                  <>
                    <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleAiInsert}>{t("script_ai_insert")}</button>
                    <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleAiReplace}>{t("script_ai_replace")}</button>
                  </>
                )}
                {aiStreaming ? (
                  <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={handleAiStop}>{t("script_ai_stop")}</button>
                ) : (
                  <button
                    type="button"
                    className={cn(
                      "h-9 cursor-pointer rounded-md border-0 px-4 font-ui text-xs font-medium transition-all",
                      aiProviderId && aiPrompt.trim() ? "bg-accent text-on-accent" : "bg-s3 text-t3 cursor-not-allowed"
                    )}
                    onClick={handleAiGenerate}
                    disabled={!aiProviderId || !aiPrompt.trim()}
                  >
                    {t("script_ai_generate")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

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
