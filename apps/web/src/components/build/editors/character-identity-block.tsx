import type { RefObject } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { TextInput } from "../../shared/text-input.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { TagsField } from "../fields/TagsField.js";
import { BoundResourcesField } from "../../shared/BoundResourcesField.js";

interface CharacterIdentityBlockProps {
  /** Detected avatar orientation; "landscape" + an avatar renders the stacked layout. */
  orientation: "portrait" | "landscape" | null;
  /** Resolved avatar src (fresh preview or the stored URL); absent renders the upload dropzone. */
  displayAvatar?: string | null;
  avaInputRef: RefObject<HTMLInputElement | null>;
  onAvatarPick: (files: FileList | null) => void;
  onOpenThumbnailCrop: () => void;
  form: UseFormReturn<BuildCharacterDraft>;
  characterId: string;
  isSaving: boolean;
  isMobile: boolean;
}

/** The «Avatar + Name + Tags» header of the character editor: the avatar
 *  picker in both orientations (landscape: full-width avatar above the
 *  name/tags column; portrait / no avatar: side-by-side with the dashed
 *  empty-state dropzone) plus the name field, tags and bound resources.
 *
 *  Extracted verbatim from `CharacterForm.tsx` under the file-size ratchet
 *  (2026-11-05) while naming the two crop-thumbnail buttons
 *  (ICON_BUTTON_ARIA_LABELS_REPORT step 3). All state, refs and handlers
 *  stay in the parent — this block only renders. */
export function CharacterIdentityBlock({
  orientation, displayAvatar, avaInputRef, onAvatarPick, onOpenThumbnailCrop,
  form, characterId, isSaving, isMobile,
}: CharacterIdentityBlockProps) {
  const { t } = useT();
  const { register } = form;

  return orientation === "landscape" && displayAvatar ? (
    /* Landscape: full-width avatar above name/tags */
    <div className="mb-5 flex flex-col items-center gap-3">
      <CustomTooltip content={t("change_avatar")}>
      <div
        className="group relative cursor-pointer overflow-hidden rounded-lg"
        onClick={() => avaInputRef.current?.click()}
      >
        <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => onAvatarPick(e.target.files)} />
        <img src={displayAvatar} alt="" className="block rounded-lg" style={{ maxWidth: isMobile ? 400 : 480, maxHeight: 280, objectFit: "contain" }} />
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
        <CustomTooltip content={t("edit_thumbnail")}>
          <button type="button"
            aria-label={t("edit_thumbnail")}
            className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface/90 text-t2 shadow-sm backdrop-blur transition-colors hover:text-accent-t"
            onClick={(e) => { e.stopPropagation(); onOpenThumbnailCrop(); }}
          ><Ic.crop /></button>
        </CustomTooltip>
      </div>
      </CustomTooltip>
      <div className="w-full flex flex-col gap-3">
        <div>
          <label className={lblCls}>{t("char_name_label")}</label>
          <TextInput disabled={isSaving} register={register("name")} />
        </div>
        <TagsField form={form} isSaving={isSaving} />
        <BoundResourcesField entityKind="character" entityId={characterId} isMobile={isMobile} />
      </div>
    </div>
  ) : (
  /* Portrait / no avatar: side-by-side layout */
  <div className={cn("mb-5 gap-5", isMobile ? "flex flex-col items-center" : "flex")}>
    <CustomTooltip content={t("change_avatar")}>
    <div
      className={cn(
        "group relative shrink-0 cursor-pointer rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t",
        isMobile ? "w-full max-w-[280px]" : "max-w-[180px] self-start"
      )}
      style={isMobile ? { aspectRatio: "auto" } : { maxWidth: 180, maxHeight: 250 }}
      onClick={() => avaInputRef.current?.click()}
    >
      <input ref={avaInputRef} type="file" className="hidden" accept="image/*" onChange={(e) => onAvatarPick(e.target.files)} />
      {displayAvatar ? (
        <>
          <img src={displayAvatar} alt="" className={cn("block", isMobile ? "w-full" : "max-w-[180px]")} style={isMobile ? undefined : { maxHeight: 250, objectFit: "contain" }} />
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
          <CustomTooltip content={t("edit_thumbnail")}>
            <button type="button"
              aria-label={t("edit_thumbnail")}
              className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface/90 text-t2 shadow-sm backdrop-blur transition-colors hover:text-accent-t"
              onClick={(e) => { e.stopPropagation(); onOpenThumbnailCrop(); }}
            ><Ic.crop /></button>
          </CustomTooltip>
        </>
      ) : (
        <div className={cn("flex flex-col items-center justify-center gap-1.5 text-t3 transition-colors group-hover:text-accent-t", isMobile ? "min-h-[120px] w-full" : "h-20 w-28")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <span className="font-ui text-[calc(var(--ui-fs)-4px)] tracking-wide">{t("upload_avatar")}</span>
        </div>
      )}
    </div>
    </CustomTooltip>
    <div className={cn("flex min-w-0 flex-1 flex-col gap-3", isMobile && "w-full")}>
      <div>
        <label className={lblCls}>{t("char_name_label")}</label>
        <TextInput disabled={isSaving} register={register("name")} />
      </div>
      <TagsField form={form} isSaving={isSaving} />
      <BoundResourcesField entityKind="character" entityId={characterId} isMobile={isMobile} />
    </div>
  </div>
  );
}
