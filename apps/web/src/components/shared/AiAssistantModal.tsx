import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { fetchProviderModelsAction } from "../../stores/api-actions/provider-actions.js";
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
import { useT } from "../../i18n/context.js";
import { MessageReasoning } from "../chat/MessageReasoning.js";
import { Modal } from "./Modal.js";
import type { AiQuickSettings } from "./AiQuickPill.js";
import {
  listAllLorebooks,
  countAiAssistantTokens,
  streamAiAssistant,
  updateUiSettings,
  type AiAssistantRequestBody,
  type LorebookRecord,
} from "../../app-client.js";

/** Strip markdown code fences that AI models sometimes wrap their output in */
function cleanAiCode(raw: string): string {
  let code = raw.trim();
  // Remove opening fence: ```js, ```javascript, ```
  code = code.replace(/^```(?:js|javascript)?\s*\n?/i, '');
  // Remove closing fence
  code = code.replace(/\n?```\s*$/,'');
  return code.trim();
}

export interface MdImportResult {
  name?: string;
  tagline?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
  exampleMessages?: string[];
  creatorNotes?: string;
}

const MD_IMPORT_FIELD_OPTIONS: Array<{ id: keyof MdImportResult; label: string }> = [
  { id: "name", label: "Name" },
  { id: "tagline", label: "Tagline" },
  { id: "description", label: "Description" },
  { id: "personality", label: "Personality" },
  { id: "scenario", label: "Scenario" },
  { id: "firstMessage", label: "First Message" },
  { id: "alternateGreetings", label: "Alternate Greetings" },
  { id: "exampleMessages", label: "Example Messages" },
  { id: "creatorNotes", label: "Creator Notes" },
];

function getMdImportFieldLabel(field: keyof MdImportResult): string {
  return MD_IMPORT_FIELD_OPTIONS.find((option) => option.id === field)?.label ?? field;
}

function describeMdImportValue(value: unknown, _key?: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.every((item) => typeof item === "string")) {
      const items = value as string[];
      if (items.length === 1) return items[0];
      return items.map((item, i) => `── #${i + 1} ──\n${item}`).join("\n\n");
    }
    return JSON.stringify(value, null, 2);
  }
  return typeof value === "string" ? value : String(value ?? "");
}

function mergeMdImportFields(
  target: Partial<MdImportResult>,
  key: keyof MdImportResult,
  value: unknown,
): Partial<MdImportResult> {
  if (value == null || value === "") return target;
  if (key === "exampleMessages" && Array.isArray(value)) {
    const incoming = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (incoming.length === 0) return target;
    const existing = Array.isArray(target.exampleMessages) ? target.exampleMessages : [];
    return { ...target, exampleMessages: [...existing, ...incoming] };
  }
  if (key === "alternateGreetings" && Array.isArray(value)) {
    const incoming = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (incoming.length === 0) return target;
    const existing = Array.isArray(target.alternateGreetings) ? target.alternateGreetings : [];
    return { ...target, alternateGreetings: [...existing, ...incoming] };
  }
  if (typeof value === "string" && typeof target[key] === "string" && target[key]) {
    return { ...target, [key]: `${target[key]}

${value}` };
  }
  if (Array.isArray(value)) {
    const text = describeMdImportValue(value).trim();
    if (!text) return target;
    if (typeof target[key] === "string" && target[key]) {
      return { ...target, [key]: `${target[key]}

${text}` };
    }
    return { ...target, [key]: text as never };
  }
  return { ...target, [key]: value as never };
}

export interface AiAssistantModalProps {
  mode: "full" | "quickpill";
  isOpen: boolean;
  onClose: () => void;

  // --- Full Mode Props ---
  apiMode?: "script" | "lore_entry" | "md_import";
  existingContent?: string;
  onInsert?: (text: string) => void;
  onReplace?: (text: string) => void;
  /** md_import: callback with checked fields once user clicks Apply. */
  onMdImportApply?: (fields: Partial<MdImportResult>) => void;
  scopeContext?: {
    characterId?: string;
    personaId?: string | null;
  };

  // --- QuickPill Mode Props ---
  settings?: AiQuickSettings;
  onSettingsChange?: (settings: AiQuickSettings) => void;
  showAppendToggle?: boolean;
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
  scopeContext,
  settings,
  onSettingsChange,
  showAppendToggle,
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
  const [providerId, setProviderId] = useState("");
  const [modelName, setModelName] = useState("");
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label?: string }>>([]);

  // Quickpill specific
  const [appendMode, setAppendMode] = useState(false);
  const [recentMessageCount, setRecentMessageCount] = useState(20);

  // BottomSheet drag state
  const sheetDragRef = useRef({ active: false, startY: 0, currentY: 0 });
  const sheetRef = useRef<HTMLDivElement>(null);

  const onSheetTouchStart = useCallback((e: React.TouchEvent) => {
    sheetDragRef.current.active = true;
    sheetDragRef.current.startY = e.touches[0].clientY;
    sheetDragRef.current.currentY = e.touches[0].clientY;
  }, []);

  const onSheetTouchMove = useCallback((e: React.TouchEvent) => {
    if (!sheetDragRef.current.active) return;
    const currentY = e.touches[0].clientY;
    sheetDragRef.current.currentY = currentY;
    const delta = currentY - sheetDragRef.current.startY;
    if (delta > 0 && sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${delta}px)`;
    }
  }, []);

  const onSheetTouchEnd = useCallback(() => {
    if (!sheetDragRef.current.active) return;
    sheetDragRef.current.active = false;
    const delta = sheetDragRef.current.currentY - sheetDragRef.current.startY;
    if (sheetRef.current) {
      sheetRef.current.style.transform = '';
      sheetRef.current.style.transition = '';
    }
    if (delta > 80) onClose();
  }, [onClose]);

  // Full specific
  const [prompt, setPrompt] = useState("");
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [includePersona, setIncludePersona] = useState(true);
  const [lorebookIds, setLorebookIds] = useState<string[]>([]);
  const [aiLorebooks, setAiLorebooks] = useState<LorebookRecord[]>([]);

  const [streaming, setStreaming] = useState(false);
  const [streamedOutput, setStreamedOutput] = useState("");
  const [streamedReasoning, setStreamedReasoning] = useState("");
  const [promptTokenCount, setPromptTokenCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const abortRef = useRef<AbortController | null>(null);

  // --- Initialization ---
  useEffect(() => {
    if (!isOpen) return;

    if (mode === "quickpill" && settings) {
      setProviderId(settings.providerId || bootstrapUiSettings?.aiAssistantProviderId || "");
      setModelName(settings.modelName || bootstrapUiSettings?.aiAssistantModelName || "");
      setAppendMode(settings.appendMode ?? false);
      setRecentMessageCount(settings.recentMessageCount ?? 20);
    } else if (mode === "full") {
      setProviderId(bootstrapUiSettings?.aiAssistantProviderId || "");
      setModelName(bootstrapUiSettings?.aiAssistantModelName || "");
      setPrompt("");
      setStreamedOutput("");
      setStreamedReasoning("");
      setError(null);
      setPromptTokenCount(null);
      setMdContent("");
      setParsedFields({});
      setCheckedFields(new Set());
      setFieldTargets({});
    }
  }, [isOpen, mode, settings, bootstrapUiSettings]);

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

  // Models fetch
  useEffect(() => {
    if (!providerId) { setProviderModels([]); return; }
    let cancelled = false;
    void fetchProviderModelsAction(providerId).then((response: unknown) => {
      if (!cancelled) {
        const models = (response && typeof response === "object" && "models" in response ? (response as { models: Array<{ id: string; label?: string }> }).models : []) as Array<{ id: string; label?: string }>;
        setProviderModels(models);
      }
    });
    return () => { cancelled = true; };
  }, [providerId]);

  const selectedProfile = providerProfiles.find((p) => p.id === providerId);

  // --- Handlers ---
  const persistAiModelSelection = (pId: string, mName: string | null) => {
    void updateUiSettings({ aiAssistantProviderId: pId || null, aiAssistantModelName: mName || null }).catch(() => {});
  };

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    setModelName("");
    if (mode === "full") persistAiModelSelection(id, null);
  };

  const handleModelChange = (id: string) => {
    setModelName(id);
    if (mode === "full") persistAiModelSelection(providerId, id || null);
  };

  const handleQuickpillApply = () => {
    if (onSettingsChange) {
      onSettingsChange({
        providerId,
        modelName,
        appendMode,
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
    };
  }, [apiMode, existingContent, includeCharacter, includePersona, modelName, prompt, providerId, scopeContext?.characterId, scopeContext?.personaId, selectedLorebookIds.join("\u0000")]);

  // --- Token Count Calculation ---
  useEffect(() => {
    if (!isOpen || mode !== "full") return;
    const request = buildAiRequest();
    if (!request) {
      setPromptTokenCount(null);
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => {
      countAiAssistantTokens(request, { signal: ac.signal })
        .then((result) => setPromptTokenCount(result.tokens))
        .catch((err: unknown) => {
          if (!(err instanceof Error && err.name === "AbortError")) setPromptTokenCount(null);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [isOpen, mode, prompt, providerId, modelName, includeCharacter, includePersona, lorebookIds.join("\u0000"), buildAiRequest]);

  // --- Generation ---
  const handleGenerate = async () => {
    if (apiMode === "md_import") {
      if (!providerId || !mdContent.trim()) return;
      persistAiModelSelection(providerId, modelName || null);
      setStreaming(true);
      setError(null);
      setParsedFields({});
      setCheckedFields(new Set());
      setFieldTargets({});
      setStreamedReasoning("");
      setStreamedOutput("");

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

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        for await (const chunk of streamAiAssistant(request, { signal: ac.signal })) {
          if (chunk.type === "reasoning" && chunk.text) {
            setStreamedReasoning(prev => prev + chunk.text);
          }
          if (chunk.type === "text" && chunk.text) {
            setStreamedOutput(prev => prev + chunk.text);
          }
          if (chunk.type === "partial_json" && chunk.json) {
            const nextParsed = chunk.json as Partial<MdImportResult>;
            setParsedFields(nextParsed);
            setCheckedFields(prev => {
              const next = new Set(prev);
              for (const [key, value] of Object.entries(nextParsed)) {
                if (value != null && value !== "" && !(Array.isArray(value) && value.length === 0)) {
                  next.add(key);
                  // Auto-check individual array items
                  if (Array.isArray(value) && value.length > 1 && value.every((item): item is string => typeof item === "string")) {
                    value.forEach((_, idx) => next.add(`${key}[${idx}]`));
                  }
                }
              }
              return next;
            });
            setFieldTargets(prev => {
              const next = { ...prev };
              for (const key of Object.keys(nextParsed)) {
                if (!(key in next)) next[key] = key as keyof MdImportResult;
              }
              return next;
            });
          }
          if (chunk.type === "error" && chunk.error) { setError(chunk.error); setStreaming(false); return; }
          if (chunk.type === "done") { setStreaming(false); return; }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") setError(String(err));
        setStreaming(false);
      }
      return;
    }

    const request = buildAiRequest();
    if (!request || !prompt.trim()) return;
    persistAiModelSelection(providerId, modelName || null);
    setStreaming(true);
    setError(null);
    setStreamedOutput("");
    setStreamedReasoning("");
    
    const ac = new AbortController();
    abortRef.current = ac;
    
    try {
      for await (const chunk of streamAiAssistant(request, { signal: ac.signal })) {
        if (chunk.type === "reasoning" && chunk.text) setStreamedReasoning(prev => prev + chunk.text);
        if (chunk.type === "text" && chunk.text) setStreamedOutput(prev => prev + chunk.text);
        if (chunk.type === "error" && chunk.error) { setError(chunk.error); setStreaming(false); return; }
        if (chunk.type === "done") { setStreaming(false); return; }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") setError(String(err));
      setStreaming(false);
    }
  };

  const handleStop = () => { abortRef.current?.abort(); setStreaming(false); };
  
  const cleanedOutput = useMemo(() => {
    if (apiMode === "script") return cleanAiCode(streamedOutput);
    return streamedOutput.trim();
  }, [apiMode, streamedOutput]);

  const isAiEditMode = Boolean(existingContent && existingContent.trim());
  const aiDiffSummary = useMemo(
    () => (!streaming && streamedOutput && isAiEditMode ? buildLineDiff(existingContent ?? "", cleanedOutput) : null),
    [existingContent, streaming, streamedOutput, isAiEditMode, cleanedOutput],
  );

  const resetAndClose = () => {
    setStreamedOutput("");
    setStreamedReasoning("");
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
  const promptLabelKey = apiMode === "lore_entry" ? "lore_entry_ai_prompt_label" : "script_ai_prompt";
  const promptPlaceholderKey = apiMode === "lore_entry" ? "lore_entry_ai_prompt_placeholder" : "script_ai_prompt";
  const promptHintKey = apiMode === "lore_entry" ? "lore_entry_ai_prompt_hint" : "script_ai_prompt_hint";
  const generatedKey = apiMode === "lore_entry" ? "lore_entry_ai_generated" : "script_ai_generated";
  const changesKey = apiMode === "lore_entry" ? "lore_entry_ai_changes" : "script_ai_changes";
  const noChangesKey = apiMode === "lore_entry" ? "lore_entry_ai_no_changes" : "script_ai_no_changes";

  // Render variables
  const isFull = mode === "full";
  const isMdImport = apiMode === "md_import";
  const title = isMdImport ? t("import_md_title") : isFull ? t("script_ai_helper") : t("ai_quickpill_settings");
  const contentWidth = isMdImport ? "w-[620px]" : isFull ? "w-[560px]" : "w-[380px]";

  const contentBody = (
    <>
      {/* Header */}
        <div className="flex items-center justify-between border-b border-border shrink-0" style={{ padding: "16px 20px" }}>
          <span className="text-sm font-semibold text-t1">{title}</span>
          <div className={cn("flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1", streaming && "pointer-events-none opacity-30")} onClick={onClose}>
            <Ic.close />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
          {providerProfiles.length === 0 ? (
            <div className="py-6 text-center font-ui text-[13px] text-t3">{t("script_ai_no_providers")}</div>
          ) : (
            <>
              {/* Provider / Model */}
              <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 16 }}>
                <div>
                  <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_connection")}</label>
                  <DropdownSelect
                    value={providerId}
                    options={providerProfiles.map((p) => ({ id: p.id, label: p.name }))}
                    placeholder={t("script_ai_select_provider")}
                    searchPlaceholder={t("script_ai_search_provider")}
                    onChange={handleProviderChange}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_ai_model")}</label>
                  <DropdownSelect
                    value={modelName}
                    options={providerModels.map((m) => ({ id: m.id, label: m.label || m.id }))}
                    placeholder={selectedProfile?.defaultModel || "Default"}
                    searchPlaceholder={t("script_ai_search_model")}
                    defaultOption={selectedProfile?.defaultModel || "Default"}
                    onChange={handleModelChange}
                    disabled={!providerId}
                  />
                </div>
              </div>

              {/* QUICKPILL SPECIFIC */}
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

              {/* Generation params — shared for all full modes */}
              {isFull && (
                <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 16 }}>
                  <div>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ai_param_temperature")}</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min={0} max={2} step={0.1} value={aiTemperature ?? (isMdImport ? 0 : 0.3)} onChange={(e) => setAiTemperature(Number(e.target.value))} className="flex-1 accent-accent" />
                      <span className="w-8 text-right font-ui text-[11px] tabular-nums text-t3">{(aiTemperature ?? (isMdImport ? 0 : 0.3)).toFixed(1)}</span>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("ai_param_max_tokens")}</label>
                    <NumberInput min={256} max={64000} value={aiMaxTokens ?? (isMdImport ? 6000 : 4096)} onChange={(v) => setAiMaxTokens(v)} className="w-full" />
                  </div>
                </div>
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
                    <AutoTextarea
                      className="w-full min-h-[120px] rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-mono text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none"
                      style={{}}
                      maxHeight={300}
                      placeholder={t("import_md_paste_placeholder")}
                      value={mdContent}
                      onChange={(e) => setMdContent(e.target.value)}
                    />
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
                                      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border2 bg-s1 px-2 py-1.5 font-mono text-[12px] leading-[1.4] text-t1">
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
                                  <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border2 bg-s1 px-2 py-1.5 font-mono text-[12px] leading-[1.4] text-t1">
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
                      <AutoTextarea className="w-full min-h-[100px] rounded-[6px] border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent resize-none" style={{}} maxHeight={300} placeholder={t(promptPlaceholderKey)} value={prompt} onChange={e => setPrompt(e.target.value)} />
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
          )}
        </div>

        {/* Footer */}
        {providerProfiles.length > 0 && (
          <div className="flex justify-end gap-2 border-t border-border shrink-0" style={{ padding: "12px 20px" }}>
            {!isFull ? (
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
            )}
          </div>
        )}
      </>
  );

  if (isMobile && !isFull) {
    return (
      <div className="fixed inset-0 z-[500] bg-black/55 backdrop-blur-[2px]" onClick={onClose}>
        <div
          ref={sheetRef}
          className="fixed inset-x-0 bottom-0 z-[501] flex max-h-[85vh] flex-col overflow-hidden rounded-t-2xl border-t border-border2 bg-surface pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_24px_rgba(0,0,0,0.5)]"
          style={{ animation: "0.2s ease-out 0s 1 normal none running slideUp", transition: "transform 0s" }}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={onSheetTouchStart}
          onTouchMove={onSheetTouchMove}
          onTouchEnd={onSheetTouchEnd}
        >
          <div className="flex justify-center pt-2 pb-1 shrink-0">
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>
          {contentBody}
        </div>
      </div>
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
