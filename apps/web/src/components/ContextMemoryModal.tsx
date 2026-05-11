import { useEffect, useMemo, useState } from "react";
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
  onSummarize: (input: { providerProfileId: string; maxMessages: number }) => Promise<string>;
  onSaveSummary: (summary: string) => Promise<string>;
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
}: ContextMemoryModalProps) {
  const { t } = useT();
  const [topTab, setTopTab] = useState<'summary' | 'memory'>('summary');
  const [summaryText, setSummaryText] = useState(currentSummary);
  const [msgCount, setMsgCount] = useState(Math.min(Math.max(messageCount || 10, 1), 200));
  const [selectedProviderId, setSelectedProviderId] = useState(providers.find((p) => p.isActive)?.id ?? providers[0]?.id ?? '');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isOpen) setSummaryText(currentSummary);
  }, [currentSummary, isOpen]);

  useEffect(() => {
    if (!selectedProviderId || !providers.some((p) => p.id === selectedProviderId)) {
      setSelectedProviderId(providers.find((p) => p.isActive)?.id ?? providers[0]?.id ?? '');
    }
  }, [providers, selectedProviderId]);

  const isDisabled = activeChatId === null;
  const providerOptions = providers.map(p => ({ id: p.id, name: p.name }));
  const savedSummaries = useMemo<SavedSummary[]>(() => currentSummary.trim()
    ? [{ id: 'chat-summary', label: 'Current summary', text: currentSummary, turn: messageCount, timestamp: 'saved' }]
    : [], [currentSummary, messageCount]);

  if (!isOpen) return null;

  const handleSummarize = async () => {
    setError("");
    const selected = providers.find((p) => p.id === selectedProviderId);
    if (!selected) {
      setError(t("select_provider_error"));
      return;
    }
    if (!selected.defaultModel) {
      setError(t("no_default_model"));
      return;
    }
    setIsSummarizing(true);
    try {
      const summary = await onSummarize({ providerProfileId: selectedProviderId, maxMessages: msgCount });
      setSummaryText(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("summarization_failed"));
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleSave = async () => {
    setError("");
    setIsSaving(true);
    try {
      const summary = await onSaveSummary(summaryText);
      setSummaryText(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("summary_save_failed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="flex h-[min(85vh,660px)] max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] w-[720px] flex-col overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        <div className="shrink-0 border-b border-border" style={{padding:'18px 20px 0'}}>
          <div className="flex items-start justify-between" style={{paddingBottom:12}}>
            <div>
              <div className="font-body mb-0.5 text-[calc(var(--ui-fs)+4px)] font-medium text-t1">{t("context_memory_title")}</div>
              <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("context_memory_sub")}</div>
            </div>
            <div className="flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={onClose}><Icons.Close /></div>
          </div>
          <div className="flex gap-0 mt-1">
            <div className={cn("cursor-pointer border-b-2 border-b-transparent font-ui text-xs font-medium text-t3 transition-all select-none hover:text-t2", topTab === 'summary' && "border-b-accent text-accent-t")} style={{padding:'8px 16px'}} onClick={() => setTopTab('summary')}>{t("memory_v1_tab")}</div>
          </div>
        </div>

        <SummaryTab
          summaryText={summaryText}
          onSummaryTextChange={setSummaryText}
          msgCount={msgCount}
          onMsgCountChange={setMsgCount}
          maxMsgCount={200}
          selectedProviderId={selectedProviderId}
          onProviderChange={setSelectedProviderId}
          providers={providerOptions}
          onSummarize={handleSummarize}
          isSummarizing={isSummarizing}
          savedSummaries={savedSummaries}
          activeSummaryId={currentSummary.trim() ? 'chat-summary' : null}
          onSelectSummary={() => setSummaryText(currentSummary)}
          onDeleteSummary={() => setSummaryText('')}
          disabled={isDisabled}
          error={error}
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


