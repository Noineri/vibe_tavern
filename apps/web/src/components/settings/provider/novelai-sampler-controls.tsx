import type { ReactNode } from 'react';
import { PHRASE_REP_PEN, THINKING_MODE, type SamplerFieldId } from '@vibe-tavern/domain';
import { useT } from '../../../i18n/context.js';
import type { ProviderSamplerOnChange, ProviderSamplerValues } from '../../../lib/provider-sampler-values.js';
import { cn } from '../../../lib/cn.js';
import { CustomTooltip } from '../../shared/Tooltip.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { DropdownSelect } from '../../shared/DropdownSelect.js';

// NAI-4a NovelAI-only sampler controls, extracted for the ProviderSamplerPanel
// file-size ratchet; shared primitives remain the panel's canonical controls.

interface NovelaiSamplerControlProps {
  values: ProviderSamplerValues;
  onChange: ProviderSamplerOnChange;
  supports: (field: SamplerFieldId) => boolean;
}

interface NovelaiSamplerFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  tooltip?: string;
  isInteger?: boolean;
  disabled?: boolean;
}

interface NovelaiSamplerNumberFieldsProps extends NovelaiSamplerControlProps {
  disabled: boolean;
  renderSamplerField: (props: NovelaiSamplerFieldProps) => ReactNode;
}

export function NovelaiThinkingModeControl({ values, onChange, supports }: NovelaiSamplerControlProps) {
  const { t, tDynamic } = useT();
  if (!supports('thinkingMode')) return null;

  return (
    <div>
      <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
        {t("thinking_mode")}
      </label>
      <SegmentedControl
        value={values.thinkingMode}
        options={Object.values(THINKING_MODE).map((value) => ({
          value,
          label: tDynamic(`thinking_mode_${value}`),
        }))}
        onChange={(next) => {
          const value = Object.values(THINKING_MODE).find((option) => option === next);
          if (value) onChange('thinkingMode', value);
        }}
        mobileSelect
      />
    </div>
  );
}

export function NovelaiSamplerNumberFields({
  values,
  onChange,
  supports,
  disabled,
  renderSamplerField,
}: NovelaiSamplerNumberFieldsProps) {
  const { t } = useT();

  return (
    <>
      {supports('unifiedLinear') && renderSamplerField({
        label: t("sampler_unified_linear"),
        tooltip: t("sampler_unified_linear_hint"),
        min: 0,
        max: 1,
        step: 0.01,
        value: values.unifiedLinear,
        onChange: (value) => onChange('unifiedLinear', value),
        disabled,
      })}
      {supports('unifiedQuad') && renderSamplerField({
        label: t("sampler_unified_quad"),
        tooltip: t("sampler_unified_quad_hint"),
        min: 0,
        max: 0.4,
        step: 0.01,
        value: values.unifiedQuad,
        onChange: (value) => onChange('unifiedQuad', value),
        disabled,
      })}
      {supports('unifiedConf') && renderSamplerField({
        label: t("sampler_unified_conf"),
        tooltip: t("sampler_unified_conf_hint"),
        min: -0.4,
        max: 0,
        step: 0.01,
        value: values.unifiedConf,
        onChange: (value) => onChange('unifiedConf', value),
        disabled,
      })}
      {supports('repetitionPenaltySlope') && renderSamplerField({
        label: t("sampler_repetition_penalty_slope"),
        min: 0,
        max: 10,
        step: 0.01,
        value: values.repetitionPenaltySlope,
        onChange: (value) => onChange('repetitionPenaltySlope', value),
        disabled,
      })}
    </>
  );
}

export function NovelaiPhraseRepPenControl({ values, onChange, supports }: NovelaiSamplerControlProps) {
  const { t, tDynamic } = useT();
  if (!supports('phraseRepPen')) return null;

  return (
    <div className={cn("mt-4", !values.customSamplers && "opacity-40 pointer-events-none")}>
      <label className="mb-[7px] flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
        <span>{t("sampler_phrase_rep_pen")}</span>
        <CustomTooltip content={t("sampler_phrase_rep_pen_hint")} side="top" align="start">
          <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border2 bg-s3 text-[10px] font-semibold normal-case tracking-normal text-t3">?</span>
        </CustomTooltip>
      </label>
      <DropdownSelect
        value={values.phraseRepPen}
        options={Object.values(PHRASE_REP_PEN).map((value) => ({
          id: value,
          label: tDynamic(`sampler_phrase_rep_pen_${value}`),
        }))}
        onChange={(next) => {
          const value = Object.values(PHRASE_REP_PEN).find((option) => option === next);
          if (value) onChange('phraseRepPen', value);
        }}
        disabled={!values.customSamplers}
      />
    </div>
  );
}
