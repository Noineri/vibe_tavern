/**
 * The fine-tuning chip's hires-fix block (FT-A6): a toggle revealing the
 * A1111 second pass's four SEPARATE knobs (owner ruling 2026-09-17:
 * separate hires knobs, not one merged toggle — see
 * plans/FINE_TUNING_CHIP_REBUILD_PLAN.md) — upscaler dropdown + steps +
 * scale + denoise.
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

// fork #1 of the hires field block (source: model-controls buildHiresControl renders via this idiom)
// Correspondence: toggle row, upscaler dropdown, and three shared-descriptor sliders.
// Deviations: chip column chrome and failed hint.

import { DropdownSelect } from "../shared/DropdownSelect.js";
import { SliderField } from "../shared/SliderField.js";
import { Toggle } from "../shared/Toggle.js";
import { useT } from "../../i18n/context.js";
import { buildHiresControl, translateModelOptions } from "../../lib/imagegen/model-controls.js";
import { EMPTY_IMAGE_GEN_DRAFT, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import type { ImageGenUpscaler } from "../../api/image-gen-api.js";

export interface ImageGenHiresSectionProps {
  chatId: string;
  /** The live upscaler list (null = loading). */
  upscalers: ImageGenUpscaler[] | null;
  failed: boolean;
  disabled: boolean;
  supportsHiresFix: boolean;
}

export function ImageGenHiresSection({ chatId, upscalers, failed, disabled, supportsHiresFix }: ImageGenHiresSectionProps) {
  const { t } = useT();
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setHires = useImageGenChatStore((s) => s.setFineTuningHires);
  const block = draft.hires ?? { enabled: false };
  const enabled = block.enabled;
  const hiresControl = buildHiresControl({ supportsHiresFix });
  if (hiresControl === null) return null;
  const [hiresSteps, hiresScale, hiresDenoise] = hiresControl.sliders;

  return (
    <div className="flex flex-col gap-1.5" data-testid="image-gen-ft-hires">
      {/* The toggle row — the ADetailer twin. */}
      <div className="flex items-center justify-between gap-2 px-1.5">
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t2" data-testid="image-gen-ft-hires-label">
          {t(hiresControl.labelKey)}
        </span>
        <Toggle
          checked={enabled}
          onChange={(checked) => setHires(chatId, { enabled: checked })}
          disabled={disabled}
          aria-label={t(hiresControl.labelKey)}
        />
      </div>

      {enabled && (
        <div className="flex flex-col gap-2 px-1.5" data-testid="image-gen-ft-hires-body">
          <div className="flex flex-col gap-1.5">
            <span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t2">
              {t(hiresControl.upscalerLabelKey)}
            </span>
            <DropdownSelect
              value={block.upscaler ?? ""}
              defaultOption={t(hiresControl.upscalerAutoLabelKey)}
              options={translateModelOptions(hiresControl.upscalerOptions(upscalers, block.upscaler), t)}
              onChange={(id) => setHires(chatId, { upscaler: hiresControl.commitUpscaler(id) })}
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
            label={t(hiresSteps.labelKey)}
            value={block.steps ?? hiresSteps.displayAnchor}
            min={hiresSteps.range.min}
            max={hiresSteps.range.max}
            step={hiresSteps.range.step}
            onChange={(value) => setHires(chatId, { steps: value })}
            disabled={disabled}
            rangeTestId="image-gen-ft-hires-steps"
          />
          <SliderField
            label={t(hiresScale.labelKey)}
            value={block.scale ?? hiresScale.displayAnchor}
            min={hiresScale.range.min}
            max={hiresScale.range.max}
            step={hiresScale.range.step}
            onChange={(value) => setHires(chatId, { scale: value })}
            disabled={disabled}
            rangeTestId="image-gen-ft-hires-scale"
          />
          <SliderField
            label={t(hiresDenoise.labelKey)}
            value={block.denoisingStrength ?? hiresDenoise.displayAnchor}
            min={hiresDenoise.range.min}
            max={hiresDenoise.range.max}
            step={hiresDenoise.range.step}
            onChange={(value) => setHires(chatId, { denoisingStrength: value })}
            disabled={disabled}
            rangeTestId="image-gen-ft-hires-denoise"
          />
        </div>
      )}
    </div>
  );
}
