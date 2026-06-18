import React, { useEffect, useRef, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { AvatarCropModal } from "../../shared/AvatarCropModal.js";
import type { AvatarCropResult } from "../../shared/AvatarCropModal.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { GalleryGrid } from "./GalleryGrid.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import { setAvatarFromGallery } from "../../../api/character-api.js";
import { fetchBootstrapAction } from "../../../stores/api-actions/bootstrap-actions.js";
import { useTokenCount } from "../../../hooks/use-token-count.js";
import { useT } from "../../../i18n/context.js";
import { toast } from "sonner";
import type { CharacterAsset } from "@vibe-tavern/domain";

/** Stable empty array so the `byCharacter[id] ?? EMPTY_ASSETS` selector returns
 *  the same reference when a character has no gallery yet. Returning a fresh
 *  `[]` here triggers React #185 (Maximum update depth exceeded) because
 *  Zustand v5's useSyncExternalStore sees a new reference every render. */
const EMPTY_ASSETS: readonly CharacterAsset[] = Object.freeze([]);

interface GalleryAccordionProps {
  characterId: string;
}

export function GalleryAccordion({ characterId }: GalleryAccordionProps) {
  const { t } = useT();
  const storageKey = `gallery:open:${characterId}`;
  const [isOpen, setIsOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });

  const load = useGalleryStore((s) => s.load);
  const reload = useGalleryStore((s) => s.reload);
  const upload = useGalleryStore((s) => s.upload);
  const describe = useGalleryStore((s) => s.describe);
  const cancelDescribe = useGalleryStore((s) => s.cancelDescribe);
  const remove = useGalleryStore((s) => s.remove);
  const setIncludeInPrompt = useGalleryStore((s) => s.setIncludeInPrompt);

  const loading = useGalleryStore((s) => s.loading[characterId]);
  const error = useGalleryStore((s) => s.error[characterId]);
  const assets = useGalleryStore((s) => s.byCharacter[characterId] ?? EMPTY_ASSETS);
  const describingSet = useGalleryStore((s) => s.describing[characterId]);
  const isDescribing = describingSet !== undefined && describingSet.size > 0;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // D8: the gallery row currently being cropped to become the avatar. Null
  // when the crop modal is closed. Seeded with the row's serve URL; its stored
  // avatarCropJson (if it's a salvaged former avatar) pre-fills the crop so the
  // exact prior crop is recreated.
  const [avatarCropTarget, setAvatarCropTarget] = useState<CharacterAsset | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);

  // Populate the gallery cache even while the accordion is collapsed so the
  // count badge reflects server-side changes (salvage on an avatar swap, an
  // upload from elsewhere) without the user having to open it first (Bug #5).
  // load() is idempotent — it only fetches the first time; reload() forces a
  // fresh fetch on open so the user always sees the latest when interacting.
  useEffect(() => {
    localStorage.setItem(storageKey, isOpen ? "true" : "false");
    if (isOpen) void reload(characterId);
    else void load(characterId);
  }, [isOpen, characterId, load, reload, storageKey]);

  // Token estimate — only rows that will actually be injected into the prompt.
  // Per-image includeInPrompt is the sole gate now (no character-level master
  // switch); the backend injects iff includeInPrompt AND a non-empty description.
  // This filter mirrors that so the token badge never overstates what reaches
  // the model. The badge doubles as the de-facto "gallery is active" indicator.
  const includedAssets = assets.filter((a) => a.description && a.includeInPrompt);
  const describedCount = assets.filter((a) => a.description).length;
  const injectedImagesText = includedAssets
    .map((a) => `Image "${a.caption || a.ext}": ${a.description}`)
    .join("\n");
  
  const tokenCount = useTokenCount(injectedImagesText);

  const handleToggleOpen = () => setIsOpen((o) => !o);

  const handleImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const array = Array.from(files);
    for (const file of array) {
      await upload(characterId, file).catch(() => {});
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    setConfirmDeleteOpen(true);
  };

  const confirmDeleteSelected = async () => {
    setConfirmDeleteOpen(false);
    for (const id of selectedIds) {
      await remove(characterId, id).catch(() => {});
    }
    setSelectedIds(new Set());
  };

  const handleDescribeAll = async () => {
    const undescribed = assets.filter((a) => !a.description).map((a) => a.id as string);
    if (undescribed.length > 0) {
      await describe(characterId, undescribed);
    } else {
      toast.info(t("gallery_all_described"));
    }
  };

  const handleDisableAll = async () => {
    for (const asset of assets.filter((a) => a.includeInPrompt)) {
      await setIncludeInPrompt(characterId, asset.id as string, false).catch(() => {});
    }
  };

  // Bulk-include the prompt: enable includeInPrompt on every row that has a
  // description (inclusion is meaningless without one — the backend AND-gates
  // on description). Only surfaced once all tiles are described, so the button
  // never offers a no-op bulk enable over undescribed images.
  const handleIncludeAll = async () => {
    for (const asset of assets.filter((a) => a.description && !a.includeInPrompt)) {
      await setIncludeInPrompt(characterId, asset.id as string, true).catch(() => {});
    }
  };

  const handleToggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // D8: apply a cropped gallery image as the character's avatar. Server-side
  // salvages the current avatar into the gallery first, so we reload the list
  // (to surface the salvaged "previous avatar" row) + the snapshot (so the new
  // avatar propagates app-wide with a cache-busted URL).
  const handleAvatarCropConfirm = async (result: AvatarCropResult) => {
    const target = avatarCropTarget;
    if (!target || !result.croppedFile) return;
    setSavingAvatar(true);
    try {
      await setAvatarFromGallery(
        characterId,
        target.id as string,
        result.croppedFile,
        result.cropJson ?? "",
      );
      setAvatarCropTarget(null);
      // Reload (not load): the list is already cached from when the accordion
      // opened, so idempotent load() would no-op and never surface the salvaged
      // row / new state. Force-refresh so the gallery reflects the swap at once
      // (Bug #5), and refresh the snapshot so the cache-busted avatar URL
      // propagates app-wide.
      await Promise.all([reload(characterId), fetchBootstrapAction({ silent: true })]);
      toast.success(t("avatar_updated"));
    } catch (err) {
      console.error("Set avatar from gallery failed:", err);
      toast.error(t("gallery_set_avatar_failed"));
    } finally {
      setSavingAvatar(false);
    }
  };

  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-border bg-s2">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between bg-surface px-4 py-3 font-body text-[15px] font-medium text-t1 transition-colors hover:bg-s2"
        onClick={handleToggleOpen}
      >
        <div className="flex items-center gap-2">
          <span>{t("gallery_title")}</span>
          <span className="rounded-full bg-accent-dim px-2 py-0.5 font-ui text-[10px] text-accent-t">
            {assets.length}
          </span>
        </div>
        <Icons.Caret direction={isOpen ? "d" : "l"} className="h-5 w-5 text-t3" />
      </button>

      {isOpen && (
        <div className="flex flex-col border-t border-border bg-bg p-4">
          {error && (
            <div className="mb-4 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          {loading && assets.length === 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="aspect-square w-full animate-pulse rounded-lg bg-s3" />
              ))}
            </div>
          ) : assets.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-t3">
              <Icons.import className="h-6 w-6 opacity-60" />
              <p className="mt-2 text-sm">{t("gallery_empty")}</p>
            </div>
          ) : (
            <GalleryGrid
              characterId={characterId}
              assets={assets}
              selectedIds={selectedIds}
              onToggleSelection={handleToggleSelection}
              onSetAsAvatar={(asset) => setAvatarCropTarget(asset)}
            />
          )}

          {/* Footer action bar */}
          <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t border-border pt-4 sm:flex-row">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="cursor-pointer rounded bg-accent px-3 py-1.5 font-ui text-sm text-on-accent transition-colors hover:bg-accent/90"
                onClick={() => fileInputRef.current?.click()}
              >
                {t("gallery_import")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => { void handleImportFiles(e.target.files); }}
              />

              {selectedIds.size > 0 && (
                <button
                  type="button"
                  className="cursor-pointer rounded bg-danger/10 px-3 py-1.5 font-ui text-sm text-danger transition-colors hover:bg-danger/20"
                  onClick={() => { void handleDeleteSelected(); }}
                >
                  {t("delete")} ({selectedIds.size})
                </button>
              )}

              <button
                type="button"
                className="cursor-pointer rounded border border-border bg-s2 px-3 py-1.5 font-ui text-sm text-t2 transition-colors hover:bg-s3 disabled:opacity-50"
                onClick={() => { void handleDescribeAll(); }}
                disabled={assets.every((a) => a.description)}
              >
                {t("gallery_describe_all")}
              </button>

              {isDescribing && (
                <button
                  type="button"
                  className="cursor-pointer rounded bg-danger/10 px-3 py-1.5 font-ui text-sm text-danger transition-colors hover:bg-danger/20"
                  onClick={() => cancelDescribe(characterId)}
                >
                  {t("gallery_describe_cancel")}
                </button>
              )}

              {includedAssets.length > 0 && (
                <button
                  type="button"
                  className="cursor-pointer rounded border border-border bg-s2 px-3 py-1.5 font-ui text-sm text-t2 transition-colors hover:bg-s3"
                  onClick={() => { void handleDisableAll(); }}
                >
                  {t("gallery_disable_all")}
                </button>
              )}

              {/* Mirror of "Disable all": bulk-enable inclusion. Only shown once
                  every tile is described (so there's something worth including
                  on each) and at least one described row is still opted out —
                  otherwise the button would be a no-op. */}
              {assets.length > 0
                && assets.every((a) => a.description)
                && assets.some((a) => a.description && !a.includeInPrompt) && (
                <button
                  type="button"
                  className="cursor-pointer rounded border border-accent/40 bg-accent/10 px-3 py-1.5 font-ui text-sm text-accent-t transition-colors hover:bg-accent/20"
                  onClick={() => { void handleIncludeAll(); }}
                >
                  {t("gallery_include_all")}
                </button>
              )}
            </div>

            {/* Token badge — the de-facto "gallery is active" indicator. With
                the master toggle gone, this counts exactly the rows that will
                reach the model (description && includeInPrompt). */}
            <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3">
              {includedAssets.length} · {tokenCount.toLocaleString()} {t("tokens_label")}
            </span>
          </div>
        </div>
      )}

      {confirmDeleteOpen && (
        <DestructiveConfirmModal
          title={t("gallery_confirm_delete_title")}
          body={t("gallery_confirm_delete_msg").replace("{n}", String(selectedIds.size))}
          confirmLabel={t("delete")}
          onConfirm={() => { void confirmDeleteSelected(); }}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}

      {/* D8: crop a gallery image into the avatar. The modal is seeded with the
          row's full image (the gallery only ever shows fulls) and, when the
          row is a salvaged former avatar, its stored crop geometry pre-fills
          the cropper for an exact restore. */}
      {avatarCropTarget && (
        <AvatarCropModal
          imageUrl={serveCharacterAssetUrl(characterId, avatarCropTarget.id as string)}
          fileName={`avatar_${avatarCropTarget.id}.png`}
          initialCropJson={avatarCropTarget.avatarCropJson}
          onConfirm={(result) => { void handleAvatarCropConfirm(result); }}
          onCancel={() => { if (!savingAvatar) setAvatarCropTarget(null); }}
        />
      )}
    </div>
  );
}
