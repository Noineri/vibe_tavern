import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n/context.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { ChipInput } from '../../shared/ChipInput.js';
import { LogitBiasPanel } from './LogitBiasPanel.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { CustomTooltip } from '../../shared/Tooltip.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { NumberInput } from '../../shared/NumberInput.js';

/* ── SamplerField sub-component ────────────────────────────────────── */

interface SamplerFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
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
      <label className="mb-[7px] font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
        {label}
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
          className="h-[30px] w-[110px] shrink-0"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={onChange}
          disabled={disabled}
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
  frequencyPenalty: 0,
  presencePenalty: 0,
  repetitionPenalty: 0,
} as const;

interface ProviderSamplerPanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  capabilities?: { logitBias?: boolean; [k: string]: unknown } | null;
}

export function ProviderSamplerPanel({ form, updateForm, capabilities }: ProviderSamplerPanelProps) {
  const { t } = useT();
  const [advOpen, setAdvOpen] = useState(false);
  const disabled = !form.customSamplers;

  const handleToggleCustomSamplers = (enabled: boolean) => {
    if (enabled) {
      // Apply custom sampler defaults when enabling
      updateForm('customSamplers', true);
      updateForm('topP', CUSTOM_SAMPLER_DEFAULTS.topP);
      updateForm('topK', CUSTOM_SAMPLER_DEFAULTS.topK);
      updateForm('topA', CUSTOM_SAMPLER_DEFAULTS.topA);
      updateForm('minP', CUSTOM_SAMPLER_DEFAULTS.minP);
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
        <SamplerField
          label={`${t("sampler_temperature")} (${form.temperature})`}
          min={0}
          max={2}
          step={0.05}
          value={form.temperature}
          onChange={(v) => updateForm('temperature', v)}
        />

        {/* Reasoning effort */}
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
              {/* Left column: topP, topK, topA, minP */}
              <SamplerField
                label={t("sampler_top_p")}
                min={0}
                max={1}
                step={0.01}
                value={form.topP}
                onChange={(v) => updateForm('topP', v)}
                disabled={disabled}
              />
              <SamplerField
                label={t("sampler_freq_penalty")}
                min={-2}
                max={2}
                step={0.1}
                value={form.frequencyPenalty}
                onChange={(v) => updateForm('frequencyPenalty', v)}
                disabled={disabled}
              />
              <SamplerField
                label={t("sampler_top_k")}
                min={0}
                max={100}
                step={1}
                isInteger={true}
                value={form.topK}
                onChange={(v) => updateForm('topK', v)}
                disabled={disabled}
              />
              <SamplerField
                label={t("sampler_pres_penalty")}
                min={-2}
                max={2}
                step={0.1}
                value={form.presencePenalty}
                onChange={(v) => updateForm('presencePenalty', v)}
                disabled={disabled}
              />
              <SamplerField
                label={t("sampler_top_a")}
                min={0}
                max={1}
                step={0.01}
                value={form.topA ?? 0}
                onChange={(v) => updateForm('topA', v)}
                disabled={disabled}
              />
              <SamplerField
                label={t("sampler_rep_penalty")}
                min={0}
                max={2}
                step={0.05}
                value={form.repetitionPenalty}
                onChange={(v) => updateForm('repetitionPenalty', v)}
                disabled={disabled}
              />
              <SamplerField
                label={t("sampler_min_p")}
                min={0}
                max={1}
                step={0.01}
                value={form.minP}
                onChange={(v) => updateForm('minP', v)}
                disabled={disabled}
              />
              {/* Right column bottom spacer */}
              <div />
            </div>

            {/* Stop Sequences — full width */}
            <div className={cn("mt-4", disabled && "opacity-40 pointer-events-none")}>
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                {t("stop_seqs_label")}
              </label>
              <ChipInput
                values={form.stopSequences}
                onChange={(v) => updateForm('stopSequences', v)}
                placeholder={t("stop_seqs_placeholder")}
                disabled={disabled}
                showPresets
                tooltip={t("stop_seqs_hint")}
              />
            </div>

            {capabilities?.logitBias && (
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
