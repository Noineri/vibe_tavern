import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ChatId } from "@rp-platform/domain";
import { Icons } from "./shared/icons.js";
import { SummaryTab, ContextFooter } from "./context/index.js";
import type { SavedSummary } from "./context/SummaryTab.js";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/context.js";

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
  const [topTab, setTopTab] = useState<'summary' | 'memory'>('summary');
  const [summaryText, setSummaryText] = useState(currentSummary);
  const [activeSummaryId, setActiveSummaryId] = useState<string | null>(currentSummary.trim() ? 'chat-summary' : null);
  const [msgCount, setMsgCount] = useState(Math.min(Math.max(messageCount || 10, 1), 200));
  const [selectedProviderId, setSelectedProviderId] = useState(providers.find((p) => p.isActive)?.id ?? providers[0]?.id ?? '');
  const [selectedModel, setSelectedModel] = useState(providers.find((p) => p.isActive)?.defaultModel ?? providers[0]?.defaultModel ?? '');
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label: string; contextLength?: number }>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSummaryText(currentSummary);
    setActiveSummaryId(currentSummary.trim() ? 'chat-summary' : null);
  }, [currentSummary, isOpen]);

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
    void onFetchModelsForProfile(selectedProviderId)
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
  }, [isOpen, selectedProviderId, onFetchModelsForProfile]);

  const isDisabled = activeChatId === null;
  const providerOptions = providers.map(p => ({ id: p.id, name: p.name, defaultModel: p.defaultModel ?? '' }));
  const savedSummaries = useMemo<SavedSummary[]>(() => currentSummary.trim()
    ? [{ id: 'chat-summary', label: 'Current summary', text: currentSummary, turn: messageCount, timestamp: 'saved' }]
    : [], [currentSummary, messageCount]);

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
      setSummaryText(summary);
      setActiveSummaryId('chat-summary');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summarization_failed"));
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const summary = await onSaveSummary(summaryText);
      setSummaryText(summary);
      setActiveSummaryId(summary.trim() ? 'chat-summary' : null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="flex h-[min(85vh,680px)] max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] w-[820px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        <div className="shrink-0 border-b border-border px-5 pt-[18px]">
          <div className="flex items-start justify-between pb-3">
            <div>
              <div className="font-body mb-0.5 text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{t("context_memory_title")}</div>
              <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("context_memory_sub")}</div>
            </div>
            <div className="flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}><Icons.Close /></div>
          </div>
          <div className="flex gap-0 mt-1">
            <div className={cn("cursor-pointer border-b-2 border-b-transparent px-4 py-2 font-ui text-xs font-medium text-t3 transition-all select-none hover:text-t2", topTab === 'summary' && "border-b-accent text-accent-t")} onClick={() => setTopTab('summary')}>{t("memory_v1_tab")}</div>
          </div>
        </div>

        <SummaryTab
          summaryText={summaryText}
          onSummaryTextChange={setSummaryText}
          msgCount={msgCount}
          onMsgCountChange={setMsgCount}
          maxMsgCount={200}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          onProviderChange={(id) => {
            setSelectedProviderId(id);
            setSelectedModel('');
            setProviderModels([]);
          }}
          onModelChange={setSelectedModel}
          providers={providerOptions}
          models={providerModels}
          isLoadingModels={isLoadingModels}
          onSummarize={handleSummarize}
          isSummarizing={isSummarizing}
          savedSummaries={savedSummaries}
          activeSummaryId={activeSummaryId}
          onSelectSummary={() => { setSummaryText(currentSummary); setActiveSummaryId('chat-summary'); }}
          onDeleteSummary={async () => {
            try {
              const summary = await onSaveSummary('');
              setSummaryText(summary);
              setActiveSummaryId(null);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
            }
          }}
          onNewSummary={() => { setSummaryText(''); setActiveSummaryId(null); }}
          disabled={isDisabled}
          error=""
        />

        <ContextFooter
          topTab={topTab}
          onClose={onClose}
          disabled={isDisabled}
          contextWindow={contextWindow}
          onSaveSummary={handleSave}
          isSaving={isSaving}
        />
      </div>
    </div>
  );
}


