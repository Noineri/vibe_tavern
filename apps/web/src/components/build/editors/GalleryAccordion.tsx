import React, { useEffect, useRef, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { Toggle } from "../../shared/Toggle.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { GalleryGrid } from "./GalleryGrid.js";
import { updateCharacter, updateCharacterAvatar } from "../../../api/character-api.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import { useSnapshotStore, useActiveCharacter } from "../../../stores/snapshot-store.js";
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
  onSetAvatarPreview?: (url: string | null) => void;
}

export function GalleryAccordion({ characterId, onSetAvatarPreview }: GalleryAccordionProps) {
  const { t } = useT();
  const storageKey = `gallery:open:${characterId}`;
  const [isOpen, setIsOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });

  const activeCharacter = useActiveCharacter();
  const includeGalleryInPrompt = activeCharacter?.includeGalleryInPrompt ?? false;

  const load = useGalleryStore((s) => s.load);
  const upload = useGalleryStore((s) => s.upload);
  const describe = useGalleryStore((s) => s.describe);
  const remove = useGalleryStore((s) => s.remove);
  
  const loading = useGalleryStore((s) => s.loading[characterId]);
  const error = useGalleryStore((s) => s.error[characterId]);
  const assets = useGalleryStore((s) => s.byCharacter[characterId] ?? EMPTY_ASSETS);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    if (isOpen) {
      localStorage.setItem(storageKey, "true");
      void load(characterId);
    } else {
      localStorage.setItem(storageKey, "false");
    }
  }, [isOpen, characterId, load, storageKey]);

  // Token estimate — only rows that will actually be injected into the prompt.
  // The backend (prompt-assembly-service) AND-gates on BOTH the character-level
  // master switch (includeGalleryInPrompt) AND the per-image includeInPrompt
  // flag, plus requires a non-empty description. This filter mirrors that so
  // the token badge never overstates what reaches the model.
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

  const handleToggleInclude = async () => {
    try {
      const snapshot = await updateCharacter(characterId, { includeGalleryInPrompt: !includeGalleryInPrompt });
      useSnapshotStore.getState().ingestSnapshot(snapshot);
    } catch (err) {
      toast.error(String(err));
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

  const handleSetAvatar = async (asset: CharacterAsset) => {
    try {
      const chatId = useSnapshotStore.getState().activeChat?.id || "_";
      const snapshot = await updateCharacterAvatar(characterId, chatId, asset.id as string, asset.id as string, null);
      useSnapshotStore.getState().ingestSnapshot(snapshot);
      if (onSetAvatarPreview) {
        onSetAvatarPreview(serveCharacterAssetUrl(characterId, asset.id as string));
      }
      toast.success(t("avatar_updated"));
    } catch (err) {
      toast.error(String(err));
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
              onSetAvatar={handleSetAvatar}
              masterIncludeEnabled={includeGalleryInPrompt}
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
            </div>

            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 font-ui text-sm text-t2">
                <Toggle
                  checked={includeGalleryInPrompt}
                  onChange={() => { void handleToggleInclude(); }}
                />
                {t("gallery_include_in_prompt")}
              </label>

              {includeGalleryInPrompt && (
                includedAssets.length === 0 && describedCount > 0 ? (
                  <span className="flex items-center gap-1 font-ui text-[11px] italic text-t3">
                    <Icons.ellipsis className="h-3 w-3" />{t("gallery_select_via_menu")}
                  </span>
                ) : (
                  <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3">
                    {tokenCount.toLocaleString()} {t("tokens_label")}
                  </span>
                )
              )}
            </div>
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
    </div>
  );
}
