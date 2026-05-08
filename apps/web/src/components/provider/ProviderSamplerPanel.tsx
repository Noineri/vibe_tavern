import { useState } from "react";
import type { ChangeEvent } from "react";
import { cn } from "../../lib/cn.js";
import type { FormState } from "../ProviderModal.js";
import { Icons } from "../shared/icons.js";

interface SamplerFieldProps {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  isInteger?: boolean;
}

const SamplerField = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  isInteger = false,
}: SamplerFieldProps) => {
  const fieldValue = value ?? min;
  const handleNumberChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue =
      event.target.value === ""
        ? min
        : isInteger
          ? parseInt(event.target.value, 10)
          : parseFloat(event.target.value);
    onChange(Number.isNaN(nextValue) ? min : nextValue);
  };

  return (
    <div className="mb-0 flex flex-col justify-end">
      <label className="mb-[7px] font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={fieldValue}
          onChange={handleNumberChange}
          className="!h-[6px] !w-auto flex-1 !rounded-full !border-0 accent-accent"
          style={{ padding: 0 }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={fieldValue}
          onChange={handleNumberChange}
          className="!h-[30px] !w-[58px] shrink-0 rounded border border-border bg-s2 text-center font-ui text-[12px] text-t1 outline-none transition-colors focus:border-accent"
          style={{ padding: 0 }}
        />
      </div>
    </div>
  );
};

interface ProviderSamplerPanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

export function ProviderSamplerPanel({ form, updateForm }: ProviderSamplerPanelProps) {
  const [advOpen, setAdvOpen] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  return (
    <div className="mb-4">
      {/* ── Базовые настройки ── */}
      <div className="mt-5 mx-0 mb-3 border-b border-border2 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold uppercase tracking-[0.05em] text-t3" style={{ paddingBottom: 8 }}>Базовые настройки</div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Токенов в ответе */}
        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">Токенов в ответе</label>
          <input
            type="number"
            min="1"
            step="1"
            value={form.maxTokens ?? 500}
            onChange={(event) => updateForm("maxTokens", parseInt(event.target.value, 10) || 500)}
            className="h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
            style={{ padding: "0 12px" }}
          />
        </div>

        {/* Размер отправляемого контекста */}
        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">Размер контекста</label>
          <input
            type="number"
            min="0"
            step="1024"
            value={form.contextBudget || ""}
            onChange={(event) =>
              updateForm("contextBudget", event.target.value === "" ? 0 : parseInt(event.target.value, 10) || 0)
            }
            placeholder="Авто"
            className="h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
            style={{ padding: "0 12px" }}
          />
        </div>

        {/* Температура */}
        <SamplerField
          label={`Температура (${form.temperature ?? 1.0})`}
          min={0}
          max={2}
          step={0.05}
          value={form.temperature ?? 1.0}
          onChange={(value) => updateForm("temperature", value)}
        />

        {/* Усилие ризонинга */}
        <div>
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">Усилие ризонинга</label>
          <select
            value={form.reasoningEffort || "medium"}
            onChange={(event) => updateForm("reasoningEffort", event.target.value)}
            className="h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
            style={{ padding: "0 34px 0 12px" }}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      {/* Reasoning toggle */}
      <div className="mt-6 rounded-lg border border-border2 bg-s2" style={{ padding: "12px 16px" }}>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "relative h-[18px] w-[32px] cursor-pointer rounded-full transition-colors",
              showReasoning ? "bg-accent" : "bg-border2",
            )}
            onClick={() => setShowReasoning((currentValue) => !currentValue)}
          >
            <div
              className={cn(
                "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform",
                showReasoning ? "translate-x-[16px]" : "translate-x-[2px]",
              )}
            />
          </div>
          <div>
            <div className="font-ui text-[13px] font-medium text-t1">Показывать reasoning</div>
          </div>
        </div>
      </div>

      {/* ── Продвинутые (аккордеон) ── */}
      <div className="mt-4 overflow-hidden rounded-lg border border-border2">
        <button
          type="button"
          onClick={() => setAdvOpen(!advOpen)}
          className={cn(
            "flex w-full items-center justify-between bg-s2 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] focus:outline-none",
            advOpen && "!rounded-b-none",
          )}
          style={{ padding: 12 }}
        >
          <span>Продвинутые настройки</span>
          <span className={cn("transition-transform", advOpen && "rotate-180")}>
            <Icons.Caret direction="d" />
          </span>
        </button>

        {advOpen && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border2 bg-surface" style={{ padding: 16 }}>
            <SamplerField label="Штраф за частотность" min={-2} max={2} step={0.1} value={form.freqPen ?? 0} onChange={(value) => updateForm("freqPen", value)} />
            <SamplerField label="Штраф за присутствие" min={-2} max={2} step={0.1} value={form.presPen ?? 0} onChange={(value) => updateForm("presPen", value)} />
            <SamplerField label="Top K" min={0} max={100} step={1} isInteger={true} value={form.topK ?? 40} onChange={(value) => updateForm("topK", value)} />
            <SamplerField label="Top P" min={0} max={1} step={0.01} value={form.topP ?? 1} onChange={(value) => updateForm("topP", value)} />
            <SamplerField label="Rep. Penalty" min={1} max={2} step={0.05} value={form.repPen ?? 1.1} onChange={(value) => updateForm("repPen", value)} />
            <SamplerField label="Min P" min={0} max={1} step={0.01} value={form.minP ?? 0.05} onChange={(value) => updateForm("minP", value)} />
            <SamplerField label="Top A" min={0} max={1} step={0.01} value={0} onChange={() => { /* TODO: wire topA into provider profile form state */ }} />
            <div /> {/* spacer */}

            {/* Stop Sequences */}
            <div className="col-span-2 mt-2">
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">Стоп-последовательности</label>
              <input
                type="text"
                value={form.stopSeq || ""}
                onChange={(event) => updateForm("stopSeq", event.target.value)}
                placeholder="User:, \nUser"
                className="h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
                style={{ padding: "0 12px" }}
              />
            </div>

            {/* Logit Bias */}
            <div className="col-span-2">
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">Logit Bias</label>
              <input
                type="text"
                value=""
                onChange={() => { /* TODO: wire logitBias into provider profile form state */ }}
                placeholder='{"50256": -100}'
                className="h-[38px] w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
                style={{ padding: "0 12px" }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
