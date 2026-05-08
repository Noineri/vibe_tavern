import type { ProviderProfileRecord } from "../../app-client.js";
import { cn } from "../../lib/cn.js";
import { getPresetGroup, PRESET_GROUPS, PROVIDER_PRESETS } from "../../provider-presets.js";
import type { FormState } from "../ProviderModal.js";
import { Icons } from "../shared/icons.js";

const labelCls = "block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3 mb-[7px]";
const inputCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent";
const selectCls = "w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent";
const pwCls = "font-mono tracking-[0.05em]";
const inputStyle = { padding: "0 13px" };
const selectStyle = { padding: "0 34px 0 13px" };

interface ProviderFormProps {
  form: FormState;
  editingId: string | null;
  providerProfiles: ProviderProfileRecord[];
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  applyPreset: (presetId: string) => void;
  testOk: boolean | null;
  testing: boolean;
  testingChat: boolean;
  chatResult: { reply?: string; error?: string } | null;
  onTest: () => void;
  onTestChat: () => void;
}

export function ProviderForm({
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
}: ProviderFormProps) {
  const presetGroup = getPresetGroup(form.providerPreset);
  const filteredPresets = presetGroup
    ? PROVIDER_PRESETS.filter((preset) => preset.group === presetGroup)
    : PROVIDER_PRESETS;
  const presetEndpoint = form.providerPreset
    ? PROVIDER_PRESETS.find((preset) => preset.id === form.providerPreset)?.baseUrl ?? ""
    : "";
  const duplicateNameWarning =
    form.name &&
    providerProfiles.some(
      (profile) =>
        profile.id !== editingId &&
        profile.name.trim().toLowerCase() === form.name.trim().toLowerCase(),
    );

  return (
    <>
      {/* Row 1: profile name + provider preset */}
      <div className="grid grid-cols-2 gap-4">
        <div className="mb-4">
          <label className={labelCls}>Имя профиля</label>
          <input
            type="text"
            value={form.name || ""}
            onChange={(event) => updateForm("name", event.target.value)}
            placeholder="Напр. OpenRouter RP"
            className={inputCls}
            style={inputStyle}
          />
          {duplicateNameWarning && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning [&_svg]:h-[12px] [&_svg]:w-[12px]">
              <Icons.Alert /> Профиль с таким именем уже существует
            </div>
          )}
        </div>
        <div className="mb-4">
          <label className={labelCls}>Пресет провайдера</label>
          <select
            value={presetGroup ?? ""}
            onChange={(event) => {
              const selectedGroup = event.target.value;
              if (!selectedGroup) {
                updateForm("providerPreset", "");
              } else {
                const firstPreset = PROVIDER_PRESETS.find((preset) => preset.group === selectedGroup);
                if (firstPreset) applyPreset(firstPreset.id);
              }
            }}
            className={selectCls}
            style={selectStyle}
          >
            <option value="">Custom</option>
            {PRESET_GROUPS.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Row 2: API format + preset endpoint */}
      <div className="grid grid-cols-2 gap-4">
        <div className="mb-4">
          <label className={labelCls}>API формат</label>
          <select
            value={form.providerPreset || ""}
            onChange={(event) => {
              if (event.target.value) applyPreset(event.target.value);
            }}
            className={selectCls}
            style={selectStyle}
          >
            <option value="">Custom</option>
            {filteredPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-4">
          <label className={labelCls}>Эндпоинт пресета</label>
          <input
            type="text"
            value={presetEndpoint || "Custom"}
            readOnly
            className={cn(inputCls, "!cursor-not-allowed !opacity-60")}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Custom endpoint */}
      <div className="mb-4">
        <label className={labelCls}>API эндпоинт (URL)</label>
        <input
          type="text"
          value={form.baseUrl || ""}
          onChange={(event) => updateForm("baseUrl", event.target.value)}
          placeholder="https://api.openai.com/v1"
          className={inputCls}
          style={inputStyle}
        />
      </div>

      {/* Stream toggle card */}
      <div className="mb-4 mt-2 rounded-lg border border-border2 bg-s2" style={{ padding: "12px 16px" }}>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "relative h-[18px] w-[32px] cursor-pointer rounded-full transition-colors",
              form.streamResponse ? "bg-accent" : "bg-border2",
            )}
            onClick={() => updateForm("streamResponse", !form.streamResponse)}
          >
            <div
              className={cn(
                "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-transform",
                form.streamResponse ? "translate-x-[16px]" : "translate-x-[2px]",
              )}
            />
          </div>
          <div>
            <div className="font-ui text-[13px] font-medium text-t1">Потоковый ответ</div>
            <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] text-t3 leading-[1.5]">
              Вкл: посимвольная генерация. Выкл: полный ответ появляется сразу.
            </div>
          </div>
        </div>
      </div>

      {/* API key */}
      <div className="mb-4">
        <label className={labelCls}>API ключ</label>
        <input
          type="password"
          value={form.apiKey || ""}
          onChange={(event) => updateForm("apiKey", event.target.value)}
          placeholder={form.hasStoredApiKey ? "Сохранён на бэкенде" : "sk-..."}
          className={cn(inputCls, pwCls)}
          style={inputStyle}
        />
      </div>

      {/* Test connection card */}
      <div className="mb-4 mt-4 rounded-lg border border-border bg-surface" style={{ padding: 16 }}>
        {!form.apiKey && !form.hasStoredApiKey ? (
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="h-2 w-2 rounded-full bg-t4" /> Нет подключения — введите API ключ выше
          </div>
        ) : !form.model ? (
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="h-2 w-2 rounded-full bg-t4" /> Модель не выбрана — выберите модель для начала
          </div>
        ) : (
          <div>
            <div className="flex gap-3">
              <button
                className={cn(
                  "rounded-md border font-ui text-[13px] font-medium transition-colors",
                  testOk === true
                    ? "border-success/30 bg-success/10 text-success"
                    : testOk === false
                      ? "border-danger/30 bg-danger/10 text-danger"
                      : "border-border bg-s2 text-t2 hover:border-border2 hover:text-t1",
                )}
                style={{ padding: "6px 16px" }}
                onClick={() => void onTest()}
                disabled={testing}
              >
                {testing ? "Проверка..." : "Проверить соединение"}
              </button>
              <button
                className="rounded-md border border-border bg-s2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
                style={{ padding: "6px 16px" }}
                onClick={() => void onTestChat()}
                disabled={testingChat}
              >
                {testingChat ? "Отправка..." : "Test Hi"}
              </button>
            </div>
            {testOk === true && (
              <div className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded bg-success/10 text-[12px] font-ui text-success" style={{ padding: "4px 10px" }}>
                  <Icons.Check /> Соединение успешно
                </span>
              </div>
            )}
            {testOk === false && (
              <div className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 text-[12px] font-ui text-danger" style={{ padding: "4px 10px" }}>
                  <Icons.Alert /> Ошибка соединения
                </span>
              </div>
            )}
            {chatResult && (
              <div className="mt-3">
                {chatResult.reply && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-success/10 text-[12px] font-ui text-success italic" style={{ padding: "4px 10px" }}>
                    &ldquo;{chatResult.reply.length > 200 ? `${chatResult.reply.slice(0, 200)}...` : chatResult.reply}&rdquo;
                  </span>
                )}
                {chatResult.error && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 text-[12px] font-ui text-danger" style={{ padding: "4px 10px" }}>
                    <Icons.Alert /> {chatResult.error}
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
