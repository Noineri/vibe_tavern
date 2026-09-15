/**
 * IG-CF6 (IMAGE_GENERATION_PLAN): the image-slot's REPLACEMENT for the text
 * action row — regenerate-as-variant / promote-to-gallery / include-in-prompt
 * plus the provenance mode label. The text-message controls (Copy / Edit /
 * Continue / Narrate / AI editor / Branch / text-Regenerate) are aimed at
 * text and must not render on a slot (owner review 2026-09-15).
 *
 * The logic is the IG-18/IG-18a tile's, relocated: the tile became the shared
 * ImageBlock (image + prompt caption) and the controls moved into the
 * MessageShell action rows, where the swipe carousel and delete live. The
 * mode label is desktop-only — the mobile action row is a 44px-icon grid
 * with no room for a text label (RU runs 20–30% longer than EN, AD-022).
 */

import { useState } from "react";
import type { Attachment } from "@vibe-tavern/domain";
import { toast } from "sonner";

import { useT } from "../../i18n/context.js";
import { useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { promoteImageGenAttachmentToGallery } from "../../api/image-gen-api.js";
import { regenerateAttachmentDescription, updateAttachmentIncludeInPrompt } from "../../api/chat-api.js";

export interface ImageGenSlotControlsProps {
  /** The slot's attachments (every entry imageGen — MessageBlock's pure-slot gate). */
  attachments: Attachment[];
  messageId?: string;
  /** The chat's character (gallery-promote target); null hides promote. */
  characterId?: string | null;
  /** IG-18a regenerate-as-variant: the owning chat (runGeneration target).
   *  Absent hides the regenerate button. */
  chatId?: string;
  /** Mobile action-row sizing (44px touch targets); desktop compact icons. */
  mobile?: boolean;
}

export function ImageGenSlotControls({
  attachments,
  messageId,
  characterId = null,
  chatId,
  mobile = false,
}: ImageGenSlotControlsProps) {
  const { t } = useT();
  const [promotingIds, setPromotingIds] = useState<Set<string>>(new Set());
  const [describingIds, setDescribingIds] = useState<Set<string>>(new Set());
  const running = useImageGenChatStore((s) => (chatId !== undefined ? s.runningByChat[chatId] !== undefined : false));

  const slotButtonCls = cn(
    "flex cursor-pointer items-center justify-center rounded-md transition-colors disabled:opacity-40",
    mobile ? "h-11 w-11 active:bg-s2 [&_svg]:h-5 [&_svg]:w-5" : "h-6 w-6 hover:bg-s3 [&_svg]:h-3.5 [&_svg]:w-3.5",
  );

  const firstProvenance = attachments[0]?.imageGen;
  if (!firstProvenance) return null;

  /** IG-18a: regenerate this slot — mode/profile defaults come from the
   *  slot's own provenance (the generation that produced it); the result
   *  lands as a swipe VARIANT of this slot (targetMessageId), and the
   *  one-per-chat guard disables the button while any generation runs. */
  const regenerate = () => {
    if (!chatId || !messageId || running) return;
    void useImageGenChatStore.getState().runGeneration(chatId, {
      profileId: firstProvenance.profileId,
      mode: firstProvenance.mode,
      anchorMessageId: messageId,
      targetMessageId: messageId,
    });
  };

  const promote = async (att: Attachment) => {
    if (!characterId || !att.id || promotingIds.has(att.id)) return;
    setPromotingIds((prev) => new Set(prev).add(att.id));
    try {
      await promoteImageGenAttachmentToGallery(att.assetId, characterId);
      toast.success(t("image_gen_slot_promoted"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("image_gen_slot_promote_failed"));
    } finally {
      setPromotingIds((prev) => {
        const next = new Set(prev);
        next.delete(att.id);
        return next;
      });
    }
  };

  /** Optimistic store flip of this attachment's flag (+ optional freshly
   *  described text — the describe route persists it server-side already, so
   *  a later include PATCH failure rolls the FLAG back but keeps the
   *  description). */
  const applyLocal = (att: Attachment, include: boolean, description?: string) => {
    if (!messageId || !att.id) return;
    const updateMessage = useSnapshotStore.getState().updateMessage;
    const msg = useSnapshotStore.getState().messagesById[messageId];
    if (!msg?.attachments) return;
    updateMessage(messageId, {
      attachments: msg.attachments.map((a) =>
        a.id === att.id
          ? { ...a, includeInPrompt: include, ...(description !== undefined ? { description } : {}) }
          : a,
      ),
    });
  };

  const setIncluded = async (att: Attachment, next: boolean) => {
    if (!messageId || !att.id || describingIds.has(att.id)) return;
    if (!next) {
      applyLocal(att, false);
      try {
        await updateAttachmentIncludeInPrompt("_", messageId, att.id, false);
      } catch (err) {
        applyLocal(att, true);
        toast.error(err instanceof Error ? err.message : t("image_gen_slot_include_failed"));
      }
      return;
    }
    // Enabling: the slot's textual identity in the prompt is `description ??
    // provenance.prompt` (IG-CF9, owner 2026-09-16) — a CF6-stamped prompt
    // satisfies the server gate, so the opt-in costs zero AI calls. Describe
    // first ONLY when NEITHER exists (legacy slots without a stamped prompt:
    // the server still requires one of the two).
    let description = att.description;
    if (!description?.trim() && !att.imageGen?.prompt?.trim()) {
      setDescribingIds((prev) => new Set(prev).add(att.id));
      try {
        const res = await regenerateAttachmentDescription("_", messageId, att.id);
        description = res.description;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("image_gen_slot_include_failed"));
        return;
      } finally {
        setDescribingIds((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(att.id);
          return nextSet;
        });
      }
    }
    applyLocal(att, true, description ?? undefined);
    try {
      await updateAttachmentIncludeInPrompt("_", messageId, att.id, true);
    } catch (err) {
      applyLocal(att, false);
      toast.error(err instanceof Error ? err.message : t("image_gen_slot_include_failed"));
    }
  };

  return (
    <>
      {!mobile && (
        <span data-testid="image-gen-slot-mode" className="mr-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">
          {t(`image_gen_mode_${firstProvenance.mode}`)}
        </span>
      )}
      {chatId && messageId && (
        <CustomTooltip content={t("image_gen_slot_regenerate")}>
          <button
            type="button"
            data-testid="image-gen-slot-regenerate"
            aria-label={t("image_gen_slot_regenerate")}
            disabled={running}
            onClick={regenerate}
            className={cn(slotButtonCls, "text-t3 hover:text-t1")}
          >
            <Icons.regen />
          </button>
        </CustomTooltip>
      )}
      {attachments.map((att) =>
        !att.id ? null : (
          <span key={att.id} className="flex items-center gap-1">
            {characterId && (
              <CustomTooltip content={t("image_gen_slot_promote")}>
                <button
                  type="button"
                  data-testid="image-gen-slot-promote"
                  aria-label={t("image_gen_slot_promote")}
                  disabled={promotingIds.has(att.id)}
                  onClick={() => void promote(att)}
                  className={cn(slotButtonCls, "text-t3 hover:text-t1")}
                >
                  <Icons.images />
                </button>
              </CustomTooltip>
            )}
            <CustomTooltip
              content={t(
                att.includeInPrompt === true
                  ? "image_gen_slot_exclude_from_prompt"
                  : "image_gen_slot_include_in_prompt",
              )}
            >
              <button
                type="button"
                data-testid="image-gen-slot-include"
                aria-label={t(
                  att.includeInPrompt === true
                    ? "image_gen_slot_exclude_from_prompt"
                    : "image_gen_slot_include_in_prompt",
                )}
                aria-pressed={att.includeInPrompt === true}
                disabled={describingIds.has(att.id)}
                onClick={() => void setIncluded(att, att.includeInPrompt !== true)}
                className={cn(
                  slotButtonCls,
                  att.includeInPrompt === true ? "text-accent" : "text-t3 hover:text-t1",
                )}
              >
                {describingIds.has(att.id) ? <span aria-hidden>…</span> : <Icons.eye />}
              </button>
            </CustomTooltip>
          </span>
        ),
      )}
    </>
  );
}
