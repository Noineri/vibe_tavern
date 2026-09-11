/**
 * Reusable Tags field for the Build Mode character form.
 *
 * Thin wrapper over the shared `ChipInput` words mode: the `tags` array
 * rides the parent form via `setValue(..., { shouldDirty: true })` (mirroring
 * `CharacterForm`'s original behavior). Extracted so both the classic form's
 * avatar/name/tags layout and the future Vibe MD metadata accordion render
 * the SAME tags surface.
 */

import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";

import { useT } from "../../../i18n/context.js";
import { ChipInput } from "../../shared/ChipInput.js";
import { lblCls } from "../../../lib/field-tokens.js";

export interface TagsFieldProps {
  /** The react-hook-form instance (shared with the parent form). */
  form: UseFormReturn<BuildCharacterDraft>;
  /** Disable the input while a save is in flight. */
  isSaving: boolean;
}

/** Tags input + chip list, bound to the `tags` draft array. */
export function TagsField({ form, isSaving }: TagsFieldProps) {
  const { t } = useT();
  const { watch, setValue } = form;
  const tags = watch("tags") || [];

  return (
    <div>
      <label className={lblCls}>{t("char_tags_label")}</label>
      <ChipInput
        values={tags}
        onChange={(next) => setValue("tags", next, { shouldDirty: true })}
        mode="words"
        disabled={isSaving}
        placeholder={t("tags_enter")}
      />
    </div>
  );
}
