import { useCallback, useEffect, useState } from "react";
import { Icons } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { useT } from "../../i18n/context.js";
import { toast } from "sonner";
import { serveCharacterAssetUrl } from "../../api/gallery-api.js";
import { attachGalleryImageAsFlatAsset } from "../../lib/attach-from-gallery.js";
import { useGalleryStore } from "../../stores/gallery-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useNavigationStore } from "../../stores/index.js";
import type { CharacterAsset } from "@vibe-tavern/domain";

interface MediaModalProps {
  open: boolean;
  onClose: () => void;
  characterId: string;
  characterName: string;
}

/**
 * Mobile full-screen gallery picker (MEDIA_GALLERY_REWORK R5 / D1). A slide-up
 * overlay (Telegram/WhatsApp "Shared Media" pattern): 3-column thumbnail grid
 * of the character's gallery, with two actions per image — a quick-send icon
 * on the tile, and a tap → fullscreen lightbox carrying a prominent
 * "Send to chat" button. Browse + send only; editing (caption/describe/set-
 * avatar) stays in Build mode. Reuses the gallery store and the server-side
 * promote flow (`attachGalleryImageAsFlatAsset` → promote-to-attachment).
 */
export function MediaModal({ open, onClose, characterId, characterName }: MediaModalProps) {
  const { t } = useT();
  const load = useGalleryStore((s) => s.load);
  const loading = useGalleryStore((s) => s.loading[characterId]);
  const assets = useGalleryStore((s) => s.byCharacter[characterId]);
  const addDraftAttachment = useChatStore((s) => s.addDraftAttachment);
  const draftCount = useChatStore((s) => s.draftAttachments.length);
  const setMode = useNavigationStore((s) => s.setMode);

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  // Load the gallery list on open (idempotent — safe to call every open).
  useEffect(() => {
    if (open) void load(characterId);
  }, [open, characterId, load]);

  // Reset the lightbox when the modal closes.
  useEffect(() => { if (!open) setLightboxIndex(null); }, [open]);

  const sendImage = useCallback(async (row: CharacterAsset) => {
    if (draftCount >= 5) {
      toast.error(t("max_attachments"));
      return;
    }
    setSendingId(row.id as string);
    try {
      const attachment = await attachGalleryImageAsFlatAsset(characterId, row);
      addDraftAttachment(attachment);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendingId(null);
    }
  }, [draftCount, characterId, addDraftAttachment, onClose, t]);

  const list = assets ?? [];

  return (
    <Modal open={open} onClose={onClose} title={t("media_button")} description={characterName}>
      <div className="flex h-full w-full flex-col bg-surface">
        {/* Header: close + character name. */}
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
          <button
            type="button"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3"
            onClick={onClose}
            aria-label={t("close")}
          >
            <Icons.close />
          </button>
          <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--ui-fs)] font-medium text-t1">
            {characterName}
          </div>
        </div>

        {/* Body: 3-column thumbnail grid / empty state. */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && list.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-t3">{t("loading") || "…"}</div>
          ) : list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="text-sm text-t3">{t("media_empty")}</div>
              <button
                type="button"
                className="cursor-pointer rounded-full bg-accent-dim px-4 py-2 text-sm font-medium text-accent-t transition-colors hover:bg-accent-hover"
                onClick={() => { onClose(); setMode("build"); }}
              >
                {t("media_open_build")}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {list.map((row, i) => {
                const id = row.id as string;
                const isSending = sendingId === id;
                return (
                  <div key={id} className="group relative aspect-square overflow-hidden rounded-md bg-s3">
                    <img
                      src={serveCharacterAssetUrl(characterId, id)}
                      alt={row.caption || "Gallery image"}
                      className="h-full w-full cursor-pointer object-cover transition-transform active:scale-95"
                      draggable={false}
                      onClick={() => setLightboxIndex(i)}
                    />
                    {/* Quick-send icon overlay. */}
                    <button
                      type="button"
                      className="absolute bottom-1 right-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-90 shadow transition-transform active:scale-90 disabled:opacity-40"
                      onClick={(e) => { e.stopPropagation(); void sendImage(row); }}
                      disabled={isSending}
                      aria-label={t("media_send_to_chat")}
                    >
                      {isSending ? <span className="text-xs">…</span> : <Icons.send className="h-4 w-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Inline fullscreen lightbox: image + Send to chat. Browse-only — no edit/regenerate (those live in Build). */}
      {lightboxIndex !== null && list[lightboxIndex] && (
        <MediaLightbox
          asset={list[lightboxIndex]}
          characterId={characterId}
          sending={sendingId === (list[lightboxIndex].id as string)}
          onClose={() => setLightboxIndex(null)}
          onSend={() => void sendImage(list[lightboxIndex])}
        />
      )}
    </Modal>
  );
}

function MediaLightbox({
  asset,
  characterId,
  sending,
  onClose,
  onSend,
}: {
  asset: CharacterAsset;
  characterId: string;
  sending: boolean;
  onClose: () => void;
  onSend: () => void;
}) {
  const { t } = useT();
  const src = serveCharacterAssetUrl(characterId, asset.id as string);
  // Escape closes the lightbox (not the whole modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[700] flex flex-col bg-black/95">
      <button
        type="button"
        className="absolute right-3 top-3 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white active:bg-black/75"
        onClick={onClose}
        aria-label={t("close")}
      >
        <Icons.close />
      </button>
      <div className="flex flex-1 items-center justify-center p-3">
        <img
          src={src}
          alt={asset.caption || "Gallery image"}
          className="max-h-full max-w-full select-none object-contain"
          draggable={false}
        />
      </div>
      <div className="shrink-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent py-3 text-[length:var(--ui-fs)] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
          onClick={onSend}
          disabled={sending}
        >
          {sending ? <span>…</span> : <Icons.send className="h-4 w-4" />}
          {t("media_send_to_chat")}
        </button>
      </div>
    </div>
  );
}
