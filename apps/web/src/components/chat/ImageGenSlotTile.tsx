/**
 * Image-gen slot tile (IMAGE_GENERATION_PLAN IG-18): a generated-image
 * attachment rendered inside AttachmentGrid — thumbnail → floating zoom/pan
 * viewer (the gallery machinery via FloatingImageViewer), with the slot's
 * action row: provenance mode label, "Add to character gallery", and the
 * per-image "include in prompt" opt-in (default OFF — pure illustration;
 * ON runs the vision-describe flow first when the image has no description
 * yet, then the pipeline includes the described image like any other).
 *
 * No regenerate button here — variants are IG-18a (owner split 2026-09-15).
 */

import { useState } from "react";
import type { Attachment } from "@vibe-tavern/domain";
import { toast } from "sonner";

import { getGatewayBaseUrl } from "../../gateway-client.js";
import { useT } from "../../i18n/context.js";
import { useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { FloatingImageViewer } from "../build/editors/GalleryViewer.js";
import { promoteImageGenAttachmentToGallery } from "../../api/image-gen-api.js";
import { regenerateAttachmentDescription, updateAttachmentIncludeInPrompt } from "../../api/chat-api.js";

export interface ImageGenSlotTileProps {
  attachment: Attachment;
  messageId?: string;
  /** The chat's character (gallery-promote target); null hides promote. */
  characterId?: string | null;
  /** IG-18a regenerate-as-variant: the owning chat (runGeneration target).
   *  Absent hides the regenerate button (tests mount without it). */
  chatId?: string;
}

export function ImageGenSlotTile({ attachment, messageId, characterId = null, chatId }: ImageGenSlotTileProps) {
  const { t } = useT();
  const [viewerOpen, setViewerOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [describing, setDescribing] = useState(false);
  const running = useImageGenChatStore((s) => (chatId !== undefined ? s.runningByChat[chatId] !== undefined : false));

  const provenance = attachment.imageGen;
  const src = `${getGatewayBaseUrl()}/api/assets/${attachment.assetId}`;
  const alt = attachment.name || "Generated image";
  const included = attachment.includeInPrompt === true;

  const promote = async () => {
    if (!characterId || promoting) return;
    setPromoting(true);
    try {
      await promoteImageGenAttachmentToGallery(attachment.assetId, characterId);
      toast.success(t("image_gen_slot_promoted"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("image_gen_slot_promote_failed"));
    } finally {
      setPromoting(false);
    }
  };

  /** Optimistic store flip of this attachment's flag (+ optional freshly
   *  described text — the describe route persists it server-side already, so
   *  a later include PATCH failure rolls the FLAG back but keeps the
   *  description). */
  const applyLocal = (include: boolean, description?: string) => {
    if (!messageId || !attachment.id) return;
    const updateMessage = useSnapshotStore.getState().updateMessage;
    const msg = useSnapshotStore.getState().messagesById[messageId];
    if (!msg?.attachments) return;
    updateMessage(messageId, {
      attachments: msg.attachments.map((a) =>
        a.id === attachment.id
          ? { ...a, includeInPrompt: include, ...(description !== undefined ? { description } : {}) }
          : a,
      ),
    });
  };

  const setIncluded = async (next: boolean) => {
    if (!messageId || !attachment.id || describing) return;
    if (!next) {
      applyLocal(false);
      try {
        await updateAttachmentIncludeInPrompt("_", messageId, attachment.id, false);
      } catch (err) {
        applyLocal(true);
        toast.error(err instanceof Error ? err.message : t("image_gen_slot_include_failed"));
      }
      return;
    }
    // Enabling: describe first when there is no description yet (the design's
    // toggle-on describe flow — the server rejects include without one).
    let description = attachment.description;
    if (!description?.trim()) {
      setDescribing(true);
      try {
        const res = await regenerateAttachmentDescription("_", messageId, attachment.id);
        description = res.description;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("image_gen_slot_include_failed"));
        return;
      } finally {
        setDescribing(false);
      }
    }
    applyLocal(true, description ?? undefined);
    try {
      await updateAttachmentIncludeInPrompt("_", messageId, attachment.id, true);
    } catch (err) {
      applyLocal(false);
      toast.error(err instanceof Error ? err.message : t("image_gen_slot_include_failed"));
    }
  };

  // The tile is only mounted for imageGen attachments (AttachmentGrid
  // branches on it); the guard keeps TS honest for the provenance reads.
  if (!provenance) return null;

  /** IG-18a: regenerate this slot — the mode/profile defaults come from the
   *  slot's own provenance (the generation that produced it); the result
   *  lands as a swipe VARIANT of this slot (targetMessageId), and the one-
   *  per-chat guard disables the button while any generation runs. */
  const regenerate = () => {
    if (!chatId || !messageId || running) return;
    void useImageGenChatStore.getState().runGeneration(chatId, {
      profileId: provenance.profileId,
      mode: provenance.mode,
      anchorMessageId: messageId,
      targetMessageId: messageId,
    });
  };

  return (
    <div data-testid="image-gen-slot" className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="image-gen-slot-thumb"
        className="group relative flex h-24 w-auto cursor-zoom-in overflow-hidden rounded-lg border border-border/50 bg-s2/50 shadow-sm transition-all hover:border-accent hover:shadow-md active:scale-[0.98]"
        onClick={() => setViewerOpen(true)}
        aria-label={t("image_gen_slot_view")}
      >
        <img
          src={src}
          alt={alt}
          className="h-full w-auto min-w-16 object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
          draggable={false}
        />
      </button>
      <div className="flex items-center gap-1.5">
        <span
          data-testid="image-gen-slot-mode"
          className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3"
        >
          {t(`image_gen_mode_${provenance.mode}`)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {chatId && messageId && (
            <CustomTooltip content={t("image_gen_slot_regenerate")}>
              <button
                type="button"
                data-testid="image-gen-slot-regenerate"
                aria-label={t("image_gen_slot_regenerate")}
                disabled={running}
                onClick={regenerate}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <Icons.regen />
              </button>
            </CustomTooltip>
          )}
          {characterId && (
            <CustomTooltip content={t("image_gen_slot_promote")}>
              <button
                type="button"
                data-testid="image-gen-slot-promote"
                aria-label={t("image_gen_slot_promote")}
                disabled={promoting}
                onClick={() => void promote()}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-t3 transition-colors hover:bg-s3 hover:text-t1 disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
              >
                <Icons.images />
              </button>
            </CustomTooltip>
          )}
          <CustomTooltip content={t(included ? "image_gen_slot_exclude_from_prompt" : "image_gen_slot_include_in_prompt")}>
            <button
              type="button"
              data-testid="image-gen-slot-include"
              aria-label={t(included ? "image_gen_slot_exclude_from_prompt" : "image_gen_slot_include_in_prompt")}
              aria-pressed={included}
              disabled={describing}
              onClick={() => void setIncluded(!included)}
              className={cn(
                "flex h-6 w-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-s3 disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5",
                included ? "text-accent" : "text-t3 hover:text-t1",
              )}
            >
              {describing ? <span aria-hidden>…</span> : <Icons.eye />}
            </button>
          </CustomTooltip>
        </div>
      </div>
      {viewerOpen && <FloatingImageViewer src={src} alt={alt} onClose={() => setViewerOpen(false)} />}
    </div>
  );
}
