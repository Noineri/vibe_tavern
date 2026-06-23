/**
 * Reusable labeled text-area field for the Build Mode character form.
 *
 * Encapsulates the most-repeated pattern in `CharacterForm`: an uppercase
 * label, a `MobileExpandTextarea`-wrapped `AutoTextarea` bound to one
 * react-hook-form field, and a trailing token-count badge. Both the classic
 * `CharacterForm` and the future Vibe MD view's metadata/instructions
 * accordions compose field surfaces from this primitive.
 *
 * The two label props exist because the field label (shown above the input on
 * desktop) and the `MobileExpandTextarea` label (shown in the mobile fullscreen
 * editor title) are intentionally distinct for some fields (e.g.
 * `first_message_greeting` vs `first_message_label`).
 */

import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";

import { useTokenCount } from "../../../hooks/use-token-count.js";
import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { inputPad, inputCls, monoCls, lblCls } from "./field-styles.js";

/** Draft field names whose value is a plain string rendered as a textarea. */
export type CharacterStringField =
  | "description"
  | "firstMessage"
  | "mesExample"
  | "scenario"
  | "personalitySummary"
  | "systemPrompt"
  | "postHistoryInstructions"
  | "creatorNotes"
  | "depthPrompt";

export interface TextAreaFieldProps {
  /** The react-hook-form instance (shared with the parent form). */
  form: UseFormReturn<BuildCharacterDraft>;
  /** Draft field name to bind. */
  field: CharacterStringField;
  /** Label rendered above the input (desktop). */
  label: string;
  /** Title used by the mobile fullscreen editor (may differ from `label`). */
  mobileExpandLabel: string;
  /** Minimum textarea height in px. */
  minHeight: number;
  /** Use the monospace variant (prompt-instruction fields). */
  mono?: boolean;
  /** Optional placeholder text. */
  placeholder?: string;
  /** Disable the input while a save is in flight. */
  isSaving: boolean;
}

/** A labeled text-area field bound to a react-hook-form controller. */
export function TextAreaField({
  form,
  field,
  label,
  mobileExpandLabel,
  minHeight,
  mono,
  placeholder,
  isSaving,
}: TextAreaFieldProps) {
  const { register, watch, setValue } = form;
  const value = watch(field);
  const isMobile = useIsMobile();
  const mInput = isMobile ? " text-base" : "";
  const cls = (mono ? monoCls : inputCls) + mInput;
  return (
    <div className="mb-5">
      <label className={lblCls + " mb-1.5 block"}>{label}</label>
      <MobileExpandTextarea value={value || ""} onChange={(v) => setValue(field, v)} label={mobileExpandLabel}>
        <AutoTextarea
          className={cls}
          style={{ ...inputPad, minHeight }}
          disabled={isSaving}
          placeholder={placeholder}
          register={register(field)}
        />
      </MobileExpandTextarea>
      <TokenBadge text={value || ""} />
    </div>
  );
}

/** Small inline token-count badge shown beneath a field. */
export function TokenBadge({ text }: { text: string }) {
  const count = useTokenCount(text);
  const { t } = useT();
  return (
    <span className="flex justify-end font-ui text-[11px] tabular-nums text-t3">
      {count.toLocaleString()} {t("tokens_label")}
    </span>
  );
}
