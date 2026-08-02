import { useRef } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import { SaveButton } from "../shared/SaveBar.js";
import { BoundResourcesField } from "../shared/BoundResourcesField.js";
import { AvatarDescriptionField, type AvatarDescriptionPatch } from "../build/editors/AvatarDescriptionField.js";
import type { PersonaListItem, PersonaFormData } from "./PersonaModal.js";

interface PersonaCardEditorProps {
  /** The persona being edited (rendered only when editingId === persona.id). */
  persona: PersonaListItem;
  /** The host's react-hook-form instance (stable) — the editor reads/writes it directly. */
  form: UseFormReturn<PersonaFormData>;
  isDirty: boolean;
  isSaving: boolean;
  avatarUploading: boolean;
  /** Resolved display avatar URL (parent-computed from form + persona). */
  avatarDisplayUrl: string | null;
  isMobile: boolean;
  onSave: () => void;
  onCancel: () => void;
  onAvatarSelected: (file: File) => void;
  onAvatarPatch: (patch: AvatarDescriptionPatch) => void;
  onAvatarDescribe: (signal: AbortSignal) => Promise<void>;
}

/**
 * PersonaCardEditor — the editing view of a persona card, extracted from
 * PersonaModal's renderCard (PERSONA_MODAL_GOD_OBJECT_AUDIT.md, Finding 2 /
 * step 3). Owns the avatar + name + pronoun row, the description, the bound
 * lorebooks (BoundResourcesField, PR-12), the avatar-in-prompt fields
 * (AvatarDescriptionField, out-of-band), and the Save/Cancel actions. Owns its
 * own file-input ref and pronoun option/field tables; reads/writes the shared
 * react-hook-form instance via the `form` prop. Rendered only when this card is
 * the one being edited.
 */
export function PersonaCardEditor({
  persona,
  form,
  isDirty,
  isSaving,
  avatarUploading,
  avatarDisplayUrl,
  isMobile,
  onSave,
  onCancel,
  onAvatarSelected,
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
    <div className="w-full" onClick={(e) => e.stopPropagation()}>
      {/* Avatar + Name + Pronouns row */}
      <div className={cn("flex gap-3 mb-3", isMobile ? "items-start" : "items-start")}>
        {/* Avatar */}
        <div className="group/ava relative shrink-0">
          <CustomTooltip content={t("upload_avatar")}>
          <div
            className={cn(
              "relative flex cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-border2 bg-s2 transition-all hover:border-accent",
              isMobile ? "h-[68px] w-[68px]" : "h-16 w-16",
              avatarUploading && "pointer-events-none opacity-60",
            )}
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
              <img src={avatarDisplayUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="text-t3 transition-colors group-hover/ava:text-accent-t">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </div>
            )}
          </div>
          </CustomTooltip>
          {avatarDisplayUrl && (
            <button type="button"
              className="absolute -right-1 -bottom-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-t4 opacity-0 transition-all hover:text-danger group-hover/ava:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                form.setValue("avatarAssetId", null, { shouldDirty: true });
                form.setValue("avatarPreview", null);
                if (avatarInputRef.current) avatarInputRef.current.value = "";
              }}
            >
              <Icons.Close />
            </button>
          )}
        </div>
        {/* Name + Pronouns */}
        <div className="flex-1 min-w-0">
          <input
            className="w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-sm text-t1 outline-none focus:border-accent"
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
                  <input
                    className="w-full rounded border border-border bg-s2 py-1.5 px-2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none focus:border-accent"
                    value={f.value}
                    onChange={(e) => form.setValue(f.key, e.target.value, { shouldDirty: true })}
                    placeholder={f.placeholder}
                  />
                </label>
              ))}
            </div>
          )}
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
            className="w-full rounded border border-border bg-s2 py-2 px-2.5 font-ui text-xs text-t1 outline-none resize-none focus:border-accent"
            style={{}}
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
      {/* Bound lorebooks — reverse-direction binding (PR-12). Shown only
          in the edit form (requires a persisted personaId). Scripts are
          tracked separately — see script-link-binding-gap.md. */}
      <BoundResourcesField entityKind="persona" entityId={persona.id} isMobile={isMobile} />
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
      {/* Save / Cancel */}
      <div className="flex gap-2">
        <SaveButton
          dirty={isDirty}
          saveState={isSaving ? "saving" : "idle"}
          resetKey={persona.id}
          disabled={isSaving || !(editName || "").trim()}
          label={t("save_btn")}
          onClick={onSave}
          size="touch"
        />
        <button type="button"
          className="min-h-[40px] cursor-pointer rounded-md bg-transparent px-3.5 font-ui text-sm text-t3 active:bg-s2"
          onClick={onCancel}
        >
          {t("cancel_btn")}
        </button>
      </div>
    </div>
  );
}
