import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { ChatId } from "@vibe-tavern/domain";
import type { AutoSummaryConfig, ChatSummaryRecord } from "../../app-client.js";
import { Ic, Icons } from "../shared/icons.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MasterDetailModal, MasterDetailMobileDrillDown } from "../shared/MasterDetailModal.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { Toggle } from "../shared/Toggle.js";
import { NumberInput } from "../shared/NumberInput.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { countTokens } from "../../utils/tokenizer.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import {
  createChatSummaryAction,
  deleteChatSummaryAction,
  generateChatSummaryAction,
  listChatSummariesAction,
  updateChatSummaryAction,
  updateMemorySettingsAction,
} from "../../stores/api-actions/chat-actions.js";

/* ─── shared styles ─── */
const labelCls = "block font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t3 mb-2";
const inputCls = "rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[13px] text-t1 outline-none transition-colors focus:border-accent disabled:opacity-50";

const DEFAULT_AUTO_CONFIG: AutoSummaryConfig = {
  enabled: false,
  everyN: 20,
  useChatModel: true,
  excludeSummarized: true,
};

/* ─── Dual-range slider ─── */
function DualRangeSlider({ min, max, from, to, disabled, onChange }: {
  min: number; max: number; from: number; to: number;
  disabled?: boolean;
  onChange: (from: number, to: number) => void;
}) {
  const clampValue = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const safeFrom = Math.min(clampValue(from), clampValue(to));
  const safeTo = Math.max(clampValue(from), clampValue(to));

  function handleFrom(v: number) {
    const next = clampValue(v);
    onChange(Math.min(next, safeTo), safeTo);
  }
  function handleTo(v: number) {
    const next = clampValue(v);
    onChange(safeFrom, Math.max(safeFrom, next));
  }
  const trackPct = (v: number) => max > min ? Math.min(100, Math.max(0, ((clampValue(v) - min) / (max - min)) * 100)) : 0;

  const thumbCls =
    "absolute inset-x-0 top-0 h-5 w-full appearance-none bg-transparent " +
    "[&::-webkit-slider-thumb]:h-[16px] [&::-webkit-slider-thumb]:w-[16px] " +
    "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full " +
    "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent " +
    "[&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-sm " +
    "[&::-webkit-slider-thumb]:transition-shadow [&::-webkit-slider-thumb]:hover:shadow-[0_0_0_3px_var(--accent-dim)] " +
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:cursor-pointer";

  return (
    <div className="relative h-5 pb-4">
      {/* Track bg */}
      <div className="absolute left-0 right-0 top-[7px] h-[6px] rounded-full bg-s3" />
      {/* Filled track between the two thumbs */}
      <div
        className="absolute top-[7px] h-[6px] rounded-full bg-accent"
        style={{ left: `${trackPct(safeFrom)}%`, width: `${Math.max(0, trackPct(safeTo) - trackPct(safeFrom))}%` }}
      />
      {/* Both inputs: pointer-events:none on container, auto on thumb via Tailwind */}
      <input
        type="range" min={min} max={max} value={safeFrom}
        disabled={disabled}
        onChange={(e) => handleFrom(Number(e.target.value))}
        className={cn("dual-range-l z-[2] pointer-events-none", thumbCls)}
      />
      <input
        type="range" min={min} max={max} value={safeTo}
        disabled={disabled}
        onChange={(e) => handleTo(Number(e.target.value))}
        className={cn("dual-range-u z-[3] pointer-events-none", thumbCls)}
      />
    </div>
  );
}

/* ─── Auto-resize textarea hook ─── */
function useAutoResize(): [RefObject<HTMLTextAreaElement | null>, () => void] {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.max(86, el.scrollHeight) + "px";
  }, []);
  return [ref, resize];
}

/* ─── Main component ─── */
interface ContextMemoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeChatId: ChatId | null;
  providers: Array<{ id: string; name: string; defaultModel?: string | null; hasStoredApiKey?: boolean; isActive?: boolean }>;
  contextWindow: { used: number; limit: number };
  currentSummary: string;
  messageCount: number;
  messageHistoryLimit?: number;
  autoSummaryConfig?: Partial<AutoSummaryConfig>;
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
  currentSummary: _currentSummary,
  messageCount,
  messageHistoryLimit = 0,
  autoSummaryConfig,
  onSummarize: _onSummarize,
  onSaveSummary: _onSaveSummary,
  onFetchModelsForProfile,
}: ContextMemoryModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const activeProvider = providers.find((p) => p.isActive) ?? providers[0] ?? null;
  const messagesById = useSnapshotStore((s) => s.messagesById);
  const messageOrder = useSnapshotStore((s) => s.messageOrder);
  const messages = useMemo(() => messageOrder.map((id) => messagesById[id]).filter(Boolean), [messageOrder, messagesById]);

  /* ─── state ─── */
  const [summaries, setSummaries] = useState<ChatSummaryRecord[]>([]);
  const [activeSummaryId, setActiveSummaryId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(Math.max(1, messageCount));
  const [includeInContext, setIncludeInContext] = useState(true);
  const [excludeSummarized, setExcludeSummarized] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [useChatModel, setUseChatModel] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState(activeProvider?.id ?? "");
  const [selectedModel, setSelectedModel] = useState(activeProvider?.defaultModel ?? "");
  const [pinnedModel, setPinnedModel] = useState<string | null>(null);
  const [providerModels, setProviderModels] = useState<Array<{ id: string; label: string; contextLength?: number }>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(messageHistoryLimit || messageCount || 1);
  const [autoConfig, setAutoConfig] = useState<AutoSummaryConfig>({ ...DEFAULT_AUTO_CONFIG, ...autoSummaryConfig });
  const abortRef = useRef<AbortController | null>(null);
  const [textareaRef, autoResize] = useAutoResize();

  const maxMessage = Math.max(1, messageCount - 1);
  const activeSummary = summaries.find((s) => s.id === activeSummaryId) ?? null;
  const effectiveProviderId = useChatModel ? activeProvider?.id ?? selectedProviderId : selectedProviderId;
  const effectiveModel = (useChatModel ? (pinnedModel ?? activeProvider?.defaultModel ?? selectedModel) : (pinnedModel ?? selectedModel))?.trim() ?? "";

  /* ─── derived data ─── */
  const selectedRangeMessages = useMemo(() => {
    return messages.filter((m) => {
      const pos = (m.position ?? 0) + 1;
      return pos >= rangeFrom && pos <= rangeTo;
    });
  }, [messages, rangeFrom, rangeTo]);

  const excludedRanges = useMemo(() => {
    return summaries
      .filter((s) => s.includeInContext && s.excludeSummarized && s.summarizedTo >= s.summarizedFrom)
      .map((s) => ({ from: s.summarizedFrom, to: s.summarizedTo }));
  }, [summaries]);

  const tokenEstimate = useMemo(() => {
    const summaryTokens = countTokens(draftText);
    const limitedMessages = messages
      .filter((m) => {
        const pos = (m.position ?? 0) + 1;
        return !excludedRanges.some((r) => pos >= r.from && pos <= r.to);
      })
      .slice(-(historyLimit || messages.length));
    const historyTokens = limitedMessages.reduce((sum, m) => sum + countTokens(m.content), 0);
    const selectedRawTokens = selectedRangeMessages.reduce((sum, m) => sum + countTokens(m.content), 0);
    const saved = Math.max(0, selectedRawTokens - summaryTokens);
    const pct = selectedRawTokens > 0 ? Math.round((saved / selectedRawTokens) * 100) : 0;
    return { summaryTokens, historyTokens, total: summaryTokens + historyTokens, selectedRawTokens, saved, pct };
  }, [draftText, excludedRanges, historyLimit, messages, selectedRangeMessages]);

  const contextPct = contextWindow.limit > 0 ? Math.min(100, Math.round((contextWindow.used / contextWindow.limit) * 100)) : 0;

  const providerOptions = useMemo(
    () => providers.map((p) => ({ id: p.id, label: p.name })),
    [providers],
  );
  const modelOptions = useMemo(
    () => providerModels.map((m) => ({ id: m.id, label: m.label, detail: m.contextLength ? `${m.contextLength}t` : undefined })),
    [providerModels],
  );

  /* ─── effects ─── */
  const loadSummaries = useCallback(async () => {
    if (!activeChatId) return;
    setLoading(true);
    try {
      const rows = await listChatSummariesAction(activeChatId);
      setSummaries(rows);
      if (rows.length > 0) selectSummary(rows[0], false);
      else startNewSummary();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    } finally {
      setLoading(false);
    }
  }, [activeChatId, t]);

  useEffect(() => { if (isOpen) void loadSummaries(); }, [isOpen, loadSummaries]);

  useEffect(() => {
    if (!isOpen) return;
    setRangeFrom((prev) => clamp(prev, 1, maxMessage));
    setRangeTo((prev) => clamp(Math.max(prev, 1), 1, maxMessage));
    setHistoryLimit(messageHistoryLimit || messageCount || 1);
    setAutoConfig({ ...DEFAULT_AUTO_CONFIG, ...autoSummaryConfig });
  }, [autoSummaryConfig, isOpen, maxMessage, messageCount, messageHistoryLimit]);

  useEffect(() => {
    if (!selectedProviderId) {
      setSelectedProviderId(activeProvider?.id ?? "");
      setSelectedModel(activeProvider?.defaultModel ?? "");
    }
  }, [activeProvider, selectedProviderId]);

  useEffect(() => {
    if (!isOpen || !selectedProviderId) { setProviderModels([]); return; }
    let cancelled = false;
    setIsLoadingModels(true);
    void onFetchModelsForProfile(selectedProviderId)
      .then((models) => {
        if (cancelled) return;
        setProviderModels(models.map((m) => ({ id: m.id, label: m.label || m.id, contextLength: m.contextLength })));
        const defaultModel = providers.find((p) => p.id === selectedProviderId)?.defaultModel ?? "";
        setSelectedModel((cur) => cur || defaultModel || models[0]?.id || "");
      })
      .catch((err) => { if (!cancelled) toast.error(err instanceof Error ? err.message : t("models_load_failed")); })
      .finally(() => { if (!cancelled) setIsLoadingModels(false); });
    return () => { cancelled = true; };
  }, [isOpen, onFetchModelsForProfile, providers, selectedProviderId, t]);

  /* ─── early return ─── */
  if (!isOpen) return null;

  /* ─── helpers ─── */
  function selectSummary(s: ChatSummaryRecord, openDirty = false) {
    setActiveSummaryId(s.id);
    setDraftText(s.content);
    setDraftLabel(s.label);
    setRangeFrom(clamp(s.summarizedFrom, 1, maxMessage));
    setRangeTo(clamp(Math.max(s.summarizedTo, s.summarizedFrom), 1, maxMessage));
    setIncludeInContext(s.includeInContext);
    setExcludeSummarized(s.excludeSummarized);
    setDirty(openDirty);
  }

  function startNewSummary() {
    setActiveSummaryId(null);
    setDraftText("");
    setDraftLabel(`T1\u2013T${maxMessage}`);
    setRangeFrom(1);
    setRangeTo(maxMessage);
    setIncludeInContext(true);
    setExcludeSummarized(true);
    setDirty(false);
  }

  async function createNewSummary(openDetail?: () => void) {
    if (!activeChatId) return;
    setSaving(true);
    try {
      const saved = await createChatSummaryAction(activeChatId, {
        label: `T1\u2013T${maxMessage}`,
        content: "",
        summarizedFrom: 1,
        summarizedTo: maxMessage,
        includeInContext: true,
        excludeSummarized: true,
        source: "manual",
      });
      setSummaries((prev) => upsertSummary(prev, saved));
      selectSummary(saved);
      if (openDetail) openDetail();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  function handleRangeChange(nextFrom: number, nextTo: number) {
    setRangeFrom(clamp(nextFrom, 1, maxMessage));
    setRangeTo(clamp(nextTo, 1, maxMessage));
    setDirty(true);
  }

  async function handleSave() {
    if (!activeChatId) return;
    setSaving(true);
    try {
      const payload = {
        label: draftLabel.trim() || `T${rangeFrom}\u2013T${rangeTo}`,
        content: draftText,
        summarizedFrom: rangeFrom,
        summarizedTo: rangeTo,
        includeInContext,
        excludeSummarized,
      };
      const saved = activeSummaryId
        ? await updateChatSummaryAction(activeChatId, activeSummaryId, payload)
        : await createChatSummaryAction(activeChatId, payload);
      setSummaries((prev) => upsertSummary(prev, saved));
      selectSummary(saved);
      toast.success(t("save_summary_btn"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerate() {
    if (!activeChatId || !effectiveProviderId || !effectiveModel) {
      toast.error(t("select_provider_error"));
      return;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setGenerating(true);
    try {
      const generated = await generateChatSummaryAction(activeChatId, {
        providerProfileId: effectiveProviderId,
        model: effectiveModel,
        summarizedFrom: rangeFrom,
        summarizedTo: rangeTo,
        targetSummaryId: activeSummaryId ?? undefined,
        label: draftLabel.trim() || `T${rangeFrom}\u2013T${rangeTo}`,
        includeInContext,
        excludeSummarized,
      }, abort.signal);
      setSummaries((prev) => upsertSummary(prev, generated));
      selectSummary(generated);
    } catch (err) {
      if (!abort.signal.aborted) toast.error(err instanceof Error ? err.message : t("summarization_failed"));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDelete(summaryId: string) {
    if (!activeChatId) return;
    try {
      await deleteChatSummaryAction(activeChatId, summaryId);
      const next = summaries.filter((s) => s.id !== summaryId);
      setSummaries(next);
      if (summaryId === activeSummaryId) {
        if (next[0]) selectSummary(next[0]); else startNewSummary();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    }
  }

  async function patchSummary(summary: ChatSummaryRecord, patch: Partial<ChatSummaryRecord>) {
    if (!activeChatId) return;
    const updated = await updateChatSummaryAction(activeChatId, summary.id, patch);
    setSummaries((prev) => upsertSummary(prev, updated));
    if (summary.id === activeSummaryId) selectSummary(updated);
  }

  async function commitMemorySettings(next?: { historyLimit?: number; autoConfig?: AutoSummaryConfig }) {
    if (!activeChatId) return;
    const nextHL = next?.historyLimit ?? historyLimit;
    const nextAC = next?.autoConfig ?? autoConfig;
    setHistoryLimit(nextHL);
    setAutoConfig(nextAC);
    try {
      await updateMemorySettingsAction(activeChatId, {
        messageHistoryLimit: Math.max(0, Math.floor(nextHL)),
        autoSummaryConfig: nextAC,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("summary_save_failed"));
    }
  }

  /* ─── archive sidebar / list ─── */
  const archiveList = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {loading && <div className="px-4 py-3 font-ui text-xs text-t3">{t("loading_models")}</div>}
      {!loading && summaries.length === 0 && <div className="px-4 py-3 font-ui text-xs text-t4">{t("no_saved_summaries")}</div>}
      {summaries.map((s) => (
        <div
          key={s.id}
          className={cn(
            "group flex cursor-pointer items-center gap-2 border-l-2 border-l-transparent px-3 min-h-[56px] transition-colors touch-manipulation hover:bg-s2",
            activeSummaryId === s.id && "border-l-accent bg-accent-dim",
          )}
          onPointerDown={() => selectSummary(s)}
        >
          <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <Toggle
              checked={s.includeInContext}
              onChange={() => void patchSummary(s, { includeInContext: !s.includeInContext })}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-ui text-[12px] text-t1">{s.label || `T${s.summarizedFrom}\u2013T${s.summarizedTo}`}</div>
            <div className="mt-0.5 font-ui text-[10px] text-t4">{s.source === "auto" ? t("summary_source_auto") : t("summary_source_manual")}</div>
          </div>
          <MasterDetailMobileDrillDown onSelect={() => selectSummary(s)} />
          <button type="button"
            className="hidden md:flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 opacity-0 hover:bg-danger-dim hover:text-danger-text group-hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); void handleDelete(s.id); }}
          >
            <Ic.close />
          </button>
        </div>
      ))}
    </div>
  );

  /* ─── detail editor (shared between desktop main & mobile drill) ─── */
  const detailEditor = (
    <>
      {/* ── Range ── */}
      <section>
        <div className={labelCls}>{t("summary_range_label")}</div>
        <div className="rounded-lg border border-border bg-bg p-4">
          <DualRangeSlider min={1} max={maxMessage} from={rangeFrom} to={rangeTo} disabled={generating} onChange={handleRangeChange} />
          <div className="flex items-center justify-between font-ui text-[11px] text-t4">
            <span>{t("summary_msg_label").replace("{n}", String(rangeFrom))}</span>
            <span className="rounded-full bg-accent-dim px-2 py-1 text-accent-t">
              {t("summary_messages_count").replace("{count}", String(Math.max(0, rangeTo - rangeFrom + 1)))}
            </span>
            <span>{t("summary_msg_label").replace("{n}", String(rangeTo))}</span>
          </div>
        </div>
      </section>

      {/* ── Exclude toggle ── */}
      <label className="mt-3 flex items-center gap-2 font-ui text-[13px] text-t2">
        <Toggle checked={excludeSummarized} onChange={(v) => { setExcludeSummarized(v); setDirty(true); }} />
        {t("summary_exclude_toggle")}
      </label>

      {/* ── Summary text ── */}
      <section className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className={cn(labelCls, "mb-0")}>{t("summary_text_label")}</div>
          <div className="flex gap-2">
            {activeSummaryId && isMobile && (
              <button type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md bg-danger-dim text-danger-text hover:bg-danger hover:text-white transition-colors md:hidden"
                onClick={() => { 
                  void handleDelete(activeSummaryId); 
                }}
                title={t("delete")}
              >
                <Icons.Trash />
              </button>
            )}
            <button type="button"
              className="h-7 rounded-md bg-s3 px-3 font-ui text-xs text-t2 hover:bg-border2 hover:text-t1 disabled:opacity-40"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
            >
              {saving ? t("saving_btn") : t("save_summary_btn")}
            </button>
          </div>
        </div>
        <input
          className={cn(inputCls, "mb-2 w-full")}
          value={draftLabel}
          onChange={(e) => { setDraftLabel(e.target.value); setDirty(true); }}
          placeholder={`T${rangeFrom}\u2013T${rangeTo}`}
        />
        <MobileExpandTextarea value={draftText} onChange={(v) => { setDraftText(v); setDirty(true); }} label={t("summary_text_label")}>
          <AutoTextarea
            className={cn(inputCls, "min-h-[86px] w-full resize-y leading-relaxed")}
            style={{}}
            maxHeight={400}
            value={draftText}
            onChange={(e) => { setDraftText(e.target.value); setDirty(true); }}
            placeholder={t("summary_placeholder_short")}
          />
        </MobileExpandTextarea>
        <div className="mt-1 text-right font-ui text-[11px] text-t4">{tokenEstimate.summaryTokens}t</div>
      </section>

      {/* ── Token estimate ── */}
      <section className="mt-3 rounded-lg border border-border bg-bg p-4">
        <div className="mb-2 font-ui text-[12px] text-t3">
          {t("summary_token_line")
            .replace("{summary}", String(tokenEstimate.summaryTokens))
            .replace("{history}", String(tokenEstimate.historyTokens))
            .replace("{total}", String(tokenEstimate.total))}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-s3">
          <div className="h-full bg-accent transition-all" style={{ width: `${tokenEstimate.total > 0 ? Math.min(100, Math.round((tokenEstimate.summaryTokens / tokenEstimate.total) * 100)) : 0}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between font-ui text-[11px] text-t4">
          <span>{t("summary_without_line").replace("{tokens}", String(tokenEstimate.selectedRawTokens))}</span>
          <span className="text-success-text">{t("summary_saved_line").replace("{tokens}", String(tokenEstimate.saved)).replace("{pct}", String(tokenEstimate.pct))}</span>
        </div>
      </section>

      {/* ── Provider & Model ── */}
      <section className="mt-4">
        <div className={labelCls}>{t("summary_provider_label")}</div>
        <label className="mb-3 flex items-center gap-2 font-ui text-[13px] text-t2">
          <Toggle checked={useChatModel} onChange={(v) => setUseChatModel(v)} />
          {t("summary_use_chat_model")}
        </label>
        <div className={cn("gap-3", isMobile ? "flex flex-col" : "grid grid-cols-2")}>
          <DropdownSelect
            value={selectedProviderId}
            options={providerOptions}
            onChange={(id) => { setSelectedProviderId(id); setSelectedModel(""); setPinnedModel(null); }}
            disabled={useChatModel || generating}
            placeholder={t("summarize_provider_label")}
            searchPlaceholder={t("summarize_provider_label")}
          />
          <div className="flex items-center gap-1.5">
            <DropdownSelect
              value={pinnedModel ?? selectedModel}
              options={modelOptions}
              onChange={(id) => { setSelectedModel(id); setPinnedModel(useChatModel ? id : null); }}
              disabled={useChatModel || generating || isLoadingModels}
              placeholder={t("model_placeholder")}
              searchPlaceholder={t("summarize_model_label")}
              className="flex-1"
            />
            {/* Pin star: lock this model even when "use chat model" is on */}
            <button type="button"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
                pinnedModel ? "border-accent bg-accent-dim text-accent" : "border-border text-t4 hover:text-t3",
              )}
              title={pinnedModel ? t("summary_unpin_model") : t("summary_pin_model")}
              onClick={() => { if (pinnedModel) setPinnedModel(null); else if (selectedModel) setPinnedModel(selectedModel); }}
              disabled={!selectedModel}
            >
              {pinnedModel ? <Ic.starFilled /> : <Ic.star />}
            </button>
          </div>
        </div>
        {generating ? (
          <button type="button"
            className="mt-3 h-10 w-full rounded-md bg-danger px-4 font-ui text-sm font-semibold text-white transition-all hover:brightness-110"
            onClick={() => abortRef.current?.abort()}
          >
            {t("summary_stop_btn")}
          </button>
        ) : (
          <button type="button"
            className="mt-3 h-10 w-full rounded-md bg-accent px-4 font-ui text-sm font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
            disabled={!activeChatId || !effectiveProviderId || !effectiveModel}
            onClick={() => void handleGenerate()}
          >
            {t("summary_generate_range").replace("{from}", String(rangeFrom)).replace("{to}", String(rangeTo))}
          </button>
        )}
      </section>

      {/* ── Auto-summary ── */}
      <section className="mt-4 rounded-lg border border-border bg-bg p-4">
        <label className="flex items-center gap-2 font-ui text-[13px] text-t2">
          <Toggle
            checked={autoConfig.enabled}
            onChange={(v) => void commitMemorySettings({ autoConfig: { ...autoConfig, enabled: v } })}
          />
          {t("summary_auto_toggle")}
        </label>
        <div className="mt-3 flex items-center gap-2 font-ui text-[12px] text-t3">
          <span>{t("summary_auto_every")}</span>
          <NumberInput
            className="w-[80px] shrink-0"
            inputClassName="text-center"
            hideControls
            min={1}
            max={500}
            value={autoConfig.everyN}
            onChange={(v) => setAutoConfig({ ...autoConfig, everyN: v })}
            onBlur={() => void commitMemorySettings()}
          />
          <span>{t("summary_auto_messages")}</span>
        </div>
        <label className="mt-3 flex items-center gap-2 font-ui text-[13px] text-t2">
          <Toggle
            checked={autoConfig.excludeSummarized}
            onChange={(v) => void commitMemorySettings({ autoConfig: { ...autoConfig, excludeSummarized: v } })}
          />
          {t("summary_auto_exclude_toggle")}
        </label>
      </section>

      {/* ── Messages in prompt (mobile: moved here from footer) ── */}
      {isMobile && (
        <section className="mt-4 rounded-lg border border-border bg-bg p-4">
          <div className={labelCls}>{t("summary_messages_in_prompt")}</div>
          <div className="flex items-center gap-3">
            <input
              className="accent-accent flex-1"
              type="range" min={0} max={Math.max(1, messageCount)}
              value={Math.min(historyLimit, Math.max(1, messageCount))}
              onChange={(e) => setHistoryLimit(Number(e.target.value))}
              onMouseUp={() => void commitMemorySettings()}
              onTouchEnd={() => void commitMemorySettings()}
            />
            <NumberInput
              className="w-[80px] shrink-0"
              inputClassName="text-center"
              hideControls
              min={0}
              max={Math.max(1, messageCount)}
              value={historyLimit}
              onChange={(v) => setHistoryLimit(v)}
              onBlur={() => void commitMemorySettings()}
            />
          </div>
        </section>
      )}
    </>
  );

  /* ─── footer ─── */
  const footer = (
    <div className="shrink-0 border-t border-border px-5 py-3 space-y-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
      {/* Row 1: context bar + token stats */}
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-s3">
          <div className="h-full bg-accent transition-all" style={{ width: `${contextPct}%` }} />
        </div>
        <div className="shrink-0 font-ui text-[11px] text-t3 tabular-nums">{contextWindow.used} / {contextWindow.limit}t ({contextPct}%)</div>
      </div>
      {/* Row 2: messages-in-prompt slider (desktop only) */}
      {!isMobile && (
        <div className="flex items-center gap-3">
          <span className="shrink-0 font-ui text-[11px] text-t3">{t("summary_messages_in_prompt")}</span>
          <input
            className="accent-accent flex-1"
            type="range" min={0} max={Math.max(1, messageCount)}
            value={Math.min(historyLimit, Math.max(1, messageCount))}
            onChange={(e) => setHistoryLimit(Number(e.target.value))}
            onMouseUp={() => void commitMemorySettings()}
            onTouchEnd={() => void commitMemorySettings()}
          />
          <NumberInput
            className="w-[80px] shrink-0"
            inputClassName="text-center"
            hideControls
            min={0}
            max={Math.max(1, messageCount)}
            value={historyLimit}
            onChange={(v) => setHistoryLimit(v)}
            onBlur={() => void commitMemorySettings()}
          />
        </div>
      )}
    </div>
  );

  /* ─── RENDER ─── */
  return (
    <MasterDetailModal
      isOpen={true}
      onClose={onClose}
      title={t("context_memory_title")}
      subtitle={t("context_memory_sub")}
      detailTitle={activeSummary?.label || draftLabel || t("new_summary_entry")}
      dirty={dirty}
      containerClassName="h-[min(86vh,780px)] w-[min(920px,calc(100vw-32px))] rounded-xl border border-border2 shadow-[0_24px_60px_rgba(0,0,0,.5)]"
      masterClassName="flex w-[240px] shrink-0 flex-col border-r border-border bg-s1"
      detailClassName="p-5"
      headerBottom={
        !isMobile && (
          <div className="mt-4 flex gap-0 px-6">
            <div className="border-b-2 border-b-accent px-4 py-2 font-ui text-xs font-medium text-accent-t">{t("memory_tab_summary")}</div>
          </div>
        )
      }
      masterContent={() => (
        <div className="flex flex-col min-h-0 h-full">
          <div className="px-4 py-4 font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t3">{t("summary_archive_label")}</div>
          {archiveList}
          <div className="border-t border-border p-3 mt-auto">
            <button type="button"
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border2 py-2 font-ui text-xs text-t3 hover:border-border hover:bg-s2 hover:text-t1"
              onClick={() => void createNewSummary()}
              disabled={!activeChatId || saving}
            >
              <Icons.Plus /> {t("new_summary_entry")}
            </button>
          </div>
        </div>
      )}
      detailContent={detailEditor}
      footer={footer}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function upsertSummary(list: ChatSummaryRecord[], summary: ChatSummaryRecord): ChatSummaryRecord[] {
  const idx = list.findIndex((item) => item.id === summary.id);
  if (idx < 0) return [...list, summary].sort((a, b) => a.summarizedFrom - b.summarizedFrom || a.createdAt.localeCompare(b.createdAt));
  const next = [...list];
  next[idx] = summary;
  return next;
}
