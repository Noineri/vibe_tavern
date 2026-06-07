import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n/context.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { ChipInput } from '../../shared/ChipInput.js';
import { LogitBiasPanel } from './LogitBiasPanel.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { CustomTooltip } from '../../shared/Tooltip.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import type { SamplerCapabilityFlags, SamplerFieldId } from '@vibe-tavern/domain';
import { NumberInput } from '../../shared/NumberInput.js';

/* ── SamplerField sub-component ────────────────────────────────────── */

interface SamplerFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  tooltip?: string;
  isInteger?: boolean;
  disabled?: boolean;
}

function SamplerField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  tooltip,
  isInteger = false,
  disabled = false,
}: SamplerFieldProps) {
  const val = value ?? min;

  // Range always commits immediately (no typing involved)
  const handleRangeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = isInteger ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
    if (!isNaN(v)) onChange(v);
  };

  return (
    <div className="mb-0 flex flex-col justify-end">
      <label className="mb-[7px] flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
        <span>{label}</span>
        {tooltip && (
          <CustomTooltip content={tooltip} side="top" align="start">
            <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border2 bg-s3 text-[10px] font-semibold normal-case tracking-normal text-t3">?</span>
          </CustomTooltip>
        )}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={handleRangeChange}
          disabled={disabled}
          className={cn(
            "!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent p-0",
            disabled && "opacity-40"
          )}
        />
        <NumberInput
          className="h-[30px] w-[60px] shrink-0"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={onChange}
          disabled={disabled}
          hideControls
        />
      </div>
    </div>
  );
}

/* ── Toggle sub-component ──────────────────────────────────────────── */

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ label, checked, onChange }: ToggleProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
      <div
        className={cn("relative h-5 w-9 rounded-full transition-colors cursor-pointer", checked ? "bg-accent" : "bg-s3")}
        onClick={() => onChange(!checked)}
      >
        <div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </div>
      <div className="font-ui text-[13px] font-medium text-t1">{label}</div>
    </div>
  );
}

/* ── Inline number field with blur-commit ─────────────────────── */

function InlineNumField({
  value,
  placeholder,
  onBlur,
}: {
  value: number;
  placeholder?: string;
  onBlur: (v: number) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const displayValue = raw !== null ? raw : (value || '');
  return (
    <NumberInput
      className="h-[38px] w-full"
      hideControls
      value={value}
      onChange={(v) => onBlur(v)}
    />
  );
}

/* ── ProviderSamplerPanel ───────────────────────────────────────────── */

const selectCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent pl-[13px] sel-arrow';
const textInputCls =
  'h-[38px] w-full rounded-md border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent';

/** Default sampler values when custom samplers are toggled ON. */
const CUSTOM_SAMPLER_DEFAULTS = {
  topP: 0.95,
  topK: 75,
  topA: 1.0,
  minP: 0,
  typicalP: 1.0,
  tfsZ: 1.0,
  repeatLastN: 0,
  mirostat: 0,
  mirostatTau: 5.0,
  mirostatEta: 0.1,
  dryMultiplier: 0,
  dryBase: 1.75,
  dryAllowedLength: 2,
  drySequenceBreakers: [] as string[],
  xtcThreshold: 0.1,
  xtcProbability: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  repetitionPenalty: 0,
} as const;

interface ProviderSamplerPanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  capabilities?: { logitBias?: boolean; samplers?: SamplerCapabilityFlags; [k: string]: unknown } | null;
}

export function ProviderSamplerPanel({ form, updateForm, capabilities }: ProviderSamplerPanelProps) {
  const { t } = useT();
  const [advOpen, setAdvOpen] = useState(false);
  const disabled = !form.customSamplers;
  const samplerCaps = capabilities?.samplers;
  const supports = (field: SamplerFieldId) => samplerCaps?.[field] ?? true;

  const handleToggleCustomSamplers = (enabled: boolean) => {
    if (enabled) {
      // Apply custom sampler defaults when enabling
      updateForm('customSamplers', true);
      updateForm('topP', CUSTOM_SAMPLER_DEFAULTS.topP);
      updateForm('topK', CUSTOM_SAMPLER_DEFAULTS.topK);
      updateForm('topA', CUSTOM_SAMPLER_DEFAULTS.topA);
      updateForm('minP', CUSTOM_SAMPLER_DEFAULTS.minP);
      updateForm('typicalP', CUSTOM_SAMPLER_DEFAULTS.typicalP);
      updateForm('tfsZ', CUSTOM_SAMPLER_DEFAULTS.tfsZ);
      updateForm('repeatLastN', CUSTOM_SAMPLER_DEFAULTS.repeatLastN);
      updateForm('mirostat', CUSTOM_SAMPLER_DEFAULTS.mirostat);
      updateForm('mirostatTau', CUSTOM_SAMPLER_DEFAULTS.mirostatTau);
      updateForm('mirostatEta', CUSTOM_SAMPLER_DEFAULTS.mirostatEta);
      updateForm('dryMultiplier', CUSTOM_SAMPLER_DEFAULTS.dryMultiplier);
      updateForm('dryBase', CUSTOM_SAMPLER_DEFAULTS.dryBase);
      updateForm('dryAllowedLength', CUSTOM_SAMPLER_DEFAULTS.dryAllowedLength);
      updateForm('drySequenceBreakers', CUSTOM_SAMPLER_DEFAULTS.drySequenceBreakers);
      updateForm('xtcThreshold', CUSTOM_SAMPLER_DEFAULTS.xtcThreshold);
      updateForm('xtcProbability', CUSTOM_SAMPLER_DEFAULTS.xtcProbability);
      updateForm('frequencyPenalty', CUSTOM_SAMPLER_DEFAULTS.frequencyPenalty);
      updateForm('presencePenalty', CUSTOM_SAMPLER_DEFAULTS.presencePenalty);
      updateForm('repetitionPenalty', CUSTOM_SAMPLER_DEFAULTS.repetitionPenalty);
      setAdvOpen(true);
    } else {
      updateForm('customSamplers', false);
    }
  };

  return (
    <div className="mb-4">
      {/* ── Basic settings ── */}
      <div className="mt-5 ml-0 mb-3 pb-2 border-b border-border2 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold uppercase tracking-[0.05em] text-t3">
        {t("sampler_basic_settings")}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {/* Max tokens */}
        <div>
          <CustomTooltip content={t("sampler_max_context_hint")}>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            {t("sampler_max_context")}
          </label>
          </CustomTooltip>
          <InlineNumField
            value={form.maxTokens}
            placeholder="-1"
            onBlur={(v) => updateForm('maxTokens', v)}
          />
        </div>

        {/* Context budget */}
        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            {t("context_length")}
          </label>
          <div className="flex items-center gap-1.5">
            <InlineNumField
              value={form.contextBudget}
              placeholder={t("context_auto")}
              onBlur={(v) => updateForm('contextBudget', v)}
            />
            <CustomTooltip content={form.pinContextBudget ? t("context_pin_locked") : t("context_pin_unlocked")}>
              <button type="button"
                className={cn(
                  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md border transition-colors",
                  form.pinContextBudget
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border bg-s2 text-t3 hover:border-border2 hover:text-t2",
                )}
                onClick={() => updateForm('pinContextBudget', !form.pinContextBudget)}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {form.pinContextBudget
                    ? <><path d="M9.828 1.172a2.828 2.828 0 1 1 4 4L12.5 6.5l-4-4 1.328-1.328z"/><path d="M5 14l-3 1 1-3 7.5-7.5 2 2L5 14z"/></>
                    : <><path d="M9.828 1.172a2.828 2.828 0 1 1 4 4L12.5 6.5l-4-4 1.328-1.328z"/><path d="M8 6.5 5 14l-3 1 1-3 7.5-7.5" strokeLinecap="round"/><line x1="4" y1="4" x2="12" y2="12"/></>
                  }
                </svg>
              </button>
            </CustomTooltip>
          </div>
        </div>

        {/* Temperature */}
        {supports('temperature') && (
          <SamplerField
            label={`${t("sampler_temperature")} (${form.temperature})`}
            tooltip={t("sampler_temperature_hint")}
            min={0}
            max={2}
            step={0.05}
            value={form.temperature}
            onChange={(v) => updateForm('temperature', v)}
          />
        )}

        {/* Reasoning effort */}
        {supports('reasoningEffort') && (
          <div>
            <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
              {t("reasoning_effort")}
            </label>
            <SegmentedControl
              value={form.reasoningEffort}
              options={[
                { value: "low", label: t("effort_low") },
                { value: "medium", label: t("effort_medium") },
                { value: "high", label: t("effort_high") },
              ]}
              onChange={(v) => updateForm('reasoningEffort', v)}
            />
          </div>
        )}
      </div>

      {/* Toggles: Streaming, Reasoning */}
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Toggle
          label={t("stream_response")}
          checked={form.streamResponse !== false}
          onChange={(v) => updateForm('streamResponse', v)}
        />
        <Toggle
          label={t("show_reasoning")}
          checked={form.showReasoning}
          onChange={(v) => updateForm('showReasoning', v)}
        />
      </div>

      {/* ── Advanced sampler accordion with toggle in header ── */}
      <div className="mt-4 overflow-hidden rounded-lg border border-border2">
        <div
          className={cn(
            'flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer',
            advOpen && '!rounded-b-none'
          )}
        >
          <span
            className="flex items-center gap-2"
            onClick={() => setAdvOpen(!advOpen)}
          >
            <span className={cn('transition-transform', advOpen && 'rotate-90')}>
              <Icons.Caret direction="r" />
            </span>
            {t("samplers_advanced")}
          </span>
          {/* Toggle switch right in the accordion header */}
          <div
            className={cn("relative h-5 w-9 rounded-full transition-colors cursor-pointer shrink-0", form.customSamplers ? "bg-accent" : "bg-s3")}
            onClick={(e) => { e.stopPropagation(); handleToggleCustomSamplers(!form.customSamplers); }}
          >
            <div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", form.customSamplers ? "translate-x-[18px]" : "translate-x-0.5")} />
          </div>
        </div>

        {advOpen && (
          <div className="border-t border-border2 bg-surface p-4">
            {/* Two-column sampler grid */}
            <div className={cn("grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4", disabled && "opacity-40 pointer-events-none")}>
              {supports('topP') && (
                <SamplerField
                  label={t("sampler_top_p")}
                  tooltip={t("sampler_top_p_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.topP}
                  onChange={(v) => updateForm('topP', v)}
                  disabled={disabled}
                />
              )}
              {supports('frequencyPenalty') && (
                <SamplerField
                  label={t("sampler_freq_penalty")}
                  tooltip={t("sampler_freq_penalty_hint")}
                  min={-2}
                  max={2}
                  step={0.1}
                  value={form.frequencyPenalty}
                  onChange={(v) => updateForm('frequencyPenalty', v)}
                  disabled={disabled}
                />
              )}
              {supports('topK') && (
                <SamplerField
                  label={t("sampler_top_k")}
                  tooltip={t("sampler_top_k_hint")}
                  min={0}
                  max={100}
                  step={1}
                  isInteger={true}
                  value={form.topK}
                  onChange={(v) => updateForm('topK', v)}
                  disabled={disabled}
                />
              )}
              {supports('presencePenalty') && (
                <SamplerField
                  label={t("sampler_pres_penalty")}
                  tooltip={t("sampler_pres_penalty_hint")}
                  min={-2}
                  max={2}
                  step={0.1}
                  value={form.presencePenalty}
                  onChange={(v) => updateForm('presencePenalty', v)}
                  disabled={disabled}
                />
              )}
              {supports('topA') && (
                <SamplerField
                  label={t("sampler_top_a")}
                  tooltip={t("sampler_top_a_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.topA ?? 0}
                  onChange={(v) => updateForm('topA', v)}
                  disabled={disabled}
                />
              )}
              {supports('repetitionPenalty') && (
                <SamplerField
                  label={t("sampler_rep_penalty")}
                  tooltip={t("sampler_rep_penalty_hint")}
                  min={0}
                  max={2}
                  step={0.05}
                  value={form.repetitionPenalty}
                  onChange={(v) => updateForm('repetitionPenalty', v)}
                  disabled={disabled}
                />
              )}
              {supports('minP') && (
                <SamplerField
                  label={t("sampler_min_p")}
                  tooltip={t("sampler_min_p_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.minP}
                  onChange={(v) => updateForm('minP', v)}
                  disabled={disabled}
                />
              )}
              {supports('typicalP') && (
                <SamplerField
                  label={t("sampler_typical_p")}
                  tooltip={t("sampler_typical_p_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.typicalP}
                  onChange={(v) => updateForm('typicalP', v)}
                  disabled={disabled}
                />
              )}
              {supports('tfsZ') && (
                <SamplerField
                  label={t("sampler_tfs_z")}
                  tooltip={t("sampler_tfs_z_hint")}
                  min={0}
                  max={2}
                  step={0.01}
                  value={form.tfsZ}
                  onChange={(v) => updateForm('tfsZ', v)}
                  disabled={disabled}
                />
              )}
              {supports('repeatLastN') && (
                <SamplerField
                  label={t("sampler_repeat_last_n")}
                  tooltip={t("sampler_repeat_last_n_hint")}
                  min={0}
                  max={4096}
                  step={1}
                  isInteger={true}
                  value={form.repeatLastN}
                  onChange={(v) => updateForm('repeatLastN', v)}
                  disabled={disabled}
                />
              )}
              {supports('mirostat') && (
                <SamplerField
                  label={t("sampler_mirostat")}
                  tooltip={t("sampler_mirostat_hint")}
                  min={0}
                  max={2}
                  step={1}
                  isInteger={true}
                  value={form.mirostat}
                  onChange={(v) => updateForm('mirostat', v)}
                  disabled={disabled}
                />
              )}
              {supports('mirostatTau') && (
                <SamplerField
                  label={t("sampler_mirostat_tau")}
                  tooltip={t("sampler_mirostat_tau_hint")}
                  min={0}
                  max={10}
                  step={0.1}
                  value={form.mirostatTau}
                  onChange={(v) => updateForm('mirostatTau', v)}
                  disabled={disabled}
                />
              )}
              {supports('mirostatEta') && (
                <SamplerField
                  label={t("sampler_mirostat_eta")}
                  tooltip={t("sampler_mirostat_eta_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.mirostatEta}
                  onChange={(v) => updateForm('mirostatEta', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryMultiplier') && (
                <SamplerField
                  label={t("sampler_dry_multiplier")}
                  tooltip={t("sampler_dry_multiplier_hint")}
                  min={0}
                  max={5}
                  step={0.05}
                  value={form.dryMultiplier}
                  onChange={(v) => updateForm('dryMultiplier', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryBase') && (
                <SamplerField
                  label={t("sampler_dry_base")}
                  tooltip={t("sampler_dry_base_hint")}
                  min={0}
                  max={4}
                  step={0.05}
                  value={form.dryBase}
                  onChange={(v) => updateForm('dryBase', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryAllowedLength') && (
                <SamplerField
                  label={t("sampler_dry_allowed_length")}
                  tooltip={t("sampler_dry_allowed_length_hint")}
                  min={0}
                  max={32}
                  step={1}
                  isInteger={true}
                  value={form.dryAllowedLength}
                  onChange={(v) => updateForm('dryAllowedLength', v)}
                  disabled={disabled}
                />
              )}
              {supports('xtcThreshold') && (
                <SamplerField
                  label={t("sampler_xtc_threshold")}
                  tooltip={t("sampler_xtc_threshold_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.xtcThreshold}
                  onChange={(v) => updateForm('xtcThreshold', v)}
                  disabled={disabled}
                />
              )}
              {supports('xtcProbability') && (
                <SamplerField
                  label={t("sampler_xtc_probability")}
                  tooltip={t("sampler_xtc_probability_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.xtcProbability}
                  onChange={(v) => updateForm('xtcProbability', v)}
                  disabled={disabled}
                />
              )}
            </div>

            {supports('drySequenceBreakers') && (
              <div className={cn("mt-4", disabled && "opacity-40 pointer-events-none")}>
                <label className="mb-[7px] flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                  <span>{t("sampler_dry_sequence_breakers")}</span>
                  <CustomTooltip content={t("sampler_dry_sequence_breakers_hint")} side="top" align="start">
                    <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border2 bg-s3 text-[10px] font-semibold normal-case tracking-normal text-t3">?</span>
                  </CustomTooltip>
                </label>
                <ChipInput
                  values={form.drySequenceBreakers}
                  onChange={(v) => updateForm('drySequenceBreakers', v)}
                  placeholder={t("sampler_dry_sequence_breakers_placeholder")}
                  disabled={disabled}
                  showPresets={false}
                  tooltip={t("sampler_dry_sequence_breakers_hint")}
                />
              </div>
            )}

            {/* Stop Sequences — full width */}
            {supports('stopSequences') && (
            <div className={cn("mt-4", disabled && "opacity-40 pointer-events-none")}>
              <CustomTooltip content={t("stop_seqs_hint")}>
                <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                  {t("stop_seqs_label")}
                </label>
              </CustomTooltip>
              <ChipInput
                values={form.stopSequences}
                onChange={(v) => updateForm('stopSequences', v)}
                placeholder={t("stop_seqs_placeholder")}
                disabled={disabled}
                showPresets
                presetsLabel={t("special_chars_label")}
                tooltip={t("special_chars_hint")}
              />
            </div>
            )}

            {capabilities?.logitBias && supports('logitBias') && (
              <LogitBiasPanel
                entries={form.logitBias}
                onChange={(v) => updateForm('logitBias', v)}
                disabled={disabled}
                supported
                model={form.model}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
