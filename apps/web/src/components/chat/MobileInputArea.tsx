// Mobile chat input — a compact two-row surface (toolbar row with
// persona / impersonate / attach / preset / starred-models pills, then the
// textarea + send row). Extracted from InputArea.tsx so the viewport fork is
// a presentational split: this file owns only mobile-specific UI state
// (the three BottomSheet open-flags and the auto-grow textarea ref); all
// shared data comes from useInputArea().
//
// The three pickers (persona / starred-models / preset) are BottomSheets per
// the project rule that every mobile popover surfaces as a bottom sheet.

import { useEffect, useRef, useState } from "react";
import { Icons } from "../shared/icons.js";
import { cn } from "../../lib/cn.js";
import { resolveEntityAvatarUrl } from "../../lib/avatar.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { ChatImpersonateAiPill } from "./ChatImpersonateAiPill.js";
import { DictationButton } from "./DictationButton.js";
import { useModalStore } from "../../stores/modal-store.js";
import { useInputArea, type InputAreaData } from "./use-input-area.js";

export function MobileInputArea({ data }: { data: InputAreaData }) {
  const {
    t, chat, character, provider, preset,
    draft, setDraft, isSending, activeChatId, chatMeta,
    personas, activePersonaId, promptPresets, activePromptPresetId,
    favoriteModels, activeModelId,
    fileInputRef, draftAttachments, onFileInputChange, handlePaste, canSend,
    showGenerateMore, handleGenerateMore,
  } = data;

  const [mobilePersonaOpen, setMobilePersonaOpen] = useState(false);
  const [modelDropOpen, setModelDropOpen] = useState(false);
  const [presetDropOpen, setPresetDropOpen] = useState(false);

  // ── Auto-expand textarea ──
  const mobileTextareaRef = useRef<HTMLTextAreaElement>(null);
  const adjustTextareaHeight = () => {
    const ta = mobileTextareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
    }
  };
  // Shrink textarea back when draft is cleared (after send)
  useEffect(() => {
    if (!draft) adjustTextareaHeight();
  }, [draft]);

  return (
    <div className={cn(
      "relative z-10 shrink-0 border-t border-border bg-surface px-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pt-2",
      activeChatId ? '' : 'pointer-events-none opacity-45'
    )}>
      <div className="flex flex-col gap-1.5 rounded-xl bg-s2 p-1.5">
        {/* Toolbar row: persona + starred models */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setMobilePersonaOpen(true)} className="flex h-9 items-center gap-1.5 rounded-md bg-s3 px-2 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 active:bg-s2">
            {activePersonaId ? (
              <PersonaAvatar src={(() => { const p = personas.find(p => p.id === activePersonaId); return p ? resolveEntityAvatarUrl({ kind: "personas", id: p.id, avatarExt: p.avatarExt, avatarAssetId: p.avatarAssetId, updatedAt: p.updatedAt }) : null; })()}  size={20} />
            ) : (
              <Icons.User />
            )}
            <span className="max-w-[120px] min-w-0 truncate">{activePersonaId ? (personas.find(p => p.id === activePersonaId)?.name ?? t("no_persona")) : t("no_persona")}</span>
            <Icons.Caret direction="d" />
          </button>
          {activeChatId && (
            <ChatImpersonateAiPill
              activeChatId={activeChatId}
              characterId={chatMeta?.character.id ?? null}
              personaId={activePersonaId}
              setDraft={setDraft}
              size="lg"
            />
          )}

          <button
            type="button"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-s3 text-t3 transition-colors active:bg-s2 disabled:opacity-45"
            onClick={() => fileInputRef.current?.click()}
            disabled={draftAttachments.length >= 5}
          >
            <Icons.paperclip />
          </button>

          <DictationButton
            draft={draft}
            setDraft={setDraft}
            send={() => void chat.handleSend()}
            canSend={canSend}
          />

          <button type="button" onClick={() => setPresetDropOpen(true)} className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-accent-t active:bg-s2 disabled:opacity-45" disabled={promptPresets.length === 0}>
            <Icons.FileText />
          </button>

          <button type="button" onClick={() => setModelDropOpen(true)} className="flex h-9 w-9 items-center justify-center rounded-md bg-s3 text-warning-text active:bg-s2">
            <Icons.StarFilled />
          </button>
        </div>
        {draftAttachments.length > 0 && <AttachmentPreview />}
        {/* Input row */}
        <div className="flex items-end gap-2">
          <input type="file" ref={fileInputRef} className="hidden" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onFileInputChange} />
          <textarea
            ref={mobileTextareaRef}
            className="max-h-[40vh] min-h-[44px] flex-1 resize-none border-0 bg-transparent py-2 pr-1 font-body text-[15px] leading-[1.4] text-t1 outline-none placeholder:text-t4 overflow-y-auto"
            placeholder={t("placeholder")}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); adjustTextareaHeight(); }}
            onPaste={handlePaste}
            rows={1}
          />
          <div className="flex shrink-0 items-center gap-2">
            {showGenerateMore && (
              <button type="button"
                onClick={handleGenerateMore}
                title={t("generate_more_tooltip")}
                className="flex h-9 items-center gap-1 whitespace-nowrap rounded-lg border border-border2 bg-s3 px-2.5 font-ui text-[12px] font-medium text-t2 active:bg-s2"
              >
                <Icons.Plus />
                <span>{t("generate_more_label")}</span>
              </button>
            )}
            {isSending ? (
              <button type="button" className="flex h-9 w-9 items-center justify-center rounded-lg border border-danger text-danger-text active:bg-danger/10" onClick={chat.handleCancelGeneration}>
                <span className="text-[11px] font-bold">✕</span>
              </button>
            ) : (
              <button type="button" className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-45 active:scale-95" disabled={!canSend} onClick={() => void chat.handleSend()}>
                <Icons.Caret direction="r" />
              </button>
            )}
          </div>
        </div>
      </div>
      <BottomSheet open={mobilePersonaOpen} onClose={() => setMobilePersonaOpen(false)} title={t("persona_selection")}>
        <div className="max-h-[50vh] overflow-y-auto">
          {personas.map(p => (
            <button type="button" key={p.id} className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3" onClick={() => { void character.handleSetChatPersona(p.id); setMobilePersonaOpen(false); }}>
              <div className="w-5 shrink-0 flex justify-center text-accent-t">{activePersonaId === p.id && <Icons.Check />}</div>
              <PersonaAvatar src={resolveEntityAvatarUrl({ kind: "personas", id: p.id, avatarExt: p.avatarExt, avatarAssetId: p.avatarAssetId, updatedAt: p.updatedAt })} size={26} />
              <div className="min-w-0 truncate">{p.name}</div>
            </button>
          ))}
        </div>
        <div className="mt-1 border-t border-border px-3 pt-1">
          <button type="button" className="flex w-full min-h-[52px] cursor-pointer items-center gap-4 rounded-md px-2 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3" onClick={() => { setMobilePersonaOpen(false); useModalStore.getState().setIsPersonaModalOpen(true); }}>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-s2"><Icons.Edit /></span>
            <span className="font-ui">{t("manage_personas")}</span>
          </button>
        </div>
        <div className="mx-4 mt-2 h-px bg-border" />
        <button type="button" className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3" onClick={() => setMobilePersonaOpen(false)}>
          {t("cancel")}
        </button>
      </BottomSheet>
      <BottomSheet open={modelDropOpen} onClose={() => setModelDropOpen(false)} title={t("starred_models")}>
        {favoriteModels.length > 0 ? (
          <div className="max-h-[50vh] overflow-y-auto">
            {favoriteModels.map(model => (
              <button type="button" key={model.modelId} className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3" onClick={() => { if (provider.activeProviderProfile) void provider.handleSelectFavoriteProviderModel(provider.activeProviderProfile.id, model.modelId); setModelDropOpen(false); }}>
                <div className="w-5 shrink-0 flex justify-center text-accent-t">{activeModelId === model.modelId && <Icons.Check />}</div>
                <div className="min-w-0 truncate">{model.label || model.modelId}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-5 py-4 text-[calc(var(--ui-fs)-1px)] text-t3">{t("no_starred_models")}</div>
        )}
        <div className="mx-4 mt-2 h-px bg-border" />
        <button type="button" className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3" onClick={() => setModelDropOpen(false)}>
          {t("cancel")}
        </button>
      </BottomSheet>
      <BottomSheet open={presetDropOpen} onClose={() => setPresetDropOpen(false)} title={t("topbar_prompt_preset")}>
        <div className="max-h-[50vh] overflow-y-auto">
          {promptPresets.map(p => (
            <button type="button" key={p.id} className="flex w-full min-h-[52px] cursor-pointer items-center gap-3 px-5 text-[calc(var(--ui-fs)+1px)] text-t2 active:bg-s3" onClick={() => { void preset.handleSetActivePromptPresetId(p.id); setPresetDropOpen(false); }}>
              <div className="w-5 shrink-0 flex justify-center text-accent-t">{p.id === activePromptPresetId && <Icons.Check />}</div>
              <div className="min-w-0 truncate">{p.name}</div>
            </button>
          ))}
        </div>
        <div className="mx-4 mt-2 h-px bg-border" />
        <button type="button" className="flex w-full min-h-[52px] cursor-pointer items-center justify-center rounded-b-2xl text-[calc(var(--ui-fs)+1px)] font-medium text-t3 transition-colors active:bg-s3" onClick={() => setPresetDropOpen(false)}>
          {t("cancel")}
        </button>
      </BottomSheet>
    </div>
  );
}

function PersonaAvatar({ src, size }: { src: string | null; size: number }) {
  if (!src) {
    return (
      <div className="shrink-0 rounded-full bg-s3 flex items-center justify-center text-[calc(var(--ui-fs)-3px)] text-t2 font-ui" style={{ width: size, height: size }}>
        <Icons.User />
      </div>
    );
  }
  return (
    <img src={src} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  );
}
