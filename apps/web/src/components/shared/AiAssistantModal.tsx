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

export interface AiAssistantModalProps {
  mode: "full" | "quickpill";
  isOpen: boolean;
  onClose: () => void;

  // --- Full Mode Props ---
  apiMode?: "script" | "lore_entry";
  existingContent?: string;
  onInsert?: (text: string) => void;
  onReplace?: (text: string) => void;
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
  } : null;

  const persTarget: LinkTarget | null = scopeContext?.personaId ? {
    id: scopeContext.personaId,
    name: activePersona?.id === scopeContext.personaId ? activePersona.name : allPersonaContext?.name ?? "Persona",
    avatarAssetId: activePersona?.id === scopeContext.personaId ? activePersona.avatarAssetId ?? null : allPersonaContext?.avatarAssetId ?? null,
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
  const title = isFull ? t("script_ai_helper") : t("ai_quickpill_settings");
  const contentWidth = isFull ? "w-[560px]" : "w-[380px]";

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

              {/* FULL SPECIFIC */}
              {isFull && (
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
                  <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={handleStop}>{t("script_ai_stop")}</button>
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
