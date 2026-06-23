/**
 * Reusable Depth Prompt field for the Build Mode character form.
 *
 * The depth prompt has a richer surface than the plain text fields: a role
 * segmented control (system / user / assistant) and a depth `NumberInput`
 * sit in a header row above the monospace prompt textarea. Because the role
 * and depth controls bypass react-hook-form's `register` (they are custom
 * controls), their updates go through `setValue(..., { shouldDirty: true })`;
 * the textarea itself stays registered and therefore does not need
 * `shouldDirty`. This mirrors `CharacterForm`'s original behavior exactly.
 */

import type { UseFormReturn } from "react-hook-form";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";

import { useT } from "../../../i18n/context.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { inputPad, monoCls, lblCls } from "./field-styles.js";
import { TokenBadge } from "./TextAreaField.js";

export interface DepthPromptFieldProps {
  /** The react-hook-form instance (shared with the parent form). */
  form: UseFormReturn<BuildCharacterDraft>;
  /** Disable the controls while a save is in flight. */
  isSaving: boolean;
}

/** Depth prompt field: role + depth controls + monospace prompt textarea + token badge. */
export function DepthPromptField({ form, isSaving }: DepthPromptFieldProps) {
  const { t } = useT();
  const { register, watch, setValue } = form;
  const depthPrompt = watch("depthPrompt");
  const depthPromptRole = watch("depthPromptRole");
  const depthPromptDepth = watch("depthPromptDepth");
  const isMobile = useIsMobile();
  const mInput = isMobile ? " text-base" : "";
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className={lblCls}>{t("depth_prompt")}</label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-1 sm:min-w-fit">
            <SegmentedControl
              value={depthPromptRole || "system"}
              options={[
                { value: "system", label: "system" },
                { value: "user", label: "user" },
                { value: "assistant", label: "assistant" },
              ]}
              onChange={(v) => setValue("depthPromptRole", v, { shouldDirty: true })}
              disabled={isSaving}
              compact
              mobileFill
            />
          </div>
          <div className="flex min-h-8 items-center justify-between gap-2 sm:justify-start">
            <span className="font-ui text-[10px] uppercase tracking-[0.06em] text-t3">{t("depth")}</span>
            <NumberInput
              className="h-8 w-[100px] sm:h-6 sm:w-[90px]"
              min={0}
              max={999}
              disabled={isSaving}
              value={depthPromptDepth ?? 4}
              onChange={(v) => setValue("depthPromptDepth", v, { shouldDirty: true })}
            />
          </div>
        </div>
      </div>
      <MobileExpandTextarea value={depthPrompt || ""} onChange={(v) => setValue("depthPrompt", v)} label={t("depth_prompt_label")}>
        <AutoTextarea
          className={monoCls + mInput}
          style={{ ...inputPad, minHeight: 60 }}
          disabled={isSaving}
          placeholder={t("depth_prompt_placeholder")}
          register={register("depthPrompt")}
        />
      </MobileExpandTextarea>
      <TokenBadge text={depthPrompt || ""} />
    </div>
  );
}
