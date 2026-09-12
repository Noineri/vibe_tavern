import { useRef } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Ic } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { TextInput } from "../shared/text-input.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import { BoundResourcesField } from "../shared/BoundResourcesField.js";
import { AvatarDescriptionField, type AvatarDescriptionPatch } from "../build/editors/AvatarDescriptionField.js";
import type { PersonaListItem, PersonaFormData } from "./PersonaModal.js";

interface PersonaCardEditorProps {
  /** The persona being edited (the master's selected row). */
  persona: PersonaListItem;
  /** The host's react-hook-form instance (stable) — the editor reads/writes it directly. */
  form: UseFormReturn<PersonaFormData>;
  isSaving: boolean;
  avatarUploading: boolean;
  /** Resolved display avatar URL (parent-computed from form + persona). */
  avatarDisplayUrl: string | null;
  isMobile: boolean;
  onAvatarSelected: (file: File) => void;
  /** Open the "adjust thumbnail" cropper on the existing avatar (D-1, CharacterForm clone). */
  onOpenThumbnailCrop: () => void;
  onAvatarPatch: (patch: AvatarDescriptionPatch) => void;
  onAvatarDescribe: (signal: AbortSignal) => Promise<void>;
}

/**
 * PersonaCardEditor — the editing view of a persona card, extracted from
 * PersonaModal's renderCard (PERSONA_MODAL_GOD_OBJECT_AUDIT.md, Finding 2 /
 * step 3). Owns the avatar + name + pronoun row, the description, the bound
 * lorebooks (BoundResourcesField, PR-12), and the avatar-in-prompt fields
 * (AvatarDescriptionField, out-of-band). Owns its own file-input ref and
 * pronoun option/field tables; reads/writes the shared react-hook-form
 * instance via the `form` prop. Rendered in the master-detail modal's detail
 * pane for the selected persona (PSM-1); the footer owns Save now.
 */
export function PersonaCardEditor({
  persona,
  form,
  isSaving,
  avatarUploading,
  avatarDisplayUrl,
  isMobile,
  onAvatarSelected,
  onOpenThumbnailCrop,
  onAvatarPatch,
  onAvatarDescribe,
}: PersonaCardEditorProps) {
  const { t } = useT();
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const editName = form.watch("name");
  const editDescription = form.watch("description");
  const editPronouns = form.watch("pronouns");
  const editPfSubjective = form.watch("pfSubjective");
  const editPfObjective = form.watch("pfObjective");
  const editPfPossessive = form.watch("pfPossessive");
  const editPfPossessivePronoun = form.watch("pfPossessivePronoun");
  const editPfReflexive = form.watch("pfReflexive");

  const PRONOUN_OPTIONS: { v: string; l: string }[] = [
    { v: "", l: t("pronouns_none") },
    { v: "he/him", l: "he/him" },
    { v: "she/her", l: "she/her" },
    { v: "they/them", l: "they/them" },
    { v: "it/its", l: "it/its" },
    { v: "custom", l: t("pronouns_custom") },
  ];

  // Five-field declension descriptors for the custom-pronoun form (PR-7).
  // Placeholder uses the he/him example for each slot.
  const PRONOUN_FORM_FIELDS: { key: "pfSubjective" | "pfObjective" | "pfPossessive" | "pfPossessivePronoun" | "pfReflexive"; label: string; placeholder: string; value: string }[] = [
    { key: "pfSubjective", label: t("pronoun_field_subjective"), placeholder: "he", value: editPfSubjective },
    { key: "pfObjective", label: t("pronoun_field_objective"), placeholder: "him", value: editPfObjective },
    { key: "pfPossessive", label: t("pronoun_field_possessive"), placeholder: "his", value: editPfPossessive },
    { key: "pfPossessivePronoun", label: t("pronoun_field_possessive_pronoun"), placeholder: "his", value: editPfPossessivePronoun },
    { key: "pfReflexive", label: t("pronoun_field_reflexive"), placeholder: "himself", value: editPfReflexive },
  ];

  return (
    <div className="w-full">
      {/* Avatar + Name + Pronouns row. D-4: mobile stacks like the character
          card's portrait branch (flex-col items-center, avatar w-full
          max-w-[280px], name column w-full); desktop keeps the side-by-side
          layout. Spacing constants (gap-3/mb-3) keep the persona pane's
          rhythm, structure mirrors the reference. */}
      <div className={cn("gap-3 mb-3", isMobile ? "flex flex-col items-center" : "flex")}>
        {/* Avatar — character-card portrait pattern (CharacterForm.tsx portrait
            branch, D-1 clone): dashed rounded-lg frame that sizes to the image
            (contain, ≤180px wide / 250px tall), h-20 w-28 empty placeholder.
            With an avatar present: black/50 veil + pencil on hover (pick a new
            image via click, tooltip change_avatar) and the corner crop button
            (edit_thumbnail) opens the cropper on the EXISTING avatar so the
            512×512 thumbnail can be re-framed without re-uploading. No
            avatar-deletion affordance — the character card has none either
            (owner ruling 2026-09-07). Square crop (aspect 1) unchanged;
            pick→AvatarCropModal flow unchanged. */}
        <div className="group/ava relative shrink-0">
          <CustomTooltip content={t("change_avatar")}>
          <div
            className={cn(
              "group relative cursor-pointer overflow-hidden rounded-lg border border-dashed border-border2 bg-s2 text-t3 transition-all hover:border-accent hover:text-accent-t",
              isMobile ? "w-full max-w-[280px]" : "self-start",
              avatarUploading && "pointer-events-none opacity-60",
            )}
            style={isMobile ? { aspectRatio: "auto" } : undefined}
            onClick={() => !avatarUploading && avatarInputRef.current?.click()}
          >
            <input
              type="file" ref={avatarInputRef} accept="image/*" className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                e.target.value = "";
                onAvatarSelected(file);
              }}
            />
            {avatarDisplayUrl ? (
              <>
                <img src={avatarDisplayUrl} alt="" className={cn("block", isMobile && "w-full")} style={isMobile ? undefined : { maxWidth: 180, maxHeight: 250, objectFit: "contain" }} />
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"><Ic.edit /></div>
                <CustomTooltip content={t("edit_thumbnail")}>
                  <button type="button"
                    className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface/90 text-t2 shadow-sm backdrop-blur transition-colors hover:text-accent-t"
                    onClick={(e) => { e.stopPropagation(); onOpenThumbnailCrop(); }}
                  ><Ic.crop /></button>
                </CustomTooltip>
              </>
            ) : (
              <div className={cn("flex flex-col items-center justify-center gap-1.5 text-t3 transition-colors group-hover/ava:text-accent-t", isMobile ? "min-h-[120px] w-full" : "h-20 w-28")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                <span className="font-ui text-[10px] tracking-wide">{t("upload_avatar")}</span>
              </div>
            )}
          </div>
          </CustomTooltip>
        </div>
        {/* Name + Pronouns. D-4: full width on mobile (stacked under the
            avatar); D-3: bound lorebooks sit directly under this row — the
            character-card order (name → resources → description). */}
        <div className={cn("flex-1 min-w-0", isMobile && "w-full")}>
          <TextInput
            value={editName}
            onChange={(e) => form.setValue("name", e.target.value, { shouldDirty: true })}
            placeholder={t("persona_name_placeholder")}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PRONOUN_OPTIONS.map((opt) => (
              <button  key={opt.v}
                type="button"
                className={cn(
                  "rounded-md px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-2px)] transition-all",
                  editPronouns === opt.v
                    ? "bg-accent/20 text-accent-t ring-1 ring-accent/40"
                    : "bg-s3 text-t3 ring-1 ring-transparent hover:text-t2",
                )}
                onClick={() => form.setValue("pronouns", opt.v, { shouldDirty: true })}
              >
                {opt.l}
              </button>
            ))}
          </div>
          {editPronouns === "custom" && (
            <div className={cn("mt-2 grid gap-1.5", isMobile ? "grid-cols-1" : "grid-cols-2")}>
              {PRONOUN_FORM_FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-0.5 block font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{f.label}</span>
                  <TextInput
                    value={f.value}
                    onChange={(e) => form.setValue(f.key, e.target.value, { shouldDirty: true })}
                    placeholder={f.placeholder}
                  />
                </label>
              ))}
            </div>
          )}
          {/* Bound lorebooks — reverse-direction binding (PR-12), moved here in
              D-3 (character-card order: name → resources → description).
              mt-3 (D-5): breathing room under the pronouns block — the field's
              own root has no top margin; the character reference column gets
              this spacing from its gap-3.
              Shown only in the edit form (requires a persisted personaId).
              Scripts are tracked separately — see script-link-binding-gap.md. */}
          <div className="mt-3">
            <BoundResourcesField entityKind="persona" entityId={persona.id} isMobile={isMobile} />
          </div>
        </div>
      </div>
      {/* Description */}
      <div className="relative mb-3">
        <MobileExpandTextarea
          value={editDescription}
          onChange={(v) => form.setValue("description", v, { shouldDirty: true })}
          label={t("persona_desc_placeholder")}
        >
          <AutoTextarea
            minRows={3}
            value={editDescription}
            onChange={(e) => form.setValue("description", e.target.value, { shouldDirty: true })}
            placeholder={t("persona_desc_placeholder")}
          />
        </MobileExpandTextarea>
        <div className="absolute bottom-2 right-2">
          <TokenCounter text={editDescription} className="font-ui text-[11px] tabular-nums text-t3" />
        </div>
      </div>
      {/* Avatar-in-prompt — describe via vision + toggle + description.
          Out-of-band from this modal's form (see onAvatarPatch). */}
      <div className="mb-3">
        <AvatarDescriptionField
          kind="persona"
          includeAvatarInPrompt={persona.includeAvatarInPrompt}
          avatarDescription={persona.avatarDescription}
          hasAvatar={!!(persona.avatarAssetId || avatarDisplayUrl)}
          onPatch={onAvatarPatch}
          onDescribe={onAvatarDescribe}
          disabled={isSaving}
        />
      </div>
    </div>
  );
}
