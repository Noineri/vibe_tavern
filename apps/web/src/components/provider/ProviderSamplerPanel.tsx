import React, { useState } from 'react';
import { useT } from '../../i18n/context.js';
import type { FormState } from '../ProviderModal.js';
import { Icons } from '../shared/icons.js';
import { cn } from '../../lib/cn.js';

/* ── SamplerField sub-component ────────────────────────────────────── */

interface SamplerFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  isInteger?: boolean;
}

function SamplerField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  isInteger = false,
}: SamplerFieldProps) {
  const val = value ?? min;
  const handleNumChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v =
      e.target.value === ''
        ? min
        : isInteger
          ? parseInt(e.target.value, 10)
          : parseFloat(e.target.value);
    if (isNaN(v)) v = min;
    onChange(v);
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
          onChange={handleNumChange}
          className="!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent p-0"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={handleNumChange}
          className="!h-[30px] !w-[58px] shrink-0 rounded border border-border bg-s2 p-0 text-center font-ui text-[12px] text-t1 outline-none transition-colors focus:border-accent"
        />
      </div>
    </div>
  );
}

/* ── ProviderSamplerPanel ───────────────────────────────────────────── */

const selectCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent pl-[13px] pr-[34px]';
const textInputCls =
  'h-[38px] w-full rounded-md border border-border bg-s2 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent';

interface ProviderSamplerPanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}

export function ProviderSamplerPanel({ form, updateForm }: ProviderSamplerPanelProps) {
  const { t } = useT();
  const [advOpen, setAdvOpen] = useState(false);

  return (
    <div className="mb-4">
      {/* ── Basic settings ── */}
      <div className="mt-5 ml-0 mb-3 pb-2 border-b border-border2 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold uppercase tracking-[0.05em] text-t3">
        {t("sampler_basic_settings")}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Max tokens */}
        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            {t("sampler_max_context")}
          </label>
          <input
            type="number"
            min="1"
            step="1"
            value={form.maxTokens}
            onChange={(e) =>
              updateForm('maxTokens', parseInt(e.target.value) || 500)
            }
            className={textInputCls}
          />
        </div>

        {/* Context budget */}
        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            {t("context_length")}
          </label>
          <input
            type="number"
            min="0"
            step="1024"
            value={form.contextBudget || ''}
            onChange={(e) =>
              updateForm(
                'contextBudget',
                e.target.value === '' ? 0 : parseInt(e.target.value) || 0
              )
            }
            placeholder={t("context_auto")}
            className={textInputCls}
          />
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
          <select
            value={form.reasoningEffort}
            onChange={(e) => updateForm('reasoningEffort', e.target.value)}
            className={selectCls}
          >
            <option value="low">{t("effort_low")}</option>
            <option value="medium">{t("effort_medium")}</option>
            <option value="high">{t("effort_high")}</option>
          </select>
        </div>
      </div>

      {/* Toggles: Streaming & Reasoning */}
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
          <div
            className={cn("relative h-5 w-9 rounded-full transition-colors", form.streamResponse !== false ? "bg-accent" : "bg-s3")}
            onClick={() => updateForm('streamResponse', form.streamResponse === false)}
          >
            <div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", form.streamResponse !== false ? "translate-x-[18px]" : "translate-x-0.5")} />
          </div>
          <div className="font-ui text-[13px] font-medium text-t1">{t("stream_response")}</div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
          <div
            className={cn("relative h-5 w-9 rounded-full transition-colors", form.showReasoning ? "bg-accent" : "bg-s3")}
            onClick={() => updateForm('showReasoning', !form.showReasoning)}
          >
            <div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", form.showReasoning ? "translate-x-[18px]" : "translate-x-0.5")} />
          </div>
          <div className="font-ui text-[13px] font-medium text-t1">{t("show_reasoning")}</div>
        </div>
      </div>

      {/* ── Advanced (accordion) ── */}
      <div className="mt-4 overflow-hidden rounded-lg border border-border2">
        <button
          type="button"
          onClick={() => setAdvOpen(!advOpen)}
          className={cn(
            'flex w-full items-center justify-between bg-s2 p-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] focus:outline-none',
            advOpen && '!rounded-b-none'
          )}
        >
          <span>{t("samplers_advanced")}</span>
          <span className={cn('transition-transform', advOpen && 'rotate-180')}>
            <Icons.Caret direction="d" />
          </span>
        </button>

        {advOpen && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border2 bg-surface p-4">
            <SamplerField
              label={t("sampler_freq_penalty")}
              min={-2}
              max={2}
              step={0.1}
              value={form.freqPen}
              onChange={(v) => updateForm('freqPen', v)}
            />
            <SamplerField
              label={t("sampler_pres_penalty")}
              min={-2}
              max={2}
              step={0.1}
              value={form.presPen}
              onChange={(v) => updateForm('presPen', v)}
            />
            <SamplerField
              label={t("sampler_top_k")}
              min={0}
              max={100}
              step={1}
              isInteger={true}
              value={form.topK}
              onChange={(v) => updateForm('topK', v)}
            />
            <SamplerField
              label={t("sampler_top_p")}
              min={0}
              max={1}
              step={0.01}
              value={form.topP}
              onChange={(v) => updateForm('topP', v)}
            />
            <SamplerField
              label={t("sampler_rep_penalty")}
              min={1}
              max={2}
              step={0.05}
              value={form.repPen}
              onChange={(v) => updateForm('repPen', v)}
            />
            <SamplerField
              label={t("sampler_min_p")}
              min={0}
              max={1}
              step={0.01}
              value={form.minP}
              onChange={(v) => updateForm('minP', v)}
            />
            <SamplerField
              label={t("sampler_top_a")}
              min={0}
              max={1}
              step={0.01}
              value={form.topA ?? 0}
              onChange={(v) => updateForm('topA', v)}
            />
            <div /> {/* spacer */}

            {/* Stop Sequences */}
            <div className="col-span-2 mt-2">
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                {t("stop_seqs_label")}
              </label>
              <input
                type="text"
                value={form.stopSeq}
                onChange={(e) => updateForm('stopSeq', e.target.value)}
                placeholder={t("stop_seqs_placeholder")}
                className={textInputCls}
              />
            </div>

            {/* Logit Bias */}
            <div className="col-span-2">
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                {t("logit_bias_label")}
              </label>
              <input
                type="text"
                value={form.logitBias ?? ''}
                onChange={(e) => updateForm('logitBias', e.target.value)}
                placeholder='{"50256": -100}'
                className={textInputCls}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
