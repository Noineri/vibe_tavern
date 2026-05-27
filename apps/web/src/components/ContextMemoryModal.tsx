import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatId } from "@rp-platform/domain";
import { Icons } from "./shared/icons.js";
import { Modal } from "./shared/Modal.js";
import { MobileExpandTextarea } from "./shared/MobileExpandTextarea.js";
import { useIsMobile } from "../hooks/use-mobile.js";
import { SummaryTab, ContextFooter } from "./context/index.js";
import type { SavedSummary } from "./context/SummaryTab.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";
import {
  readSummarySettings,
  persistSummarySettings,
  readSavedSummaries,
  persistSavedSummaries,
  type SavedSummaryRecord,
} from "../lib/local-storage.js";

interface ContextMemoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeChatId: ChatId | null;
  providers: Array<{ id: string; name: string; defaultModel?: string | null; hasStoredApiKey?: boolean; isActive?: boolean }>;
  contextWindow: { used: number; limit: number };
  currentSummary: string;
  messageCount: number;
  onSummarize: (input: { providerProfileId: string; model?: string; maxMessages: number }) => Promise<string>;
  onSaveSummary: (summary: string) => Promise<string>;
  onFetchModelsForProfile: (providerProfileId: string) => Promise<Array<{ id: string; label: string; contextLength?: number }>>;
}

let nextSummaryCounter = 1;

export function ContextMemoryModal({
  isOpen,
  onClose,
  activeChatId,
  providers,
  contextWindow,
  currentSummary,
  messageCount,
  onSummarize,
  onSaveSummary,
  onFetchModelsForProfile,
}: ContextMemoryModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [topTab, setTopTab] = useState<'summary' | 'memory'>('summary');
  const [summaryText, setSummaryText] = useState(currentSummary);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [activeSummaryId, setActiveSummaryId] = useState<string | null>(null);
  const effectiveMax = Math.max(messageCount, 1);
  const [msgCount, setMsgCount] = useState(Math.min(Math.max(messageCount || 10, 1), effectiveMax));
  const [selectedProviderId, setSelectedProviderId] = useState(providers.find((p) => p.isActive)?.id ?? providers[0]?.id ?? '');
  const [selectedModel, setSelectedModel] = useState(providers.find((p) => p.isActive)?.defaultModel ?? providers[0]?.defaultModel ?? '');
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label: string; contextLength?: number }>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [autosaveFlash, setAutosaveFlash] = useState(false);
  const [savedRecords, setSavedRecords] = useState<SavedSummaryRecord[]>([]);

  // Stabilize the fetch callback so the model-loading effect doesn't re-run on every render
  const fetchModelsRef = useRef(onFetchModelsForProfile);
  fetchModelsRef.current = onFetchModelsForProfile;

  // Autosave timer ref
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load saved summaries from localStorage when modal opens or chat changes
  useEffect(() => {
    if (!isOpen || !activeChatId) return;
    const records = readSavedSummaries(activeChatId);
    setSavedRecords(records);

    // Restore persisted provider/model settings
    const settings = readSummarySettings(activeChatId);
    if (settings) {
      if (settings.providerId && providers.some(p => p.id === settings.providerId)) {
        setSelectedProviderId(settings.providerId);
      }
      if (settings.model) {
        setSelectedModel(settings.model);
      }
    }
  }, [isOpen, activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return;
    const newMax = Math.max(messageCount, 1);
    setMsgCount((prev) => Math.min(prev, newMax));
  }, [isOpen, messageCount]);

  useEffect(() => {
    if (!selectedProviderId || !providers.some((p) => p.id === selectedProviderId)) {
      const nextProvider = providers.find((p) => p.isActive) ?? providers[0];
      setSelectedProviderId(nextProvider?.id ?? '');
      setSelectedModel(nextProvider?.defaultModel ?? '');
    }
  }, [providers, selectedProviderId]);

  useEffect(() => {
    if (!isOpen || !selectedProviderId) {
      setProviderModels([]);
      return;
    }

    let cancelled = false;
    setIsLoadingModels(true);
    void fetchModelsRef.current(selectedProviderId)
      .then((models) => {
        if (cancelled) return;
        setProviderModels(models.map((model) => ({ id: model.id, label: model.label || model.id, contextLength: model.contextLength })));
        const currentStillExists = models.some((model) => model.id === selectedModel);
        const defaultModel = providers.find((p) => p.id === selectedProviderId)?.defaultModel ?? '';
        const nextModel = (defaultModel && models.some((model) => model.id === defaultModel) ? defaultModel : models[0]?.id) ?? '';
        if (!currentStillExists) setSelectedModel(nextModel);
      })
      .catch((err) => {
        if (!cancelled) {
          setProviderModels([]);
          toast.error(err instanceof Error ? err.message : t("models_load_failed"));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingModels(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, selectedProviderId]);

  const handleAutosaveSettings = useCallback((providerId: string, model: string) => {
    if (!activeChatId) return;
    persistSummarySettings(activeChatId, { providerId, model });
    setAutosaveFlash(true);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => setAutosaveFlash(false), 1200);
  }, [activeChatId]);

  const persistRecords = useCallback((records: SavedSummaryRecord[]) => {
    if (!activeChatId) return;
    setSavedRecords(records);
    persistSavedSummaries(activeChatId, records);
  }, [activeChatId]);

  const isDisabled = activeChatId === null;
  const providerOptions = providers.map(p => ({ id: p.id, name: p.name, defaultModel: p.defaultModel ?? '' }));

  // Build sidebar list: saved records + current backend summary (if any)
  const savedSummaries = useMemo<SavedSummary[]>(() => {
    const items: SavedSummary[] = savedRecords.map((r) => ({
      id: r.id,
      label: r.label,
      text: r.text,
      turn: r.msgCount,
      timestamp: new Date(r.timestamp).toLocaleString(),
      includeInContext: r.includeInContext,
    }));
    // If there's a backend summary that isn't already in savedRecords, show it too
    if (currentSummary.trim() && !savedRecords.some(r => r.text === currentSummary)) {
      items.unshift({
        id: 'chat-summary',
        label: t('current_summary_label'),
        text: currentSummary,
        turn: messageCount,
        timestamp: t('summary_timestamp_saved'),
        includeInContext: true,
      });
    }
    return items;
  }, [currentSummary, messageCount, savedRecords, t]);

  if (!isOpen) return null;

  const handleSummarize = async () => {
    const selected = providers.find((p) => p.id === selectedProviderId);
    if (!selected) {
      toast.error(t("select_provider_error"));
      return;
    }
    if (!selectedModel.trim()) {
      toast.error(t("no_default_model"));
      return;
    }
    setIsSummarizing(true);
    try {
      const summary = await onSummarize({ providerProfileId: selectedProviderId, model: selectedModel.trim() || undefined, maxMessages: msgCount });

      // Add a new summary record to localStorage
      const newRecord: SavedSummaryRecord = {
        id: `summary-${Date.now()}-${nextSummaryCounter++}`,
        label: `${t('summary_label_prefix')} ${savedRecords.length + 1}`,
        text: summary,
        msgCount,
        timestamp: Date.now(),
        includeInContext: false,
      };
      persistRecords([...savedRecords, newRecord]);

      setSummaryText(summary);
      setActiveSummaryId(newRecord.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summarization_failed"));
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Save the currently edited summary text to the backend
      const summary = await onSaveSummary(summaryText);
      setSummaryText(summary);

      // Also update/create a local record for this summary
      if (summary.trim()) {
        const existingIdx = savedRecords.findIndex(r => r.id === activeSummaryId);
        if (existingIdx >= 0) {
          const updated = [...savedRecords];
          updated[existingIdx] = { ...updated[existingIdx], text: summary };
          persistRecords(updated);
        } else {
          const newRecord: SavedSummaryRecord = {
            id: activeSummaryId ?? `summary-${Date.now()}-${nextSummaryCounter++}`,
            label: `${t('summary_label_prefix')} ${savedRecords.length + 1}`,
            text: summary,
            msgCount,
            timestamp: Date.now(),
            includeInContext: false,
          };
          persistRecords([...savedRecords, newRecord]);
          setActiveSummaryId(newRecord.id);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectSummary = (id: string) => {
    const record = savedSummaries.find(s => s.id === id);
    if (record) {
      setSummaryText(record.text);
      setActiveSummaryId(id);
      if (isMobile) setMobileDetailOpen(true);
    }
  };

  const handleDeleteSummary = (id: string) => {
    if (id === 'chat-summary') {
      // Delete the backend summary
      void onSaveSummary('').then((summary) => {
        setSummaryText(summary);
        if (activeSummaryId === 'chat-summary') setActiveSummaryId(null);
      }).catch((err) => {
        toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
      });
    } else {
      const updated = savedRecords.filter(r => r.id !== id);
      persistRecords(updated);
      if (activeSummaryId === id) {
        setActiveSummaryId(null);
        setSummaryText('');
      }
    }
  };

  const handleToggleContext = (id: string) => {
    if (id === 'chat-summary') return; // Backend summary is always included
    const updated = savedRecords.map(r =>
      r.id === id ? { ...r, includeInContext: !r.includeInContext } : r
    );
    persistRecords(updated);
  };

  const activeSummaryName = activeSummaryId
    ? savedSummaries.find(s => s.id === activeSummaryId)?.label ?? ''
    : '';

  return (
    <Modal open={true} onClose={onClose}>
      <div className={cn("flex flex-col overflow-hidden bg-surface", isMobile ? "w-full h-full" : "h-[min(85vh,680px)] max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] w-[820px] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]")}>
        {/* ── HEADER ── */}
        <div className={cn("shrink-0 border-b border-border", isMobile ? "px-3 py-2.5" : "px-5 pt-[18px]")}>
          {isMobile && mobileDetailOpen ? (
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 hover:bg-s2 hover:text-t1" onClick={() => { setMobileDetailOpen(false); setActiveSummaryId(null); }}>
                <span className="text-lg leading-none">←</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-body text-[calc(var(--ui-fs)+2px)] font-medium text-t1">{activeSummaryName}</div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <div className={cn("font-body font-medium text-t1", isMobile ? "text-[calc(var(--ui-fs)+2px)]" : "text-[calc(var(--ui-fs)+4px)] mb-0.5")}>{t("context_memory_title")}</div>
                {!isMobile && <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("context_memory_sub")}</div>}
              </div>
              <div
                className={cn("shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1", isMobile ? "flex h-8 w-8" : "flex h-[32px] w-[32px]")}
                onClick={onClose}
              >
                <Icons.Close />
              </div>
            </div>
          )}
          {!isMobile && (
            <div className="flex gap-0 mt-1">
              <div className={cn("cursor-pointer border-b-2 border-b-transparent px-4 py-2 font-ui text-xs font-medium text-t3 transition-all select-none hover:text-t2", topTab === 'summary' && "border-b-accent text-accent-t")} onClick={() => setTopTab('summary')}>{t("memory_v1_tab")}</div>
            </div>
          )}
        </div>

        {/* ── MOBILE: drill-down views ── */}
        {isMobile ? (
          <>
            {mobileDetailOpen ? (
              /* ── Mobile detail view ── */
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
                <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3 mb-[7px]">{t('summary_text_label')}</label>
                <MobileExpandTextarea value={summaryText} onChange={setSummaryText} label={t('summary_text_label')}>
                  <textarea
                    className="w-full flex-1 min-h-[120px] resize-none rounded-md border border-border bg-s2 px-[13px] py-[9px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
                    placeholder={t('summary_placeholder')}
                    value={summaryText}
                    disabled={isDisabled}
                    onChange={e => setSummaryText(e.target.value)}
                  />
                </MobileExpandTextarea>

                <div className="shrink-0 mt-3">
                  <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3 mb-[7px]">{t('msg_to_summarize_label')}</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={1} max={effectiveMax} value={msgCount}
                      disabled={isDisabled || isSummarizing}
                      onChange={e => setMsgCount(Number(e.target.value))}
                      className="accent-accent h-2 flex-1 cursor-pointer rounded-full bg-s3"
                    />
                    <input
                      type="number" min={1} max={effectiveMax} value={msgCount}
                      disabled={isDisabled || isSummarizing}
                      onChange={e => setMsgCount(Math.max(1, Math.min(effectiveMax, Number(e.target.value) || 1)))}
                      className="h-[32px] w-[52px] rounded border border-border bg-s2 text-center font-ui text-[12px] text-t1 outline-none focus:border-accent px-1"
                    />
                  </div>
                </div>

                <div className="shrink-0 mt-3">
                  <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3 mb-[7px]">{t('summarize_provider_label')}</label>
                  <select
                    value={selectedProviderId}
                    disabled={isDisabled || isSummarizing}
                    onChange={e => { setSelectedProviderId(e.target.value); setSelectedModel(''); setProviderModels([]); }}
                    className="w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none pl-[13px]"
                  >
                    {providerOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>

                <div className="shrink-0 mt-3">
                  <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3 mb-[7px]">{t('summarize_model_label')}</label>
                  <select
                    value={selectedModel}
                    disabled={isDisabled || isSummarizing || isLoadingModels}
                    onChange={e => setSelectedModel(e.target.value)}
                    className="w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none pl-[13px] disabled:opacity-60"
                  >
                    {isLoadingModels
                      ? <option>{t('loading_models')}</option>
                      : providerModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>

                <button
                  className="mt-3 h-[38px] w-full shrink-0 cursor-pointer rounded-md border-0 bg-accent font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:cursor-default disabled:opacity-40"
                  disabled={isDisabled || isSummarizing || !selectedProviderId || !selectedModel.trim()}
                  onClick={handleSummarize}
                >
                  {isSummarizing ? t('summarizing_btn') : t('summarize_btn')}
                </button>
              </div>
            ) : (
              /* ── Mobile list view ── */
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <div className="px-[13px] pt-2 pb-2 font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.08em] text-t3">{t('saved_summaries_label')}</div>
                {savedSummaries.length === 0 && (
                  <div className="px-3 py-4 text-center font-ui text-[11px] text-t4">{t('no_saved_summaries')}</div>
                )}
                {savedSummaries.map(s => (
                  <div
                    key={s.id}
                    className={cn(
                      "group flex cursor-pointer items-center gap-1 border-l-2 border-l-transparent px-4 py-3 transition-colors hover:bg-s2",
                      activeSummaryId === s.id && "border-l-accent bg-accent-dim",
                    )}
                    onClick={() => handleSelectSummary(s.id)}
                  >
                    {handleToggleContext && (
                      <button
                        className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border transition-colors mr-1",
                          s.includeInContext ? "border-accent bg-accent text-white" : "border-border2 bg-transparent")}
                        onClick={e => { e.stopPropagation(); handleToggleContext(s.id); }}
                      >
                        {s.includeInContext && <Icons.Check />}
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate font-ui text-[12px]", activeSummaryId === s.id ? "font-medium text-accent-t" : "text-t2")}>{s.label}</div>
                      <div className="truncate font-ui text-[10px] text-t4">{s.timestamp}</div>
                    </div>
                    <div className="shrink-0 px-2 py-1 text-t3">
                      <Icons.Caret direction="r" />
                    </div>
                  </div>
                ))}
                <div className="shrink-0 border-t border-border px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] mt-auto">
                  <button
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:border-border hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                    disabled={isDisabled}
                    onClick={() => { setSummaryText(''); setActiveSummaryId(null); if (isMobile) setMobileDetailOpen(true); }}
                  >
                    <Icons.Plus /> {t('new_summary_entry')}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          /* ── Desktop: two-column SummaryTab ── */
          <SummaryTab
            summaryText={summaryText}
            onSummaryTextChange={setSummaryText}
            msgCount={msgCount}
            onMsgCountChange={setMsgCount}
            maxMsgCount={effectiveMax}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            onProviderChange={(id) => {
              setSelectedProviderId(id);
              setSelectedModel('');
              setProviderModels([]);
              handleAutosaveSettings(id, '');
            }}
            onModelChange={(model) => {
              setSelectedModel(model);
              handleAutosaveSettings(selectedProviderId, model);
            }}
            providers={providerOptions}
            models={providerModels}
            isLoadingModels={isLoadingModels}
            onSummarize={handleSummarize}
            isSummarizing={isSummarizing}
            savedSummaries={savedSummaries}
            activeSummaryId={activeSummaryId}
            onSelectSummary={handleSelectSummary}
            onDeleteSummary={handleDeleteSummary}
            onToggleContext={handleToggleContext}
            onNewSummary={() => { setSummaryText(''); setActiveSummaryId(null); }}
            disabled={isDisabled}
            error=""
          />
        )}

        {/* ── FOOTER: only on desktop or mobile detail ── */}
        {(!isMobile || mobileDetailOpen) && (
        <div className="shrink-0 pb-[env(safe-area-inset-bottom,0px)]">
        <ContextFooter
          topTab={topTab}
          onClose={onClose}
          disabled={isDisabled}
          contextWindow={contextWindow}
          onSaveSummary={handleSave}
          isSaving={isSaving}
          autoSaveFlash={autosaveFlash}
        />
        </div>
        )}
      </div>
    </Modal>
  );
}
