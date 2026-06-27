import { useCallback, useEffect, useRef, useState } from "react";
import { useOutsideClick } from "../../hooks/use-outside-click.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { useT } from "../../i18n/context.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { toast } from "sonner";
import { serveCharacterAssetUrl } from "../../api/gallery-api.js";
import { attachGalleryImageAsFlatAsset } from "../../lib/attach-from-gallery.js";
import { useGalleryStore } from "../../stores/gallery-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useNavigationStore } from "../../stores/index.js";
import { GalleryViewer } from "../build/editors/GalleryViewer.js";
import { MediaModal } from "./MediaModal.js";
import type { CharacterAsset } from "@vibe-tavern/domain";

interface MediaMenuProps {
  characterId: string;
  characterName: string;
}

/**
 * TopBar "Media" trigger (MEDIA_GALLERY_REWORK R5 / D1). Replaces the dead
 * `characterSubtitle` slot (desktop) and the Build-jumping gallery icon. Opens
 * the character's gallery for in-chat browsing + sending — no mode switch.
 *
 * Desktop: a "🖼 Медиа ▸" button whose popover holds a 3-column thumbnail grid
 * (~116px tiles, 2 visible rows then scroll); click a tile → floating
 * `GalleryViewer` (zoom/pan); a corner send-to-chat button (revealed on hover)
 * → server promote + `addDraftAttachment`. Mirrors the GalleryGrid tile pattern
 * (body click → view, corner button → action). Caret toggles ▸ (closed) / ▾ (open).
 * Mobile: an icon-only button opening a full-screen `MediaModal`.
 *
 * Browse + send only; editing (caption/describe/set-avatar) stays in Build.
 */
export function MediaMenu({ characterId, characterName }: MediaMenuProps) {
  const isMobile = useIsMobile();
  const { t } = useT();
  const [modalOpen, setModalOpen] = useState(false);

  if (isMobile) {
    return (
      <>
        <CustomTooltip content={t("media_button")}>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-t3 transition-colors active:bg-s3"
            onClick={() => setModalOpen(true)}
            aria-label={t("media_button")}
          >
            <Icons.images />
          </button>
        </CustomTooltip>
        <MediaModal open={modalOpen} onClose={() => setModalOpen(false)} characterId={characterId} characterName={characterName} />
      </>
    );
  }
  return <DesktopMediaMenu characterId={characterId} />;
}

function DesktopMediaMenu({ characterId }: { characterId: string }) {
  const { t } = useT();
  const load = useGalleryStore((s) => s.load);
  const loading = useGalleryStore((s) => s.loading[characterId]);
  const assets = useGalleryStore((s) => s.byCharacter[characterId]);
  const addDraftAttachment = useChatStore((s) => s.addDraftAttachment);
  const draftCount = useChatStore((s) => s.draftAttachments.length);
  const setMode = useNavigationStore((s) => s.setMode);

  const [open, setOpen] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  // Floating viewers: one GalleryViewer per open tile (mirrors the gallery
  // grid's open-panels pattern). Tracked by row id.
  const [openViewers, setOpenViewers] = useState<CharacterAsset[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Load the gallery list on first open (idempotent — safe to call every open).
  useEffect(() => {
    if (open) void load(characterId);
  }, [open, characterId, load]);

  // Outside-click closes the popover (but not when clicking inside a viewer).
  useOutsideClick(rootRef, () => setOpen(false), { enabled: open });

  const sendImage = useCallback(async (row: CharacterAsset) => {
    if (draftCount >= 5) {
      toast.error(t("max_attachments"));
      return;
    }
    setSendingId(row.id as string);
    try {
      const attachment = await attachGalleryImageAsFlatAsset(characterId, row);
      addDraftAttachment(attachment);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendingId(null);
    }
  }, [draftCount, characterId, addDraftAttachment, t]);

  const spawnViewer = useCallback((row: CharacterAsset) => {
    setOpenViewers((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
    setOpen(false);
  }, []);

  const closeViewer = useCallback((rowId: string) => {
    setOpenViewers((prev) => prev.filter((a) => a.id !== rowId));
  }, []);

  const list = assets ?? [];

  return (
    <>
      <div ref={rootRef} className="relative mt-px max-w-[160px]">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 py-px text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:text-t1"
          onClick={() => setOpen((v) => !v)}
          aria-label={t("media_button")}
        >
          <Icons.images />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t("media_button")}</span>
          <span className={"text-t4 transition-transform " + (open ? "rotate-90" : "")}>
            <Icons.Caret direction="r" />
          </span>
        </button>

        {open && (
          <div className="glass-blur absolute left-0 top-full z-50 mt-1 rounded-lg border border-border bg-glass-bg p-2 shadow-[0_12px_36px_rgba(0,0,0,.45)]">
            {loading && list.length === 0 ? (
              <div className="flex h-20 w-[360px] items-center justify-center text-xs text-t3">…</div>
            ) : list.length === 0 ? (
              <div className="flex w-[220px] flex-col items-center gap-2 px-3 py-4 text-center">
                <div className="text-xs text-t3">{t("media_empty")}</div>
                <button
                  type="button"
                  className="cursor-pointer rounded-full bg-accent-dim px-3 py-1 text-xs font-medium text-accent-t transition-colors hover:bg-accent-hover"
                  onClick={() => { setOpen(false); setMode("build"); }}
                >
                  {t("media_open_build")}
                </button>
              </div>
            ) : (
              <div className="grid max-h-[240px] w-[360px] grid-cols-3 gap-1.5 overflow-y-auto">
                {list.map((row) => {
                  const id = row.id as string;
                  const isSending = sendingId === id;
                  return (
                    <div key={id} className="group relative aspect-square overflow-hidden rounded-md bg-s3">
                      <img
                        src={serveCharacterAssetUrl(characterId, id)}
                        alt={row.caption || "Gallery image"}
                        className="h-full w-full cursor-pointer object-cover transition-transform group-hover:scale-105"
                        draggable={false}
                        onClick={() => spawnViewer(row)}
                      />
                      {/* Hover dim — visual only (pointer-events-none lets the
                          click fall through to the image → opens the viewer). */}
                      <div className="pointer-events-none absolute inset-0 bg-black/35 opacity-0 transition-opacity group-hover:opacity-100" />
                      {/* Send-to-chat: corner action button (mirrors GalleryGrid's
                          expand/menu pattern — small, z-20, stopPropagation). */}
                      <button
                        type="button"
                        className="absolute bottom-1 right-1 z-20 flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur-sm transition-all hover:bg-accent hover:text-on-accent group-hover:opacity-100 disabled:opacity-40"
                        onClick={(e) => { e.stopPropagation(); void sendImage(row); }}
                        disabled={isSending}
                        title={t("media_send_to_chat")}
                        aria-label={t("media_send_to_chat")}
                      >
                        {isSending ? <span className="text-[10px]">…</span> : <Icons.send className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating viewers — multiple may be open at once. */}
      {openViewers.map((asset) => (
        <GalleryViewer
          key={asset.id as string}
          characterId={characterId}
          asset={asset}
          onClose={() => closeViewer(asset.id as string)}
        />
      ))}
    </>
  );
}
