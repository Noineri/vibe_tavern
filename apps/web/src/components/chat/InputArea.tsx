import { useState, useEffect, useRef } from "react";
import { PersonaQuickSwitch } from "../modals/PersonaQuickSwitch.js";
import { TokenCounterPopover } from "../shared/TokenCounterPopover.js";
import { ToolbarSelect } from "../shared/ToolbarSelect.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { cn } from "../../lib/cn.js";
import { composerCls } from "../../lib/field-tokens.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { usePerSendPrefillStore } from "../../stores/per-send-prefill-store.js";

import { AttachmentPreview } from "./AttachmentPreview.js";
import { ChatImpersonateAiPill } from "./ChatImpersonateAiPill.js";
import { DictationButton } from "./DictationButton.js";
import { VoiceMessageButton } from "./VoiceMessageButton.js";
import { MobileInputArea } from "./MobileInputArea.js";
import { QuotaIndicator } from "./QuotaIndicator.js";
import { useInputArea } from "./use-input-area.js";

export function InputArea() {
  const data = useInputArea();
  const isMobile = useIsMobile();

  if (isMobile) return <MobileInputArea data={data} />;
  return <DesktopInputArea data={data} />;
}

function DesktopInputArea({ data }: { data: ReturnType<typeof useInputArea> }) {
  const {
    t, chat, character, provider,
    draft, setDraft, isSending, activeChatId, chatMeta,
    personas, activePersonaId,
    contextSize, maxTokens, favoriteModels, activeModelId,
    fileInputRef, draftAttachments, onFileInputChange, handlePaste, canSend,
    buckets, inputTokens, showGenerateMore, handleGenerateMore,
  } = data;

  const [isDragOver, setIsDragOver] = useState(false);
  // ── Per-send prefill (LS-8, owner design): a labeled chip (human icon +
  // «префилл») in the chip row opens the one-shot prefill input as a BUBBLE
  // inside the input frame, DIRECTLY ABOVE the chip row (owner correction
  // 2026-09-09: chat line → bubble → chip row). Sending consumes the store
  // value (one-shot); any transition to disarmed collapses the bubble.
  const [prefillOpen, setPrefillOpen] = useState(false);
  const prefillValue = usePerSendPrefillStore((s) => s.value);
  const setPrefillValue = usePerSendPrefillStore((s) => s.setValue);
  const prefillWasArmedRef = useRef(false);
  const prefillArmed = prefillValue !== null;
  useEffect(() => {
    if (prefillOpen && prefillArmed === false && prefillWasArmedRef.current) setPrefillOpen(false);
    prefillWasArmedRef.current = prefillArmed;
  }, [prefillArmed, prefillOpen]);
  // --- Drag-and-drop image attach (desktop only) ---
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type.startsWith("image/") || file.type.startsWith("audio/"))) {
      void data.handleFileSelected(file);
    }
  };

  // Render helpers
  function renderSendLabel(): string {
    if (isSending) return t("sending");
    if (data.canUseLiveApi && draft.trim()) return t("send_message");
    if (!data.canUseLiveApi) return t("send_unavailable");
    return t("type_a_message");
  }
  const sendLabel = renderSendLabel();
  const sendButtonText = canSend || !draft.trim() ? t("send") : sendLabel || t("send_unavailable");

  const permanent = buckets.system + buckets.character + buckets.persona + buckets.lore + buckets.memory + buckets.tools;
  const totalUsed = permanent + buckets.history + inputTokens;
  const availableBudget = Math.max(0, contextSize - maxTokens);
  const usageRatio = availableBudget > 0 ? totalUsed / availableBudget : 0;
  const tokenState = usageRatio > 0.95 ? "warn" : usageRatio > 0.75 ? "mid" : "ok";

  return (
    <div
        className="relative z-10 shrink-0 border-t border-border bg-surface px-4 pt-2.5 pb-3.5 transition-opacity duration-200"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
          {/* LS-8: per-send prefill renders as a chip + in-frame bubble (below);
            the desktop LS-4b strip is retired. Both gated upstream on the
            capability AND the active preset's opt-in toggle. */}
        <div className="relative rounded-lg border border-border bg-input-bg transition-colors duration-150 focus-within:border-border2">
          {showGenerateMore && (
            <div className="absolute right-2 top-2 z-20">
              <CustomTooltip content={t("generate_more_tooltip")}>
                <button type="button"
                  onClick={handleGenerateMore}
                  className="flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-border2 bg-s2 px-2.5 py-1 font-ui text-[12px] font-medium text-t2 transition-colors duration-150 hover:bg-s3 hover:text-t1"
                >
                  <Icons.Plus />
                  <span>{t("generate_more_label")}</span>
                </button>
              </CustomTooltip>
            </div>
          )}
          {isDragOver && (
            <div className="pointer-events-none absolute inset-0 z-[100] flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/5">
              <span className="flex items-center gap-2 font-ui text-[15px] font-medium text-accent">
                <Icons.target /> {t("drop_image_here")}
              </span>
            </div>
          )}
          <input type="file" ref={fileInputRef} className="hidden" accept="image/png,image/jpeg,image/webp,image/gif,audio/webm,audio/ogg,audio/mp4,audio/x-m4a,audio/mpeg,audio/mp3,audio/wav,audio/flac" onChange={onFileInputChange} />

          {/* LS-8: the one-shot prefill bubble lives below (directly above the
              chip row — owner design 2026-09-09). */}

          <AutoTextarea
            className={cn(composerCls, "w-full !px-4 !pt-[13px] !pb-2 !text-[15.5px] !leading-tight")}
            maxRows={12}
            minRows={3}
            placeholder={t("placeholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSend) void chat.handleSend();
              }
            }}
          />

          {draftAttachments.length > 0 && <AttachmentPreview />}

          {/* LS-8: the one-shot prefill bubble — a text-entry bubble INSIDE
              the input frame, DIRECTLY ABOVE the chip row (owner design
              2026-09-09: chat line → bubble → chip row). Smooth grid-rows
              collapse; ✕ closes without clearing (the armed dot stays). */}
          {data.perSendPrefillSupported && (
            <div
              className="grid pl-3 pr-[135px] pt-2 transition-[grid-template-rows,opacity] duration-200 ease-out"
              style={{ gridTemplateRows: prefillOpen ? "1fr" : "0fr", opacity: prefillOpen ? 1 : 0 }}
              aria-hidden={!prefillOpen}
              data-testid="per-send-prefill-bubble"
            >
              <div className="overflow-hidden pb-1.5">
                <div className="flex items-start gap-1.5 rounded-lg border border-border bg-s2 px-2.5 py-1.5">
                  <AutoTextarea
                    className="min-w-0 flex-1 resize-none border-0 bg-transparent font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none placeholder:text-t4"
                    minRows={1}
                    maxRows={6}
                    value={prefillValue ?? ""}
                    onChange={(e) => setPrefillValue(e.target.value)}
                    placeholder={t("prefill_placeholder")}
                    aria-label={t("per_send_prefill_chip_tooltip")}
                    data-testid="per-send-prefill-input"
                  />
                  <button
                    type="button"
                    className="mt-0.5 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-colors hover:bg-s3 hover:text-t1"
                    onClick={() => setPrefillOpen(false)}
                    aria-label={t("close")}
                  >
                    <Icons.close />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="relative flex items-center gap-[7px] pt-1.5 pb-[9px] pl-3 pr-[135px]">
            {/* LS-8: the per-send prefill chip (human icon + label) — replaces
                the retired «Говорить как» text label; the stale multi-persona
                tooltip (a mode VT does not have) goes with it. The persona
                button itself is untouched. */}
            {data.perSendPrefillSupported && (
              <CustomTooltip content={t("per_send_prefill_chip_tooltip")}>
                <button
                  type="button"
                  className="relative flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-t3 transition-colors hover:bg-s2 hover:text-t1"
                  onClick={() => setPrefillOpen((v) => !v)}
                  aria-expanded={prefillOpen}
                  aria-label={t("per_send_prefill_chip_tooltip")}
                  data-testid="per-send-prefill-chip"
                >
                  <Icons.user />
                  <span className="font-ui text-[12px]">{t("per_send_prefill_chip_label")}</span>
                  {prefillArmed && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
                </button>
              </CustomTooltip>
            )}
            <PersonaQuickSwitch personas={personas} activePersonaId={activePersonaId} onSelect={character.handleSetChatPersona} />
            {activeChatId && (
              <ChatImpersonateAiPill
                activeChatId={activeChatId}
                characterId={chatMeta?.character.id ?? null}
                personaId={activePersonaId}
                setDraft={setDraft}
              />
            )}
            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />

            <CustomTooltip content={t("attach_image")}>
              <button
                type="button"
                className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-45"
                onClick={() => fileInputRef.current?.click()}
                disabled={draftAttachments.length >= 5}
              >
                <Icons.paperclip />
              </button>
            </CustomTooltip>

            <DictationButton
              draft={draft}
              setDraft={setDraft}
              send={() => void chat.handleSend()}
              canSend={canSend}
            />

            <VoiceMessageButton onRecorded={data.handleVoiceRecorded} />

            <TokenCounterPopover
              permanent={permanent}
              history={buckets.history}
              inputTokens={inputTokens}
              contextSize={contextSize}
              maxTokens={maxTokens}
              availableBudget={availableBudget}
              tokenState={tokenState}
              permanentItems={[
                { label: t("context_system"), value: buckets.system },
                { label: t("context_character"), value: buckets.character },
                { label: t("context_persona"), value: buckets.persona },
                { label: t("context_lore"), value: buckets.lore },
                { label: t("context_memory"), value: buckets.memory },
                { label: t("context_tools"), value: buckets.tools },
              ]}
            />

            <QuotaIndicator providerProfileId={provider.activeProviderProfile?.id ?? null} />

            <div className="absolute right-3 bottom-[9px] flex items-center gap-[9px]">
                <ToolbarSelect
                  title={t("starred_models")}
                  triggerTooltip={t("starred_models")}
                  contentWidth={260}
                  emptyText={t("no_starred_models")}
                  items={favoriteModels.map((m) => ({ value: m.modelId, label: m.label || m.modelId }))}
                  value={activeModelId}
                  onSelect={(modelId) => {
                    if (provider.activeProviderProfile) void provider.handleSelectFavoriteProviderModel(provider.activeProviderProfile.id, modelId);
                  }}
                  trigger={
                    <button type="button"
                      className="flex h-8 items-center justify-center rounded-[5px] bg-s2 px-2.5 text-warning-text transition-colors hover:bg-s3 hover:brightness-110 data-[state=open]:brightness-110"
                    >
                      <Icons.StarFilled />
                    </button>
                  }
                />
              {isSending ? (
                <button type="button"
                  className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[5px] border border-danger bg-surface px-3.5 font-ui text-[12.5px] font-medium text-danger-text transition-colors duration-150 hover:bg-danger-dim disabled:cursor-default disabled:opacity-60"
                  onClick={chat.handleCancelGeneration}
                >
                  {t("cancel")}
                </button>
              ) : (
                <CustomTooltip content={sendLabel}>
                  <button type="button"
                    className="flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-accent px-4 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all duration-150 hover:brightness-110 disabled:cursor-default disabled:opacity-45 disabled:filter-none"
                    disabled={!canSend}
                    onClick={() => void chat.handleSend()}
                    aria-label={sendLabel}
                  >
                    {sendButtonText}
                  </button>
                </CustomTooltip>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
