/**
 * Reusable Tags field for the Build Mode character form.
 *
 * Self-contained: owns the pending-input local state and the add/remove logic
 * (via react-hook-form `setValue("tags", ...)`). The tag input is NOT a
 * registered field — it is a local controlled input whose committed value
 * updates the `tags` array — so every mutation goes through
 * `setValue(..., { shouldDirty: true })` (mirroring `CharacterForm`'s original
 * behavior). Extracted so both the classic form's avatar/name/tags layout and
 * the future Vibe MD metadata accordion render the SAME tags surface.
 */

import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";

import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { inputPad, inputCls, lblCls } from "./field-styles.js";

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
  const [tagInput, setTagInput] = useState("");
  const isMobile = useIsMobile();
  const mInput = isMobile ? " text-base" : "";
  const tags = watch("tags") || [];

  function toggleTag(tag: string) {
    const next = tags.includes(tag) ? tags.filter((x: string) => x !== tag) : [...tags, tag];
    setValue("tags", next, { shouldDirty: true });
  }

  function handleTagKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && tagInput.trim()) {
      e.preventDefault();
      if (!tags.includes(tagInput.trim())) setValue("tags", [...tags, tagInput.trim()], { shouldDirty: true });
      setTagInput("");
    }
  }

  return (
    <div>
      <label className={lblCls + " mb-1.5 block"}>{t("char_tags_label")}</label>
      <input
        type="text"
        className={inputCls + mInput}
        style={inputPad}
        value={tagInput}
        disabled={isSaving}
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={handleTagKey}
        placeholder={t("tags_enter")}
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {tags.map((tag: string) => (
          <span
            key={tag}
            className="cursor-pointer rounded bg-accent-dim px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1"
            onClick={() => toggleTag(tag)}
          >
            {tag} ✕
          </span>
        ))}
      </div>
    </div>
  );
}
