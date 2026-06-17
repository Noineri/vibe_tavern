import React, { useCallback, useEffect, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { useT } from "../../../i18n/context.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useGalleryStore } from "../../../stores/gallery-store.js";

interface GalleryLightboxProps {
  characterId: string;
  assets: CharacterAsset[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * Fullscreen gallery lightbox — the "description workbench". A direct port of
 * the chat-attachment lightbox (AttachmentGrid.Lightbox) onto the gallery store:
 * shows the full image + its AI description, with inline Edit and cancellable
 * Regenerate (vision re-describe), plus prev/next across the gallery. Distinct
 * from GalleryViewer (the frameless floating quick-inspect panel): this is the
 * modal focused surface for reading/editing the description.
 *
 * Regeneration rides on the gallery store's per-character describe flow:
 * `describing[characterId].has(id)` is the in-flight flag, and cancel calls
 * `cancelDescribe` (aborts the in-flight vision request). Edit persists via
 * `updateDescription` (optimistic).
 */
export function GalleryLightbox({ characterId, assets, index, onIndexChange, onClose }: GalleryLightboxProps) {
  const { t } = useT();
  const asset = assets[index];
  if (!asset) return null;

  const id = asset.id as string;
  const src = serveCharacterAssetUrl(characterId, id);
  const alt = asset.caption || "Gallery image";
  const hasNav = assets.length > 1;

  const describingSet = useGalleryStore((s) => s.describing[characterId]);
  const isRegenerating = describingSet?.has(id) ?? false;
  const describe = useGalleryStore((s) => s.describe);
  const cancelDescribe = useGalleryStore((s) => s.cancelDescribe);
  const updateDescription = useGalleryStore((s) => s.updateDescription);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  // Reset edit mode when navigating between images.
  useEffect(() => { setEditing(false); }, [index]);

  const currentDescription = asset.description?.trim() ?? "";

  const goNext = useCallback(() => { setEditing(false); onIndexChange((index + 1) % assets.length); }, [onIndexChange, index, assets.length]);
  const goPrev = useCallback(() => { setEditing(false); onIndexChange((index - 1 + assets.length) % assets.length); }, [onIndexChange, index, assets.length]);

  const startEdit = useCallback(() => { setEditText(currentDescription); setEditing(true); }, [currentDescription]);

  const saveDescription = useCallback(async () => {
    setSaving(true);
    try {
      await updateDescription(characterId, id, editText);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [updateDescription, characterId, id, editText]);

  const regenerate = useCallback(() => { void describe(characterId, [id]); }, [describe, characterId, id]);
  const cancelRegenerate = useCallback(() => { cancelDescribe(characterId); }, [cancelDescribe, characterId]);

  // Keyboard: Escape close, arrows navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && hasNav) goNext();
      else if (e.key === "ArrowLeft" && hasNav) goPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, goNext, goPrev, hasNav]);

  return (
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={editing ? undefined : onClose}
    >
      {/* Top-right action cluster: edit / regenerate(+cancel) / close. */}
      <div className="absolute right-4 top-4 z-10 flex gap-2">
        {!editing && (
          <>
            <button
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
              onClick={(e) => { e.stopPropagation(); startEdit(); }}
              title={currentDescription ? t("gallery_edit_description") : t("gallery_add_description")}
            >
              <Icons.edit className="h-4 w-4" />
            </button>
            {isRegenerating ? (
              <button
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-danger/80 text-on-danger transition-colors hover:bg-danger active:scale-95"
                onClick={(e) => { e.stopPropagation(); cancelRegenerate(); }}
                title={t("gallery_describe_regenerate")}
              >
                <Icons.close className="h-4 w-4" />
              </button>
            ) : (
              <button
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
                onClick={(e) => { e.stopPropagation(); regenerate(); }}
                title={t("gallery_regenerate")}
              >
                <Icons.regen />
              </button>
            )}
          </>
        )}
        <button
          className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title={t("close")}
        >
          <Icons.close className="h-5 w-5" />
        </button>
      </div>

      {/* Prev / next nav. */}
      {hasNav && (
        <>
          <button
            className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
          >
            <Icons.Caret direction="l" className="h-6 w-6" />
          </button>
          <button
            className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
          >
            <Icons.Caret direction="r" className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Image + description stack. */}
      <div className="flex max-h-full w-full max-w-2xl flex-col items-center gap-3 overflow-y-auto p-2" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt={alt}
          className="max-h-[80vh] w-auto max-w-full shrink-0 rounded-md object-contain shadow-2xl"
          draggable={false}
        />

        {/* Caption (if any) — small label above the description. */}
        {asset.caption?.trim() && !editing && (
          <div className="w-full text-center text-xs text-white/50">{asset.caption}</div>
        )}

        {/* Regenerating status. */}
        {isRegenerating && !editing && (
          <div className="w-full rounded-lg bg-white/10 px-4 py-2.5 text-center text-sm text-white/60">
            {t("gallery_regenerating")}
          </div>
        )}

        {/* Description (read). */}
        {currentDescription && !editing && !isRegenerating && (
          <div className="w-full rounded-lg bg-white/10 px-4 py-2.5 text-center text-sm leading-relaxed text-white/80">
            {currentDescription}
          </div>
        )}

        {/* Empty-description hint. */}
        {!currentDescription && !editing && !isRegenerating && (
          <div className="w-full text-center text-xs text-white/30">
            {t("gallery_no_description")}
          </div>
        )}

        {/* Edit mode. */}
        {editing && (
          <div className="flex w-full flex-col gap-2">
            <AutoTextarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full rounded-lg bg-white/10 px-3 py-2 text-sm leading-relaxed text-white outline-none ring-1 ring-white/20 focus:ring-accent"
              style={{}}
              maxHeight={400}
              placeholder={t("gallery_add_description") + "…"}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex justify-end gap-2">
              <button
                className="cursor-pointer rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/20"
                onClick={(e) => { e.stopPropagation(); setEditing(false); }}
              >
                {t("cancel")}
              </button>
              <button
                className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent transition-colors hover:bg-accent/80 disabled:opacity-50"
                onClick={(e) => { e.stopPropagation(); void saveDescription(); }}
                disabled={saving}
              >
                {saving ? t("save") + "…" : t("save")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
