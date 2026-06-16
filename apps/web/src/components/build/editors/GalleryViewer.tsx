import React, { useCallback, useEffect, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";

interface GalleryViewerProps {
  characterId: string;
  asset: CharacterAsset;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}

export function GalleryViewer({ characterId, asset, onClose, onNext, onPrev }: GalleryViewerProps) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const updateCaption = useGalleryStore((s) => s.updateCaption);

  useEffect(() => {
    setEditing(false);
    setEditText(asset.caption || "");
  }, [asset]);

  // Trap focus / close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight" && onNext && !editing) {
        onNext();
      } else if (e.key === "ArrowLeft" && onPrev && !editing) {
        onPrev();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onNext, onPrev, editing]);

  const handleStartEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(asset.caption || "");
    setEditing(true);
  }, [asset.caption]);

  const handleSaveCaption = useCallback(async () => {
    await updateCaption(characterId, asset.id as string, editText);
    setEditing(false);
  }, [characterId, asset.id, editText, updateCaption]);

  const handleKeyDownCaption = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSaveCaption();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={editing ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Close button */}
      <div className="absolute right-4 top-4 z-10 flex gap-2">
        {!editing && (
          <button
            type="button"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
            onClick={handleStartEdit}
            title={asset.caption ? t("edit_caption") : t("add_caption")}
          >
            <Icons.edit className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
          onClick={onClose}
        >
          <Icons.Close className="h-5 w-5" />
        </button>
      </div>

      {/* Navigation */}
      {onPrev && (
        <button
          type="button"
          className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
        >
          <Icons.Caret direction="l" className="h-6 w-6" />
        </button>
      )}
      {onNext && (
        <button
          type="button"
          className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
          onClick={(e) => { e.stopPropagation(); onNext(); }}
        >
          <Icons.Caret direction="r" className="h-6 w-6" />
        </button>
      )}

      {/* Image + Info */}
      <div className="flex max-h-full w-full max-w-2xl flex-col items-center gap-3 overflow-y-auto p-2" onClick={(e) => e.stopPropagation()}>
        <img
          src={serveCharacterAssetUrl(characterId, asset.id as string)}
          alt={asset.caption || "Gallery image"}
          className="max-h-[70vh] w-auto max-w-full shrink-0 rounded-md object-contain shadow-2xl"
        />

        {/* Caption */}
        {!editing && (
          <div className="w-full text-center">
            {asset.caption ? (
              <div className="text-[15px] font-medium text-white/90">{asset.caption}</div>
            ) : (
              <div className="text-[13px] italic text-white/40">{t("gallery_no_caption")}</div>
            )}
          </div>
        )}

        {/* Edit mode */}
        {editing && (
          <div className="flex w-full flex-col gap-2">
            <AutoTextarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDownCaption}
              className="w-full rounded-lg bg-white/10 px-3 py-2 text-sm leading-relaxed text-white outline-none ring-1 ring-white/20 focus:ring-accent"
              style={{}}
              maxHeight={200}
              placeholder={t("caption_placeholder")}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/20"
                onClick={() => setEditing(false)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent transition-colors hover:bg-accent/80"
                onClick={() => { void handleSaveCaption(); }}
              >
                {t("save")}
              </button>
            </div>
          </div>
        )}

        {/* Vision description badge */}
        {asset.description && !editing && (
          <div className="relative w-full rounded-lg bg-white/10 px-4 py-3 text-center text-sm leading-relaxed text-white/80">
            {asset.description}
          </div>
        )}

        {/* Filename/Ext */}
        <span className="text-xs text-white/30 uppercase tracking-widest">{asset.ext}</span>
      </div>
    </div>
  );
}
