import React, { useState } from 'react';
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
    <div className="flex flex-col justify-end" style={{ marginBottom: 0 }}>
      <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3" style={{ marginBottom: 7 }}>
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
          className="!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent"
          style={{ padding: 0 }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={handleNumChange}
          className="!h-[30px] !w-[58px] shrink-0 rounded border border-border bg-s2 text-center font-ui text-[12px] text-t1 outline-none transition-colors focus:border-accent"
          style={{ padding: 0 }}
        />
      </div>
    </div>
  );
}

/* ── ProviderSamplerPanel ───────────────────────────────────────────── */

const selectCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent';
const selectPad = { padding: '0 34px 0 13px' };
const textInputCls =
  'h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent';
const textInputPad = { padding: '0 12px' };

interface ProviderSamplerPanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}

export function ProviderSamplerPanel({ form, updateForm }: ProviderSamplerPanelProps) {
  const [advOpen, setAdvOpen] = useState(false);

  return (
    <div style={{ marginBottom: 16 }}>
      {/* ── Basic settings ── */}
      <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-semibold uppercase tracking-[0.05em] text-t3" style={{ marginTop: 20, marginLeft: 0, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--border2)' }}>
        Basic Settings
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Max tokens */}
        <div>
          <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3" style={{ marginBottom: 7 }}>
            Response Tokens
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
            style={textInputPad}
          />
        </div>

        {/* Context budget */}
        <div>
          <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3" style={{ marginBottom: 7 }}>
            Context Size
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
            placeholder="Auto"
            className={textInputCls}
            style={textInputPad}
          />
        </div>

        {/* Temperature */}
        <SamplerField
          label={`Temperature (${form.temperature})`}
          min={0}
          max={2}
          step={0.05}
          value={form.temperature}
          onChange={(v) => updateForm('temperature', v)}
        />

        {/* Reasoning effort */}
        <div>
          <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3" style={{ marginBottom: 7 }}>
            Reasoning Effort
          </label>
          <select
            value={form.reasoningEffort}
            onChange={(e) => updateForm('reasoningEffort', e.target.value)}
            className={selectCls}
            style={selectPad}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
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
          <div className="font-ui text-[13px] font-medium text-t1">Stream Response</div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-border2 bg-s2 px-4 py-3">
          <div
            className={cn("relative h-5 w-9 rounded-full transition-colors", form.showReasoning ? "bg-accent" : "bg-s3")}
            onClick={() => updateForm('showReasoning', !form.showReasoning)}
          >
            <div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", form.showReasoning ? "translate-x-[18px]" : "translate-x-0.5")} />
          </div>
          <div className="font-ui text-[13px] font-medium text-t1">Show Reasoning</div>
        </div>
      </div>

      {/* ── Advanced (accordion) ── */}
      <div className="overflow-hidden rounded-lg border border-border2" style={{ marginTop: 16 }}>
        <button
          type="button"
          onClick={() => setAdvOpen(!advOpen)}
          className={cn(
            'flex w-full items-center justify-between bg-s2 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] focus:outline-none',
            advOpen && '!rounded-b-none'
          )}
          style={{ padding: 12 }}
        >
          <span>Advanced Settings</span>
          <span className={cn('transition-transform', advOpen && 'rotate-180')}>
            <Icons.Caret direction="d" />
          </span>
        </button>

        {advOpen && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border2 bg-surface" style={{ padding: 16 }}>
            <SamplerField
              label="Frequency Penalty"
              min={-2}
              max={2}
              step={0.1}
              value={form.freqPen}
              onChange={(v) => updateForm('freqPen', v)}
            />
            <SamplerField
              label="Presence Penalty"
              min={-2}
              max={2}
              step={0.1}
              value={form.presPen}
              onChange={(v) => updateForm('presPen', v)}
            />
            <SamplerField
              label="Top K"
              min={0}
              max={100}
              step={1}
              isInteger={true}
              value={form.topK}
              onChange={(v) => updateForm('topK', v)}
            />
            <SamplerField
              label="Top P"
              min={0}
              max={1}
              step={0.01}
              value={form.topP}
              onChange={(v) => updateForm('topP', v)}
            />
            <SamplerField
              label="Rep. Penalty"
              min={1}
              max={2}
              step={0.05}
              value={form.repPen}
              onChange={(v) => updateForm('repPen', v)}
            />
            <SamplerField
              label="Min P"
              min={0}
              max={1}
              step={0.01}
              value={form.minP}
              onChange={(v) => updateForm('minP', v)}
            />
            <SamplerField
              label="Top A"
              min={0}
              max={1}
              step={0.01}
              value={form.topA ?? 0}
              onChange={(v) => updateForm('topA', v)}
            />
            <div /> {/* spacer */}

            {/* Stop Sequences */}
            <div className="col-span-2" style={{ marginTop: 8 }}>
              <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3" style={{ marginBottom: 7 }}>
                Stop Sequences
              </label>
              <input
                type="text"
                value={form.stopSeq}
                onChange={(e) => updateForm('stopSeq', e.target.value)}
                placeholder="User:, \nUser"
                className={textInputCls}
                style={textInputPad}
              />
            </div>

            {/* Logit Bias */}
            <div className="col-span-2">
              <label className="block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3" style={{ marginBottom: 7 }}>
                Logit Bias
              </label>
              <input
                type="text"
                value={form.logitBias ?? ''}
                onChange={(e) => updateForm('logitBias', e.target.value)}
                placeholder='{"50256": -100}'
                className={textInputCls}
                style={textInputPad}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
