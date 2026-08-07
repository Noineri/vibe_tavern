import { useState } from "react";
import { PersonaQuickSwitch } from "../modals/PersonaQuickSwitch.js";
import { TokenCounterPopover } from "../shared/TokenCounterPopover.js";
import { ToolbarSelect } from "../shared/ToolbarSelect.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

import { AttachmentPreview } from "./AttachmentPreview.js";
import { ChatImpersonateAiPill } from "./ChatImpersonateAiPill.js";
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
    if (file && file.type.startsWith("image/")) {
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
          <input type="file" ref={fileInputRef} className="hidden" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onFileInputChange} />

          <AutoTextarea
            className="w-full resize-none border-0 bg-transparent px-4 pt-[13px] pb-2 font-body text-[15.5px] leading-tight text-t1 outline-none placeholder:text-t4"
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

          <div className="relative flex items-center gap-[7px] pt-1.5 pb-[9px] pl-3 pr-[135px]">
            <CustomTooltip content={t("multi_persona_tooltip")}>
              <div className="speaker-row multi-persona">
                <span className="text-[calc(var(--ui-fs)-3px)] uppercase tracking-[0.06em] text-t3">{t("speak_as")}</span>
              </div>
            </CustomTooltip>
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
