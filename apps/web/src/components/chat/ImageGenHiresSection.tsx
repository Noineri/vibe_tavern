/**
 * The fine-tuning chip's hires-fix block (FT-A6): a toggle revealing the
 * A1111 second pass's four SEPARATE knobs (owner 2026-09-17: «отдельные
 * ручки нужны») — upscaler dropdown + steps + scale + denoise.
 *
 * Contract mirrors the chip's established idioms:
 * - the toggle row is the ADetailer twin (`justify-between` + shared
 *   `Toggle`); off = COLLAPSED (the plan's acceptance line), the block
 *   persists in the draft through toggle-off like every chip field;
 * - numeric knobs are the model-settings overlay's slider cells: display
 *   the anchor for an UNSET field and commit on interaction — the anchors
 *   are the server's own defaults (processing.py: hr_scale 2.0,
 *   denoising_strength 0.75, hr_second_pass_steps 0 = inherit), so an
 *   untouched slider tells the truth about what the server will do;
 * - the upscaler dropdown is the DiT-sidecar twin: {id:""} = Auto with
 *   `defaultOption`, a stored value outside the live list stays pickable
 *   (the since-removed-files rule).
 *
 * Gated upstream on `capabilities.supportsHiresFix` — the chip never
 * fetches for an unsupported profile (the route 400s; the samplers/
 * loras gate precedent).
 */

import { DropdownSelect } from "../shared/DropdownSelect.js";
import { SliderField } from "../shared/SliderField.js";
import { Toggle } from "../shared/Toggle.js";
import { IMAGE_GEN_PARAM_RANGES } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { EMPTY_IMAGE_GEN_DRAFT, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import type { ImageGenUpscaler } from "../../api/image-gen-api.js";

/** Display anchors for UNSET knobs = the A1111 server's own defaults
 *  (processing.py) — an untouched slider shows what will actually run,
 *  the FT-A2 «Auto» honesty rule; nothing is committed until the user
 *  touches the control. */
const HIRES_DISPLAY_DEFAULTS = {
  steps: 0,
  scale: 2,
  denoisingStrength: 0.75,
} as const;

export interface ImageGenHiresSectionProps {
  chatId: string;
  /** The live upscaler list (null = loading). */
  upscalers: ImageGenUpscaler[] | null;
  failed: boolean;
  disabled: boolean;
}

export function ImageGenHiresSection({ chatId, upscalers, failed, disabled }: ImageGenHiresSectionProps) {
  const { t } = useT();
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setHires = useImageGenChatStore((s) => s.setFineTuningHires);
  const block = draft.hires ?? { enabled: false };
  const enabled = block.enabled;

  return (
    <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-hires">
      {/* The toggle row — the ADetailer twin. */}
      <div className="flex items-center justify-between gap-2 px-1.5">
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t2" data-testid="image-gen-ft-hires-label">
          {t("image_gen_hires_label")}
        </span>
        <Toggle
          checked={enabled}
          onChange={(checked) => setHires(chatId, { enabled: checked })}
          disabled={disabled}
          aria-label={t("image_gen_hires_label")}
        />
      </div>

      {enabled && (
        <div className="flex flex-col gap-2 px-1.5" data-testid="image-gen-ft-hires-body">
          <div className="flex flex-col gap-1.5">
            <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
              {t("image_gen_hires_upscaler_label")}
            </span>
            <DropdownSelect
              value={block.upscaler ?? ""}
              defaultOption={t("image_gen_hires_upscaler_auto")}
              options={[
                { id: "", label: t("image_gen_hires_upscaler_auto") },
                ...(upscalers ?? []).map((u) => ({ id: u.name, label: u.name })),
                // A stored pick outside the live list stays pickable — the
                // server may have dropped the model since (the DiT twin).
                ...(block.upscaler !== undefined &&
                block.upscaler !== "" &&
                !(upscalers ?? []).some((u) => u.name === block.upscaler)
                  ? [{ id: block.upscaler, label: block.upscaler }]
                  : []),
              ]}
              onChange={(id) => setHires(chatId, { upscaler: id === "" ? undefined : id })}
              disabled={disabled}
              triggerTestId="image-gen-ft-hires-upscaler"
            />
            {failed && (
              <span
                className="px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4"
                data-testid="image-gen-ft-hires-failed"
              >
                {t("image_gen_hires_upscalers_failed")}
              </span>
            )}
          </div>

          <SliderField
            label={t("image_gen_hires_steps_label")}
            value={block.steps ?? HIRES_DISPLAY_DEFAULTS.steps}
            min={IMAGE_GEN_PARAM_RANGES.hiresSteps.min}
            max={IMAGE_GEN_PARAM_RANGES.hiresSteps.max}
            step={IMAGE_GEN_PARAM_RANGES.hiresSteps.step}
            onChange={(value) => setHires(chatId, { steps: value })}
            disabled={disabled}
            rangeTestId="image-gen-ft-hires-steps"
          />
          <SliderField
            label={t("image_gen_hires_scale_label")}
            value={block.scale ?? HIRES_DISPLAY_DEFAULTS.scale}
            min={IMAGE_GEN_PARAM_RANGES.hiresScale.min}
            max={IMAGE_GEN_PARAM_RANGES.hiresScale.max}
            step={IMAGE_GEN_PARAM_RANGES.hiresScale.step}
            onChange={(value) => setHires(chatId, { scale: value })}
            disabled={disabled}
            rangeTestId="image-gen-ft-hires-scale"
          />
          <SliderField
            label={t("image_gen_hires_denoise_label")}
            value={block.denoisingStrength ?? HIRES_DISPLAY_DEFAULTS.denoisingStrength}
            min={IMAGE_GEN_PARAM_RANGES.hiresDenoise.min}
            max={IMAGE_GEN_PARAM_RANGES.hiresDenoise.max}
            step={IMAGE_GEN_PARAM_RANGES.hiresDenoise.step}
            onChange={(value) => setHires(chatId, { denoisingStrength: value })}
            disabled={disabled}
            rangeTestId="image-gen-ft-hires-denoise"
          />
        </div>
      )}
    </div>
  );
}
