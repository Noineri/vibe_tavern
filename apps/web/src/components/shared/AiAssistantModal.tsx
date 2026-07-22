import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useActiveCharacter, useActivePersona, useAllCharacters } from "../../stores/snapshot-store.js";
import { Ic } from "./icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { MobileExpandTextarea } from "./MobileExpandTextarea.js";
import { AutoTextarea } from "./auto-textarea.js";
import { DropdownSelect } from "./DropdownSelect.js";
import { Checkbox } from "./Checkbox.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "./LinkBindingPopover.js";
import { TokenCounter } from "./TokenCounter.js";
import { buildLineDiff, TextDiffPreview } from "./TextDiffPreview.js";
import { NumberInput } from "./NumberInput.js";
import { cn } from "../../lib/cn.js";
import { cleanAiCode } from "../../lib/ai-code-clean.js";
import { describeMdImportValue, getMdImportFieldLabel, MD_IMPORT_FIELD_OPTIONS, mergeMdImportFields, type MdImportResult } from "../../lib/md-import-utils.js";
import { useT } from "../../i18n/context.js";
import { MessageReasoning } from "../chat/MessageReasoning.js";
import { Modal } from "./Modal.js";
import { BottomSheet } from "./BottomSheet.js";
import type { AiQuickSettings } from "./AiQuickPill.js";
import { AiAssistantConnectionFields } from "./ai-assistant/AiAssistantConnectionFields.js";
import { AiAssistantShell } from "./ai-assistant/AiAssistantShell.js";
import { AiGenParamsRow } from "./ai-assistant/AiGenParamsRow.js";
import { useAiAssistantRunner } from "./ai-assistant/use-ai-assistant-runner.js";
import { useDebouncedTokenCount } from "./ai-assistant/use-debounced-token-count.js";
import {
  listAllLorebooks,
  type AiAssistantRequestBody,
  type LorebookRecord,
} from "../../app-client.js";

export interface AiAssistantModalProps {
  mode: "full" | "quickpill";
  isOpen: boolean;
  onClose: () => void;

  // --- Full Mode Props ---
  apiMode?: "script" | "lore_entry" | "md_import" | "scene_schema" | "scene_rules" | "dice_script";
  existingContent?: string;
  onInsert?: (text: string) => void;
  onReplace?: (text: string) => void;
  /** md_import: callback with checked fields once user clicks Apply. */
  onMdImportApply?: (fields: Partial<MdImportResult>) => void;
  /** scene_schema: which format-aware prompt to load (json/xml). */
  promptFormat?: "json" | "xml";
  scopeContext?: {
    characterId?: string;
    personaId?: string | null;
  };

  // --- QuickPill Mode Props ---
  settings?: AiQuickSettings;
  onSettingsChange?: (settings: AiQuickSettings) => void;
  showAppendToggle?: boolean;
  showKeyTarget?: boolean;
  showMessageCount?: boolean;
}

export function AiAssistantModal({
  mode,
  isOpen,
  onClose,
  apiMode,
  existingContent,
  onInsert,
  onReplace,
  onMdImportApply,
  promptFormat,
  scopeContext,
  settings,
  onSettingsChange,
  showAppendToggle,
  showKeyTarget,
  showMessageCount,
}: AiAssistantModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  // --- Global state references ---
  const providerProfiles = useProviderDataStore((s) => s.profiles);
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const activeCharacter = useActiveCharacter();
  const activePersona = useActivePersona();
  const allCharacters = useAllCharacters();

  // --- Local State ---
  // Quickpill specific
  const [appendMode, setAppendMode] = useState(false);
  const [keyTarget, setKeyTarget] = useState<"primary" | "secondary" | "both">("both");
  const [recentMessageCount, setRecentMessageCount] = useState(20);

  // Full specific
  const [prompt, setPrompt] = useState("");
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [includePersona, setIncludePersona] = useState(true);
  const [lorebookIds, setLorebookIds] = useState<string[]>([]);
  const [aiLorebooks, setAiLorebooks] = useState<LorebookRecord[]>([]);

  // md_import state
  const [mdContent, setMdContent] = useState("");
  const [parsedFields, setParsedFields] = useState<Partial<MdImportResult>>({});
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set());
  const [fieldTargets, setFieldTargets] = useState<Record<string, keyof MdImportResult>>({});
  const [mdDragOver, setMdDragOver] = useState(false);
  const mdFileRef = useRef<HTMLInputElement>(null);

  // AI generation params (shared across full modes)
  const [aiMaxTokens, setAiMaxTokens] = useState<number | null>(null);
  const [aiTemperature, setAiTemperature] = useState<number | null>(null);

  // --- Initialization ---
  const seedProviderId = mode === "quickpill" && settings
    ? (settings.providerId || bootstrapUiSettings?.aiAssistantProviderId || "")
    : (bootstrapUiSettings?.aiAssistantProviderId || "");
  const seedModelName = mode === "quickpill" && settings
    ? (settings.modelName || bootstrapUiSettings?.aiAssistantModelName || "")
    : (bootstrapUiSettings?.aiAssistantModelName || "");

  const {
    providerId,
    modelName,
    providerModels,
    selectedProfile,
    streaming,
    streamedOutput,
    streamedReasoning,
    error,
    handleProviderChange,
    handleModelChange,
    runStream,
    stop: handleStop,
    resetStreamState,
  } = useAiAssistantRunner({
    isOpen,
    seedProviderId,
    seedModelName,
    persistSelection: mode === "full",
    onPartialJson: apiMode === "md_import"
      ? (json) => {
          const nextParsed = json as Partial<MdImportResult>;
          setParsedFields(nextParsed);
          setCheckedFields((prev) => {
            const next = new Set(prev);
            for (const [key, value] of Object.entries(nextParsed)) {
              if (value != null && value !== "" && !(Array.isArray(value) && value.length === 0)) {
                next.add(key);
                if (Array.isArray(value) && value.length > 1 && value.every((item): item is string => typeof item === "string")) {
                  value.forEach((_, idx) => next.add(`${key}[${idx}]`));
                }
              }
            }
            return next;
          });
          setFieldTargets((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(nextParsed)) {
              if (!(key in next)) next[key] = key as keyof MdImportResult;
            }
            return next;
          });
        }
      : undefined,
  });


  useEffect(() => {
    if (!isOpen) return;

    if (mode === "quickpill" && settings) {
      setAppendMode(settings.appendMode ?? false);
      setKeyTarget(settings.keyTarget ?? "both");
      setRecentMessageCount(settings.recentMessageCount ?? 20);
    } else if (mode === "full") {
      resetStreamState();
      setPrompt("");
      setMdContent("");
      setParsedFields({});
      setCheckedFields(new Set());
      setFieldTargets({});
    }
  }, [isOpen, mode, settings, bootstrapUiSettings, resetStreamState]);

  // Context setup
  useEffect(() => {
    if (!isOpen || mode !== "full") return;
    let cancelled = false;
    void listAllLorebooks().then((rows) => {
      if (!cancelled) setAiLorebooks(rows);
    });
    return () => { cancelled = true; };
  }, [isOpen, mode]);

  useEffect(() => {
    if (mode === "full" && scopeContext) {
      if (!scopeContext.characterId) setIncludeCharacter(false);
      if (!scopeContext.personaId) setIncludePersona(false);
    }
  }, [mode, scopeContext]);

  const handleQuickpillApply = () => {
    if (onSettingsChange) {
      onSettingsChange({
        providerId,
        modelName,
        appendMode,
        keyTarget,
        recentMessageCount,
      });
    }
    onClose();
  };

  // --- Full Mode Context Link building ---
  const allCharacterContext = allCharacters.find(c => c.id === scopeContext?.characterId);
  const allPersonaContext = personas.find(p => p.id === scopeContext?.personaId);

  const charTarget: LinkTarget | null = scopeContext?.characterId ? {
    id: scopeContext.characterId,
    name: activeCharacter?.id === scopeContext.characterId ? activeCharacter.name : allCharacterContext?.name ?? "Character",
    avatarAssetId: activeCharacter?.id === scopeContext.characterId ? activeCharacter.avatarAssetId ?? null : allCharacterContext?.avatarAssetId ?? null,
    kind: "characters",
    avatarExt: activeCharacter?.id === scopeContext.characterId ? activeCharacter.avatarExt ?? null : allCharacterContext?.avatarExt ?? null,
    avatarFullExt: activeCharacter?.id === scopeContext.characterId ? activeCharacter.avatarFullExt ?? null : allCharacterContext?.avatarFullExt ?? null,
    avatarFullAssetId: activeCharacter?.id === scopeContext.characterId ? activeCharacter.avatarFullAssetId ?? null : allCharacterContext?.avatarFullAssetId ?? null,
    updatedAt: activeCharacter?.id === scopeContext.characterId ? activeCharacter.updatedAt ?? null : allCharacterContext?.updatedAt ?? null,
  } : null;

  const persTarget: LinkTarget | null = scopeContext?.personaId ? {
    id: scopeContext.personaId,
    name: activePersona?.id === scopeContext.personaId ? activePersona.name : allPersonaContext?.name ?? "Persona",
    avatarAssetId: activePersona?.id === scopeContext.personaId ? activePersona.avatarAssetId ?? null : allPersonaContext?.avatarAssetId ?? null,
    kind: "personas",
    avatarExt: activePersona?.id === scopeContext.personaId ? activePersona.avatarExt ?? null : allPersonaContext?.avatarExt ?? null,
    avatarFullExt: activePersona?.id === scopeContext.personaId ? activePersona.avatarFullExt ?? null : allPersonaContext?.avatarFullExt ?? null,
    updatedAt: activePersona?.id === scopeContext.personaId ? activePersona.updatedAt ?? null : allPersonaContext?.updatedAt ?? null,
  } : null;

  const lorebookContextTargets: LinkTarget[] = aiLorebooks
    .filter((lb) => lb.enabled)
    .map((lb) => ({ id: lb.id, name: lb.name, avatarAssetId: null }));
  const availableLorebookIds = new Set(lorebookContextTargets.map((lb) => lb.id));
  const selectedLorebookIds = lorebookIds.filter((id) => availableLorebookIds.has(id));

  const contextLinks: LinkBindingRecord[] = [
    ...(includeCharacter && scopeContext?.characterId ? [{ targetType: "character" as const, targetId: scopeContext.characterId }] : []),
    ...(includePersona && scopeContext?.personaId ? [{ targetType: "persona" as const, targetId: scopeContext.personaId }] : []),
    ...selectedLorebookIds.map((id) => ({ targetType: "lorebook" as const, targetId: id })),
  ];

  // --- Full Mode Request Building ---
  const buildAiRequest = useCallback((): AiAssistantRequestBody | null => {
    if (!providerId || !apiMode) return null;
    if (apiMode === "md_import") {
      return {
        mode: "md_import",
        instruction: "",
        existingContent: mdContent || undefined,
        providerProfileId: providerId,
        model: modelName || undefined,
        enabledLayers: [],
        maxOutputTokens: aiMaxTokens ?? undefined,
        temperature: aiTemperature ?? 0,
      };
    }
    return {
      mode: apiMode,
      instruction: prompt,
      existingContent: existingContent || undefined,
      providerProfileId: providerId,
      model: modelName || undefined,
      enabledLayers: [
        ...(includeCharacter && scopeContext?.characterId ? ["character_base"] : []),
        ...(includePersona && scopeContext?.personaId ? ["persona"] : []),
        ...(selectedLorebookIds.length > 0 ? ["lore"] : []),
      ],
      characterIds: includeCharacter && scopeContext?.characterId ? [scopeContext.characterId] : [],
      personaIds: includePersona && scopeContext?.personaId ? [scopeContext.personaId] : [],
      lorebookIds: selectedLorebookIds,
      maxOutputTokens: aiMaxTokens ?? undefined,
      temperature: aiTemperature ?? undefined,
      promptFormat: apiMode === "scene_schema" ? promptFormat : undefined,
    };
  }, [apiMode, existingContent, includeCharacter, includePersona, modelName, prompt, providerId, scopeContext?.characterId, scopeContext?.personaId, selectedLorebookIds.join("\u0000"), promptFormat]);

  // --- Token Count Calculation (debounced over the live request body) ---
  const tokenCount = useDebouncedTokenCount(isOpen && mode === "full" ? buildAiRequest() : null);
  const promptTokenCount = tokenCount?.tokens ?? null;

  // --- Generation ---
  const handleGenerate = async () => {
    if (apiMode === "md_import") {
      if (!providerId || !mdContent.trim()) return;
      setParsedFields({});
      setCheckedFields(new Set());
      setFieldTargets({});

      const request: AiAssistantRequestBody = {
        mode: "md_import",
        instruction: "",
        existingContent: mdContent,
        providerProfileId: providerId,
        model: modelName || undefined,
        enabledLayers: [],
        maxOutputTokens: aiMaxTokens ?? undefined,
        temperature: aiTemperature ?? 0,
      };
      await runStream(request);
      return;
    }

    const request = buildAiRequest();
    if (!request || !prompt.trim()) return;
    await runStream(request);
  };

  const cleanedOutput = useMemo(() => {
    if (apiMode === "script" || apiMode === "dice_script") return cleanAiCode(streamedOutput);
    return streamedOutput.trim();
  }, [apiMode, streamedOutput]);

  const isAiEditMode = Boolean(existingContent && existingContent.trim());
  const aiDiffSummary = useMemo(
    () => (!streaming && streamedOutput && isAiEditMode ? buildLineDiff(existingContent ?? "", cleanedOutput) : null),
    [existingContent, streaming, streamedOutput, isAiEditMode, cleanedOutput],
  );

  const resetAndClose = () => {
    resetStreamState();
    setPrompt("");
    setMdContent("");
    setParsedFields({});
    setCheckedFields(new Set());
    setFieldTargets({});
    onClose();
  };

  const handleActionInsert = () => {
    if (!cleanedOutput || !onInsert) return;
    onInsert(existingContent ? `${existingContent.trimEnd()}\n\n${cleanedOutput}` : cleanedOutput);
    resetAndClose();
  };
  const handleActionReplace = () => {
    if (!cleanedOutput || !onReplace) return;
    onReplace(cleanedOutput);
    resetAndClose();
  };

  const handleMdImportApply = () => {
    if (!onMdImportApply) return;
    let result: Partial<MdImportResult> = {};
    // Collect individual array items that were checked
    const collectedArrays: Partial<Record<string, string[]>> = {};
    for (const key of checkedFields) {
      const arrayMatch = key.match(/^(.+?)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, parentKey, idxStr] = arrayMatch;
        const parentValue = parsedFields[parentKey as keyof MdImportResult];
        if (Array.isArray(parentValue) && typeof parentValue[Number(idxStr)] === "string") {
          if (!collectedArrays[parentKey]) collectedArrays[parentKey] = [];
          collectedArrays[parentKey]!.push(parentValue[Number(idxStr)] as string);
        }
        continue;
      }
      const sourceKey = key as keyof MdImportResult;
      const targetKey = fieldTargets[key] ?? sourceKey;
      const value = parsedFields[sourceKey];
      if (value != null) {
        result = mergeMdImportFields(result, targetKey, value);
      }
    }
    // Merge collected array items
    for (const [parentKey, items] of Object.entries(collectedArrays)) {
      const targetKey = (fieldTargets[`${parentKey}[0]`] ?? parentKey) as keyof MdImportResult;
      result = mergeMdImportFields(result, targetKey, items);
    }
    onMdImportApply(result);
    resetAndClose();
  };

  if (!isOpen) return null;

  // i18n dynamic keys
  const isSceneSchema = apiMode === "scene_schema";
  const isSceneRules = apiMode === "scene_rules";
  const promptLabelKey = apiMode === "lore_entry" ? "lore_entry_ai_prompt_label" : isSceneSchema ? "scn_ai_prompt_label" : isSceneRules ? "scn_ai_rules_prompt_label" : "script_ai_prompt";
  const promptPlaceholderKey = apiMode === "lore_entry" ? "lore_entry_ai_prompt_placeholder" : isSceneSchema ? "scn_ai_prompt_placeholder" : isSceneRules ? "scn_ai_rules_prompt_placeholder" : "script_ai_prompt";
  const promptHintKey = apiMode === "lore_entry" ? "lore_entry_ai_prompt_hint" : isSceneSchema ? "scn_ai_prompt_hint" : isSceneRules ? "scn_ai_rules_prompt_hint" : "script_ai_prompt_hint";
  const generatedKey = apiMode === "lore_entry" ? "lore_entry_ai_generated" : isSceneSchema ? "scn_ai_generated" : isSceneRules ? "scn_ai_rules_generated" : "script_ai_generated";
  const changesKey = apiMode === "lore_entry" ? "lore_entry_ai_changes" : "script_ai_changes";
  const noChangesKey = apiMode === "lore_entry" ? "lore_entry_ai_no_changes" : "script_ai_no_changes";

  // Render variables
  const isFull = mode === "full";
  const isMdImport = apiMode === "md_import";
  const title = isMdImport ? t("import_md_title") : isSceneRules ? t("scn_ai_rules_title") : isSceneSchema ? t("scn_ai_title") : isFull ? t("script_ai_helper") : t("ai_quickpill_settings");
  const contentWidth = isMdImport ? "w-[620px]" : isFull ? "w-[560px]" : "w-[380px]";

  const footerButtons = !isFull ? (
    <button type="button" className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 text-[12px] font-medium text-on-accent transition-all hover:opacity-90" onClick={handleQuickpillApply}>
      {t("done_btn")}
    </button>
  ) : isMdImport ? (
    <>
      {Object.keys(parsedFields).length > 0 && !streaming && (
        <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleMdImportApply} disabled={checkedFields.size === 0}>{t("import_md_apply")}</button>
      )}
      {streaming ? (
        <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-on-danger transition-all" onClick={handleStop}>{t("script_ai_stop")}</button>
      ) : (
        <button type="button" className={cn("h-9 cursor-pointer rounded-md border-0 px-4 font-ui text-xs font-medium transition-all", providerId && mdContent.trim() ? "bg-s3 text-t2 hover:bg-border2 hover:text-t1" : "bg-s3 text-t3 cursor-not-allowed")} onClick={handleGenerate} disabled={!providerId || !mdContent.trim()}>{Object.keys(parsedFields).length > 0 ? t("import_md_reparse") : t("import_md_start")}</button>
      )}
    </>
  ) : (
    <>
      {streamedOutput && !streaming && (
        existingContent ? (
          <>
            <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleActionInsert}>{t("script_ai_insert")}</button>
            <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleActionReplace}>{t("script_ai_apply")}</button>
          </>
        ) : (
          <>
            <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleActionInsert}>{t("script_ai_insert")}</button>
            <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={handleActionReplace}>{t("script_ai_replace")}</button>
          </>
        )
      )}
      {streaming ? (
        <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-on-danger transition-all" onClick={handleStop}>{t("script_ai_stop")}</button>
      ) : (
        <button type="button" className={cn("h-9 cursor-pointer rounded-md border-0 px-4 font-ui text-xs font-medium transition-all", providerId && prompt.trim() ? "bg-accent text-on-accent" : "bg-s3 text-t3 cursor-not-allowed")} onClick={handleGenerate} disabled={!providerId || !prompt.trim()}>{t("script_ai_generate")}</button>
      )}
    </>
  );

  const contentBody = (
    <AiAssistantShell
      title={<span className="text-sm font-semibold text-t1">{title}</span>}
      onClose={onClose}
      streaming={streaming}
      providerCount={providerProfiles.length}
      noProvidersLabel={t("script_ai_no_providers")}
      footer={providerProfiles.length > 0 ? footerButtons : undefined}
    >
      <>
              <AiAssistantConnectionFields
                providerProfiles={providerProfiles}
                providerId={providerId}
                modelName={modelName}
                providerModels={providerModels}
                selectedProfileDefaultModel={selectedProfile?.defaultModel ?? null}
                onProviderChange={handleProviderChange}
                onModelChange={handleModelChange}
                labels={{
                  connection: t("script_ai_connection"),
                  model: t("script_ai_model"),
                  selectProvider: t("script_ai_select_provider"),
                  searchProvider: t("script_ai_search_provider"),
                  searchModel: t("script_ai_search_model"),
                }}
              />

              {/* QUICKPILL SPECIFIC */}
              {!isFull && showKeyTarget && (
                <div className="mb-3">
                  <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ai_quickpill_key_target")}</label>
                  <DropdownSelect
                    value={keyTarget}
                    searchable={false}
                    options={[
                      { id: "both", label: t("ai_quickpill_key_target_both") },
                      { id: "primary", label: t("ai_quickpill_key_target_primary") },
                      { id: "secondary", label: t("ai_quickpill_key_target_secondary") },
                    ]}
                    onChange={(v) => setKeyTarget(v as "primary" | "secondary" | "both")}
                  />
                </div>
              )}
              {!isFull && showAppendToggle && (
                <div className="flex items-center gap-2 mb-3">
                  <button type="button" className={cn("flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-all", !appendMode ? "border-accent bg-accent-dim text-accent-t" : "border-border bg-s3 text-t2 hover:border-t3")} onClick={() => setAppendMode(false)}>{t("script_ai_replace")}</button>
                  <button type="button" className={cn("flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-all", appendMode ? "border-accent bg-accent-dim text-accent-t" : "border-border bg-s3 text-t2 hover:border-t3")} onClick={() => setAppendMode(true)}>{t("ai_quickpill_append")}</button>
                </div>
              )}
              {!isFull && showMessageCount && (
                <div className="mb-3">
                  <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ai_quickpill_recent_messages")}</label>
                  <NumberInput min={1} max={100} value={recentMessageCount} onChange={setRecentMessageCount} className="w-full" />
                </div>
              )}

              {/* Generation params — shared for all full modes (advanced-settings accordion) */}
              {isFull && (
                <AiGenParamsRow
                  temperature={aiTemperature ?? (isMdImport ? 0 : 0.3)}
                  onTemperatureChange={setAiTemperature}
                  maxTokens={aiMaxTokens ?? (isMdImport ? 6000 : 4096)}
                  onMaxTokensChange={setAiMaxTokens}
                />
              )}

              {/* MD IMPORT SPECIFIC */}
              {isFull && isMdImport && (
                <>
                  {/* Dropzone */}
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("import_md_source")}</label>
                    <div
                      className={cn(
                        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 transition-colors",
                        mdDragOver ? "border-accent bg-accent-dim/40" : "border-border bg-s2 hover:border-accent hover:bg-accent-dim/30",
                      )}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setMdDragOver(true); }}
                      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setMdDragOver(false); }}
                      onDrop={(e) => {
                        e.preventDefault(); e.stopPropagation(); setMdDragOver(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) void file.text().then(setMdContent);
                      }}
                      onClick={() => mdFileRef.current?.click()}
                    >
                      <input ref={mdFileRef} type="file" accept=".md,.txt,.markdown" className="hidden" onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void file.text().then(setMdContent);
                      }} />
                      <Ic.import />
                      <span className="font-ui text-[12px] text-t3">{t("import_md_dropzone")}</span>
                    </div>
                  </div>

                  {/* Paste area */}
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("import_md_paste_label")}</label>
                    <MobileExpandTextarea value={mdContent} onChange={setMdContent} label={t("import_md_paste_label")}>
                      <AutoTextarea
                        className="w-full rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-mono text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none"
                        maxRows={15}
                        minRows={6}
                        placeholder={t("import_md_paste_placeholder")}
                        value={mdContent}
                        onChange={(e) => setMdContent(e.target.value)}
                      />
                    </MobileExpandTextarea>
                  </div>

                  {/* Reasoning / raw JSON output */}
                  {streamedReasoning && (
                    <div style={{ marginBottom: 16 }}>
                      <MessageReasoning reasoning={streamedReasoning} />
                    </div>
                  )}

                  {/* No parsed fields yet but still streaming */}
                  {streaming && Object.keys(parsedFields).length === 0 && !streamedReasoning && (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-s2 px-3 py-3" style={{ marginBottom: 16 }}>
                      <span className="animate-spin text-accent">⟳</span>
                      <span className="font-ui text-[12px] text-t3">{t("import_md_parsing")}</span>
                    </div>
                  )}

                  {/* Raw model output debug */}
                  {streamedOutput && (
                    <details className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 16 }} open={Object.keys(parsedFields).length === 0}>
                      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("raw_model_output")}</summary>
                      <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-[1.45] text-t2">{streamedOutput}{streaming && <span className="animate-pulse text-accent">▌</span>}</pre>
                    </details>
                  )}

                  {/* Parsed fields preview */}
                  {Object.keys(parsedFields).length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t("import_md_parsed")}{streaming && <span className="ml-2 animate-pulse text-accent">●</span>}</div>
                      <div className="flex flex-col gap-2">
                        {(Object.entries(parsedFields) as [string, unknown][]).flatMap(([key, value]) => {
                          if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return [];
                          const sourceKey = key as keyof MdImportResult;
                          // Split array fields into individual items
                          if (Array.isArray(value) && value.every((item): item is string => typeof item === "string") && value.length > 1) {
                            const fieldLabel = getMdImportFieldLabel(sourceKey);
                            return value.map((item, idx) => {
                              const itemKey = `${key}[${idx}]`;
                              const targetKey = fieldTargets[itemKey] ?? sourceKey;
                              return (
                                <div key={itemKey} className="flex flex-col gap-2 rounded-md border border-border bg-bg px-3 py-2">
                                  <div className="flex items-start gap-2">
                                    <Checkbox
                                      checked={checkedFields.has(itemKey)}
                                      onChange={(checked) => {
                                        setCheckedFields(prev => { const n = new Set(prev); checked ? n.add(itemKey) : n.delete(itemKey); return n; });
                                      }}
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[11px] uppercase text-t3">{fieldLabel} #{idx + 1}</div>
                                      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border2 px-2 py-1.5 font-mono text-[12px] leading-[1.4] text-t1">
                                        {item}
                                      </div>
                                    </div>
                                    <div className="w-[168px] shrink-0">
                                      <DropdownSelect
                                        value={String(targetKey)}
                                        options={MD_IMPORT_FIELD_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
                                        onChange={(nextValue) => {
                                          setFieldTargets(prev => ({ ...prev, [itemKey]: nextValue as keyof MdImportResult }));
                                        }}
                                        searchable={false}
                                        placeholder={t("map_to_placeholder")}
                                        className="h-8 px-3 py-0 text-[12px]"
                                      />
                                    </div>
                                  </div>
                                </div>
                              );
                            });
                          }
                          // Single item or non-array field
                          const targetKey = fieldTargets[key] ?? sourceKey;
                          const preview = typeof value === "string" ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : describeMdImportValue(value);
                          return [(
                            <div key={key} className="flex flex-col gap-2 rounded-md border border-border bg-bg px-3 py-2">
                              <div className="flex items-start gap-2">
                                <Checkbox
                                  checked={checkedFields.has(key)}
                                  onChange={(checked) => {
                                    setCheckedFields(prev => { const n = new Set(prev); checked ? n.add(key) : n.delete(key); return n; });
                                  }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="text-[11px] uppercase text-t3">{getMdImportFieldLabel(sourceKey)}</div>
                                  <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border2 px-2 py-1.5 font-mono text-[12px] leading-[1.4] text-t1">
                                    {preview}
                                  </div>
                                </div>
                                <div className="w-[168px] shrink-0">
                                  <DropdownSelect
                                    value={String(targetKey)}
                                    options={MD_IMPORT_FIELD_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
                                    onChange={(nextValue) => {
                                      setFieldTargets(prev => ({ ...prev, [key]: nextValue as keyof MdImportResult }));
                                    }}
                                    searchable={false}
                                    placeholder={t("map_to_placeholder")}
                                    className="h-8 px-3 py-0 text-[12px]"
                                  />
                                </div>
                              </div>
                            </div>
                          )];
                        })}
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10, marginBottom: 12 }}>
                      <div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_ai_error")}</div>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{error}</pre>
                    </div>
                  )}
                </>
              )}

              {/* FULL SPECIFIC */}
              {isFull && !isMdImport && (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_context")}</label>
                    <LinkBindingPopover
                      links={contextLinks}
                      characters={charTarget ? [charTarget] : []}
                      personas={persTarget ? [persTarget] : []}
                      lorebooks={lorebookContextTargets}
                      onSetLinks={(links) => {
                        setIncludeCharacter(links.some((l) => l.targetType === "character" && l.targetId === scopeContext?.characterId));
                        setIncludePersona(Boolean(scopeContext?.personaId && links.some((l) => l.targetType === "persona" && l.targetId === scopeContext?.personaId)));
                        setLorebookIds(links.filter((l) => l.targetType === "lorebook").map((l) => l.targetId));
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
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t(promptLabelKey)}</label>
                    <MobileExpandTextarea value={prompt} onChange={setPrompt} label={t("script_ai_helper")}>
                      <AutoTextarea className="w-full rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none" maxRows={15} minRows={5} placeholder={t(promptPlaceholderKey)} value={prompt} onChange={e => setPrompt(e.target.value)} />
                    </MobileExpandTextarea>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <div className="font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t(promptHintKey)}</div>
                      {promptTokenCount !== null && <TokenCounter text="" count={promptTokenCount} />}
                    </div>
                  </div>

                  {streamedReasoning && (
                    <div className="mb-3">
                      <MessageReasoning reasoning={streamedReasoning} />
                    </div>
                  )}

                  {streamedOutput && (aiDiffSummary ? (
                    <>
                      <TextDiffPreview
                        summary={aiDiffSummary}
                        labels={{
                          title: t(changesKey),
                          tooLarge: t("script_ai_diff_too_large"),
                          noChanges: t(noChangesKey),
                        }}
                      />
                      {aiDiffSummary.tooLarge && (
                        <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t(generatedKey)}</div>
                          <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">{cleanedOutput}</pre>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="rounded-md border border-border bg-bg" style={{ padding: 12, marginBottom: 12 }}>
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{t(generatedKey)}</div>
                      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-t1">{streamedOutput}{streaming && <span className="animate-pulse text-accent">▌</span>}</pre>
                    </div>
                  ))}

                  {error && (
                    <div className="rounded-md border border-danger bg-danger-dim" style={{ padding: 10, marginBottom: 12 }}>
                      <div className="text-[11px] font-semibold uppercase text-danger-text">{t("script_ai_error")}</div>
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{error}</pre>
                    </div>
                  )}
                </>
              )}
      </>
    </AiAssistantShell>
  );

  if (isMobile && !isFull) {
    return (
      <BottomSheet open={isOpen} onClose={onClose} title={title}>
        <div className="flex max-h-[85vh] flex-col overflow-hidden">
          {contentBody}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Modal open={isOpen} onClose={onClose} title={title} compact={!isFull}>
      <div className={cn("flex flex-col bg-surface overflow-hidden border border-border", isMobile && isFull ? "w-full h-full rounded-none" : cn("rounded-xl max-w-[90vw]", contentWidth, isFull && "max-h-[85vh]"))} onClick={(e) => e.stopPropagation()}>
        {contentBody}
      </div>
    </Modal>
  );
}
