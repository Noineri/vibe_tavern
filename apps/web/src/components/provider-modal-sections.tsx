import { useState } from "react";
import type { ProviderProfileRecord } from "../app-client.js";
import { TYPE_LABELS, PROVIDER_PRESETS, getPresetGroup, PRESET_GROUPS } from "../provider-presets.js";
import type { FormState } from "./ProviderModal.js";
import { Icons } from "./shared/icons.js";

/* ── Shared class constants ───────────────────────────────────────────── */

const labelCls =
  "block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3 mb-[7px]";
const inputCls =
  "w-full h-[38px] bg-s2 border border-border rounded-[6px] px-[13px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent";
const selectCls =
  "w-full h-[38px] bg-s2 border border-border rounded-[6px] pl-[13px] pr-[34px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent";

/* ── 1. ProviderProfileListSection ────────────────────────────────────── */

interface ProviderProfileListSectionProps {
  filteredProfiles: ProviderProfileRecord[];
  editingId: string | null;
  activeProviderProfileId: string | null;
  profileSearch: string;
  onProfileSearchChange: (value: string) => void;
  onSelectProfile: (id: string) => void;
  onAddProfile: () => void;
}

export function ProviderProfileListSection({
  filteredProfiles,
  editingId,
  activeProviderProfileId,
  profileSearch,
  onProfileSearchChange,
  onSelectProfile,
  onAddProfile,
}: ProviderProfileListSectionProps) {
  return (
    <div
      className="flex shrink-0 flex-col border-r border-border bg-surface"
      style={{ width: 220, padding: "20px 0 10px" }}
    >
      {/* TODO(i18n) */}
      <div
        className="font-ui text-[12px] font-medium uppercase tracking-[0.05em] text-t3"
        style={{ padding: "0 16px", marginBottom: 6 }}
      >
        Профили
      </div>

      <div
        className="flex items-center gap-2 rounded-md border border-border bg-s2"
        style={{ padding: "6px 10px", margin: "0 12px 12px" }}
      >
        <Icons.Search />
        <input
          className="min-w-0 flex-1 border-0 bg-transparent font-ui text-[13px] text-t1 outline-none placeholder:text-t4"
          placeholder="Поиск профилей..." /* TODO(i18n) */
          value={profileSearch}
          onChange={(e) => onProfileSearchChange(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filteredProfiles.map((p) => {
          const isSelected = editingId === p.id;
          const isActive = activeProviderProfileId === p.id;
          return (
            <div
              key={p.id}
              className={`cursor-pointer overflow-hidden whitespace-nowrap border-l-[3px] text-ellipsis transition-colors hover:bg-s2 ${
                isSelected
                  ? "border-l-accent bg-accent-dim text-accent-t"
                  : "border-l-transparent text-t2"
              }`}
              style={{ padding: "10px 16px" }}
              onClick={() => onSelectProfile(p.id)}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`h-2 w-2 shrink-0 rounded-full transition-colors ${
                    isActive
                      ? p.hasStoredApiKey
                        ? "bg-success"
                        : "bg-danger"
                      : "bg-t4"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="max-w-[150px] cursor-default overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">
                    {isActive ? "★ " : ""}
                    {p.name}
                  </div>
                  <div
                    className={`mt-0.5 text-[11px] ${
                      isSelected ? "text-accent-t" : "text-t4"
                    }`}
                  >
                    {TYPE_LABELS[p.type] || p.type}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div
        className="cursor-pointer rounded-md border border-dashed border-border2 text-center font-ui text-[12px] font-medium text-t3 transition-colors hover:border-border hover:text-t1 hover:bg-s2"
        style={{ margin: "12px 12px 0", padding: "8px 0" }}
        onClick={() => void onAddProfile()}
      >
        + Новый профиль {/* TODO(i18n) */}
      </div>
    </div>
  );
}

/* ── 2. ProviderFormFields ────────────────────────────────────────────── */

interface ProviderFormFieldsProps {
  form: FormState;
  editingId: string | null;
  providerProfiles: ProviderProfileRecord[];
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  applyPreset: (presetId: string) => void;
  testOk: boolean | null;
  testing: boolean;
  testingChat: boolean;
  chatResult: { reply?: string; error?: string } | null;
  onTest: () => void;
  onTestChat: () => void;
}

export function ProviderFormFields({
  form,
  editingId,
  providerProfiles,
  updateForm,
  applyPreset,
  testOk,
  testing,
  testingChat,
  chatResult,
  onTest,
  onTestChat,
}: ProviderFormFieldsProps) {
  const presetGroup = getPresetGroup(form.providerPreset);
  const filteredPresets = presetGroup
    ? PROVIDER_PRESETS.filter((f) => f.group === presetGroup)
    : PROVIDER_PRESETS;
  const presetEndpoint = form.providerPreset
    ? PROVIDER_PRESETS.find((f) => f.id === form.providerPreset)?.baseUrl ?? ""
    : "";

  const duplicateNameWarning =
    form.name &&
    providerProfiles.some(
      (p) =>
        p.id !== editingId &&
        p.name.trim().toLowerCase() === form.name.trim().toLowerCase(),
    );

  return (
    <>
      {/* Row 1: profile name + provider preset */}
      <div className="grid grid-cols-2 gap-4">
        <div className="mb-4">
          {/* TODO(i18n) */}
          <label className={labelCls}>Имя профиля</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder="Напр. OpenRouter RP" /* TODO(i18n) */
            className={inputCls}
          />
          {duplicateNameWarning && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning [&_svg]:h-[12px] [&_svg]:w-[12px]">
              <Icons.Edit />
              {/* TODO(i18n) */}
              Профиль с таким именем уже существует
            </div>
          )}
        </div>
        <div className="mb-4">
          {/* TODO(i18n) */}
          <label className={labelCls}>Пресет провайдера</label>
          <select
            value={presetGroup ?? ""}
            onChange={(e) => {
              const g = e.target.value;
              if (!g) {
                updateForm("providerPreset", "");
              } else {
                const first = PROVIDER_PRESETS.find((f) => f.group === g);
                if (first) applyPreset(first.id);
              }
            }}
            className={selectCls}
          >
            <option value="">Custom</option>
            {PRESET_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Row 2: API format + preset endpoint */}
      <div className="grid grid-cols-2 gap-4">
        <div className="mb-4">
          {/* TODO(i18n) */}
          <label className={labelCls}>API формат</label>
          <select
            value={form.providerPreset || ""}
            onChange={(e) => {
              const val = e.target.value;
              if (val) applyPreset(val);
            }}
            className={selectCls}
          >
            <option value="">Custom</option>
            {filteredPresets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-4">
          {/* TODO(i18n) */}
          <label className={labelCls}>Эндпоинт пресета</label>
          <input
            type="text"
            value={presetEndpoint || "Custom"}
            readOnly
            className={`${inputCls} !cursor-not-allowed !opacity-60`}
          />
        </div>
      </div>

      {/* Custom endpoint */}
      <div className="mb-4">
        {/* TODO(i18n) */}
        <label className={labelCls}>API эндпоинт (URL)</label>
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => updateForm("baseUrl", e.target.value)}
          placeholder="https://api.openai.com/v1"
          className={inputCls}
        />
      </div>

      {/* Stream toggle card */}
      <div className="mb-4 mt-2 rounded-lg border border-border2 bg-s2 px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={`relative h-[18px] w-[32px] cursor-pointer rounded-full transition-colors ${
              form.streamResponse ? "bg-accent" : "bg-border2"
            }`}
            onClick={() => updateForm("streamResponse", !form.streamResponse as FormState["streamResponse"])}
          >
            <div
              className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform ${
                form.streamResponse ? "translate-x-[16px]" : "translate-x-[2px]"
              }`}
            />
          </div>
          <div>
            {/* TODO(i18n) */}
            <div className="font-ui text-[13px] font-medium text-t1">
              Потоковый ответ
            </div>
            {/* TODO(i18n) */}
            <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3 leading-[1.5]">
              Вкл: посимвольная генерация. Выкл: полный ответ появляется сразу.
            </div>
          </div>
        </div>
      </div>

      {/* API key */}
      <div className="mb-4">
        {/* TODO(i18n) */}
        <label className={labelCls}>API ключ</label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => updateForm("apiKey", e.target.value)}
          placeholder={form.hasStoredApiKey ? "Сохранён на бэкенде" : "sk-..."} /* TODO(i18n) */
          className={`${inputCls} font-mono tracking-[0.05em]`}
        />
      </div>

      {/* Test connection card */}
      <div className="mb-4 mt-4 rounded-lg border border-border bg-surface p-4">
        {!form.apiKey && !form.hasStoredApiKey ? (
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="h-2 w-2 rounded-full bg-t4" />
            {/* TODO(i18n) */}
            Нет подключения — введите API ключ выше
          </div>
        ) : !form.model ? (
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="h-2 w-2 rounded-full bg-t4" />
            {/* TODO(i18n) */}
            Модель не выбрана — выберите модель для начала
          </div>
        ) : (
          <div>
            <div className="flex gap-3">
              <button
                className={`rounded-md border font-ui text-[13px] font-medium transition-colors py-1.5 px-4 ${
                  testOk === true
                    ? "border-success/30 bg-success/10 text-success"
                    : testOk === false
                      ? "border-danger/30 bg-danger/10 text-danger"
                      : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1"
                }`}
                onClick={() => void onTest()}
                disabled={testing}
              >
                {/* TODO(i18n) */}
                {testing ? "Проверка..." : "Проверить соединение"}
              </button>
              <button
                className="rounded-md border border-border bg-s2 py-1.5 px-4 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
                onClick={() => void onTestChat()}
                disabled={testingChat}
              >
                {/* TODO(i18n) */}
                {testingChat ? "Отправка..." : 'Тест "Привет"'}
              </button>
            </div>
            {testOk === true && (
              <div className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 text-[12px] font-ui text-success">
                  <Icons.Check />
                  {/* TODO(i18n) */}
                  Соединение успешно
                </span>
              </div>
            )}
            {testOk === false && (
              <div className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 text-[12px] font-ui text-danger">
                  <Icons.Close />
                  {/* TODO(i18n) */}
                  Ошибка соединения
                </span>
              </div>
            )}
            {chatResult && (
              <div className="mt-3">
                {chatResult.reply && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 text-[12px] font-ui text-success italic">
                    &ldquo;
                    {chatResult.reply.length > 200
                      ? chatResult.reply.slice(0, 200) + "..."
                      : chatResult.reply}
                    &rdquo;
                  </span>
                )}
                {chatResult.error && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 text-[12px] font-ui text-danger">
                    <Icons.Close />
                    {chatResult.error}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ── 3. ProviderSamplerFields ─────────────────────────────────────────── */

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
  const handleNumChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v =
      e.target.value === ""
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
          value={value}
          onChange={handleNumChange}
          className="!h-[6px] !w-auto flex-1 !rounded-full !border-0 !p-0 accent-accent"
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleNumChange}
          className="!h-[30px] !w-[58px] shrink-0 rounded border border-border bg-s2 p-0 text-center font-ui text-[12px] text-t1 outline-none transition-colors focus:border-accent"
        />
      </div>
    </div>
  );
}

interface ProviderSamplerFieldsProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}

export function ProviderSamplerFields({
  form,
  updateForm,
}: ProviderSamplerFieldsProps) {
  const [advOpen, setAdvOpen] = useState(false);

  return (
    <div className="mb-4">
      {/* TODO(i18n) — section header */}
      <div className="mt-5 mx-0 mb-3 border-b border-border2 pb-2 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold uppercase tracking-[0.05em] text-t3">
        Базовые настройки
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Max tokens */}
        <div>
          {/* TODO(i18n) */}
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            Токенов в ответе
          </label>
          <input
            type="number"
            min="1"
            step="1"
            value={form.maxTokens}
            onChange={(e) =>
              updateForm("maxTokens", parseInt(e.target.value) || 500)
            }
            className="h-[38px] w-full rounded-md border border-border bg-s2 py-0 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
          />
        </div>

        {/* Context budget */}
        <div>
          {/* TODO(i18n) */}
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            Размер контекста
          </label>
          <input
            type="number"
            min="0"
            step="1024"
            value={form.contextBudget || ""}
            onChange={(e) =>
              updateForm(
                "contextBudget",
                e.target.value === "" ? 0 : parseInt(e.target.value) || 0,
              )
            }
            placeholder="Авто" /* TODO(i18n) */
            className="h-[38px] w-full rounded-md border border-border bg-s2 py-0 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
          />
        </div>

        {/* Temperature */}
        <SamplerField
          label={`Температура (${form.temperature})`} /* TODO(i18n) */
          min={0}
          max={2}
          step={0.05}
          value={form.temperature}
          onChange={(v) => updateForm("temperature", v)}
        />

        {/* Reasoning effort */}
        <div>
          {/* TODO(i18n) */}
          <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
            Усилие ризонинга
          </label>
          <select
            value={form.reasoningEffort}
            onChange={(e) => updateForm("reasoningEffort", e.target.value)}
            className={selectCls}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      {/* ── Advanced (accordion) ── */}
      <div className="mt-4 overflow-hidden rounded-lg border border-border2">
        <button
          type="button"
          onClick={() => setAdvOpen(!advOpen)}
          className={`flex w-full items-center justify-between bg-s2 p-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] focus:outline-none ${
            advOpen ? "!rounded-b-none" : ""
          }`}
        >
          {/* TODO(i18n) */}
          <span>Продвинутые настройки</span>
          <span
            className={`transition-transform ${advOpen ? "rotate-180" : ""}`}
          >
            <Icons.Caret direction="d" />
          </span>
        </button>

        {advOpen && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border2 bg-surface p-4">
            <SamplerField
              label="Штраф за частотность" /* TODO(i18n) */
              min={-2}
              max={2}
              step={0.1}
              value={form.freqPen}
              onChange={(v) => updateForm("freqPen", v)}
            />
            <SamplerField
              label="Штраф за присутствие" /* TODO(i18n) */
              min={-2}
              max={2}
              step={0.1}
              value={form.presPen}
              onChange={(v) => updateForm("presPen", v)}
            />
            <SamplerField
              label="Top K"
              min={0}
              max={100}
              step={1}
              isInteger={true}
              value={form.topK}
              onChange={(v) => updateForm("topK", v)}
            />
            <SamplerField
              label="Top P"
              min={0}
              max={1}
              step={0.01}
              value={form.topP}
              onChange={(v) => updateForm("topP", v)}
            />
            <SamplerField
              label="Rep. Penalty" /* TODO(i18n) */
              min={1}
              max={2}
              step={0.05}
              value={form.repPen}
              onChange={(v) => updateForm("repPen", v)}
            />
            <SamplerField
              label="Min P"
              min={0}
              max={1}
              step={0.01}
              value={form.minP}
              onChange={(v) => updateForm("minP", v)}
            />
            <SamplerField
              label="Typical P"
              min={0}
              max={1}
              step={0.01}
              value={form.typicalP}
              onChange={(v) => updateForm("typicalP", v)}
            />
            <div />

            {/* Stop Sequences */}
            <div className="col-span-2 mt-2">
              {/* TODO(i18n) */}
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                Стоп-последовательности
              </label>
              <input
                type="text"
                value={form.stopSeq}
                onChange={(e) => updateForm("stopSeq", e.target.value)}
                placeholder="User:, \nUser"
                className="h-[38px] w-full rounded-md border border-border bg-s2 py-0 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
              />
            </div>

            {/* Seed */}
            <div className="col-span-2">
              {/* TODO(i18n) */}
              <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                Seed
              </label>
              <input
                type="number"
                value={form.seed ?? ""}
                onChange={(e) =>
                  updateForm(
                    "seed",
                    (e.target.value === ""
                      ? null
                      : e.target.value) as FormState["seed"],
                  )
                }
                placeholder="Случайный" /* TODO(i18n) */
                className="h-[38px] w-full rounded-md border border-border bg-s2 py-0 px-3 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 4. ProviderModelSelectorSection ──────────────────────────────────── */

interface ProviderModelSelectorSectionProps {
  form: FormState;
  models: Array<{ id: string; label: string }>;
  filteredModels: Array<{ id: string; label: string }>;
  fetching: boolean;
  fetchError: string | null;
  modelSearch: string;
  modelListOpen: boolean;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  onFetchModels: () => void;
  setModelSearch: (v: string) => void;
  setModelListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
}

export function ProviderModelSelectorSection({
  form,
  models,
  filteredModels,
  fetching,
  fetchError,
  modelSearch,
  modelListOpen,
  updateForm,
  onFetchModels,
  setModelSearch,
  setModelListOpen,
  dropdownRef,
}: ProviderModelSelectorSectionProps) {
  return (
    <div className="mb-6 mt-6">
      {/* TODO(i18n) */}
      <div
        className="font-ui text-[14px] font-semibold text-t1"
        style={{
          marginBottom: 16,
          paddingBottom: 8,
          borderBottom: "1px solid var(--border2)",
        }}
      >
        Модель
      </div>
      <div className="flex items-end gap-3">
        <div className="mb-0 flex-1" ref={dropdownRef}>
          {/* TODO(i18n) */}
          <label className={labelCls}>Выбранная модель</label>
          {models.length > 0 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setModelListOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-md border border-border bg-s2 font-ui text-[13px] text-t1 transition-colors hover:border-accent"
                style={{ padding: "7px 12px" }}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {models.find((m) => m.id === form.model)?.label ||
                    form.model ||
                    "Выбрать модель..."}
                </span>
                <span className="text-t3">
                  <Icons.Caret direction="d" />
                </span>
              </button>
              {modelListOpen && (
                <div className="absolute left-0 right-0 top-full z-[100] mt-1 overflow-hidden rounded-md border border-border shadow-[0_8px_30px_rgba(0,0,0,0.6)]">
                  <div
                    className="border-b border-border2 bg-s2"
                    style={{ padding: 8 }}
                  >
                    <input
                      type="text"
                      placeholder="Поиск моделей..." /* TODO(i18n) */
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      autoFocus
                      className="w-full rounded border border-border bg-surface font-ui text-[12px] text-t1 outline-none focus:border-accent"
                      style={{ padding: "5px 8px" }}
                    />
                  </div>
                  <div
                    className="max-h-[200px] overflow-y-auto bg-surface"
                    style={{ padding: 4 }}
                  >
                    {filteredModels.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => {
                          updateForm("model", m.id);
                          setModelListOpen(false);
                          setModelSearch("");
                        }}
                        className={`cursor-pointer rounded font-ui text-[12px] transition-colors ${
                          m.id === form.model
                            ? "bg-accent-dim font-medium text-accent-t"
                            : "text-t2 hover:bg-s2 hover:text-t1"
                        }`}
                        style={{ padding: "6px 10px" }}
                      >
                        {m.label}{" "}
                        <span className="ml-1 text-t4 opacity-70">
                          ({m.id})
                        </span>
                      </div>
                    ))}
                    {filteredModels.length === 0 && (
                      <div
                        className="py-2 text-center font-ui text-[11px] text-t4"
                        style={{ padding: "6px 10px" }}
                      >
                        {/* TODO(i18n) */}
                        Модели не найдены
                      </div>
                    )}
                  </div>
                </div>
              )}
              {!models.find((m) => m.id === form.model) && form.model && (
                <div className="mt-2 font-ui text-[12px] font-medium text-accent">
                  {/* TODO(i18n) */}
                  Пользовательская модель: {form.model}
                </div>
              )}
            </div>
          ) : (
            <input
              type="text"
              value={form.model}
              onChange={(e) => updateForm("model", e.target.value)}
              placeholder="ID модели (напр. gpt-4o)" /* TODO(i18n) */
              className={inputCls}
            />
          )}
        </div>
        <button
          onClick={() => void onFetchModels()}
          disabled={fetching}
          className="flex h-[37px] shrink-0 items-center gap-2 rounded-md border border-border bg-s2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
          style={{ padding: "0 16px" }}
        >
          {fetching ? (
            <>
              <span className="gen-cur">
                <span />
                <span />
                <span />
              </span>{" "}
              {/* TODO(i18n) */}
              Загрузка...
            </>
          ) : (
            <>
              <Icons.Regen /> {/* TODO(i18n) */}
              Обновить список
            </>
          )}
        </button>
      </div>
      {fetchError && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-warning">
          <Icons.Close />
          {fetchError}
        </div>
      )}
    </div>
  );
}

/* ── 5. ProviderCapabilitySection ─────────────────────────────────────── */

interface ProviderCapabilitySectionProps {
  capabilities: {
    nonStreamGeneration: boolean;
    abortSignal: boolean;
    streaming: boolean;
    prefill: boolean;
    sdkSupport: string;
  } | null;
}

export function ProviderCapabilitySection({
  capabilities,
}: ProviderCapabilitySectionProps) {
  if (!capabilities) return null;

  const items = [
    { label: "Non-streaming", on: capabilities.nonStreamGeneration },
    { label: "Streaming", on: capabilities.streaming },
    { label: "Abort", on: capabilities.abortSignal },
    { label: "Prefill", on: capabilities.prefill },
    { label: "SDK", on: capabilities.sdkSupport !== "unsupported" },
  ];

  return (
    <div className="my-6 rounded-lg border border-border2 bg-s2 p-4">
      {/* TODO(i18n) */}
      <div
        className="font-ui text-[12px] font-medium uppercase tracking-wider text-t3"
        style={{ marginBottom: 12 }}
      >
        Возможности
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <span
            key={it.label}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-ui text-[11px] font-medium ${
              it.on
                ? "border-success/20 bg-success/10 text-success"
                : "border-danger/20 bg-danger/10 text-danger"
            }`}
          >
            {it.on ? <Icons.Check /> : <Icons.Close />}
            {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── ProviderActionFooter ─────────────────────────────────────────────── */

interface ProviderActionFooterProps {
  providerProfiles: ProviderProfileRecord[];
  saveState: "idle" | "saving" | "saved" | "error";
  onDuplicate: () => void;
  onDelete: () => void;
  onSave: () => void;
  onActivate: () => void;
}

export function ProviderActionFooter({
  providerProfiles,
  saveState,
  onDuplicate,
  onDelete,
  onSave,
  onActivate,
}: ProviderActionFooterProps) {
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border px-6 py-4">
      <div className="flex gap-4">
        <span
          className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-t3 transition-colors hover:text-t1"
          onClick={() => void onDuplicate()}
        >
          <Icons.Copy /> {/* TODO(i18n) */}
          Дублировать провайдер
        </span>
        {providerProfiles.length > 1 && (
          <span
            className="flex cursor-pointer items-center gap-1.5 font-ui text-[13px] text-danger/80 transition-colors hover:text-danger"
            onClick={onDelete}
          >
            <Icons.Trash /> {/* TODO(i18n) */}
            Удалить профиль
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button
          className={`h-[37px] rounded-md border px-6 font-ui text-[13px] font-medium transition-colors ${
            saveState === "saved"
              ? "border-success/30 bg-success/10 text-success"
              : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1"
          }`}
          onClick={() => onSave()}
        >
          {saveState === "saving"
            ? "Сохранение..." /* TODO(i18n) */
            : saveState === "saved"
              ? "Сохранено" /* TODO(i18n) */
              : "Сохранить профиль"}
          {/* TODO(i18n) */}
        </button>
        <button
          className="h-[37px] rounded-md bg-accent px-6 font-ui text-[13px] font-medium text-white shadow-lg shadow-accent/20 transition-all hover:bg-accent-t"
          onClick={() => void onActivate()}
        >
          {/* TODO(i18n) */}
          Сделать активным
        </button>
      </div>
    </div>
  );
}
