import React from 'react';
import { useT } from '../../i18n/context.js';
import type { ProviderProfileRecord } from '../../app-client.js';
import { PROVIDER_PRESETS, getPresetGroup, PRESET_GROUPS } from '../../provider-presets.js';
import type { FormState } from '../ProviderModal.js';
import { Icons } from '../shared/icons.js';
import { cn } from '../../lib/cn.js';
import { Toggle } from '../shared/Toggle.js';

const labelCls =
  'block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3';
const inputCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent';
const selectCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent';
const inputPad = { padding: '0 13px' };
const selectPad = { padding: '0 34px 0 13px' };
const pwCls = 'font-mono tracking-[0.05em]';

interface ProviderFormProps {
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
  const { t } = useT();
  const presetGroup = getPresetGroup(form.providerPreset);
  const filteredPresets = presetGroup
    ? PROVIDER_PRESETS.filter((f) => f.group === presetGroup)
    : PROVIDER_PRESETS;
  const presetEndpoint = form.providerPreset
    ? PROVIDER_PRESETS.find((f) => f.id === form.providerPreset)?.baseUrl ?? ''
    : '';

  const duplicateNameWarning =
    form.name &&
    providerProfiles.some(
      (p) =>
        p.id !== editingId &&
        p.name.trim().toLowerCase() === form.name.trim().toLowerCase()
    );

  return (
    <>
      {/* Row 1: profile name + provider preset */}
      <div className="grid grid-cols-2 gap-4">
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>{t("profile_name")}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm('name', e.target.value)}
            placeholder={t("profile_name_placeholder")}
            className={inputCls}
            style={inputPad}
          />
          {duplicateNameWarning && (
            <div className="flex items-center gap-1 text-[11px] text-warning" style={{ marginTop: 4 }}>
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
              {t("profile_name_exists")}
            </div>
          )}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>{t("provider_preset_label")}</label>
          <select
            value={presetGroup ?? ''}
            onChange={(e) => {
              const g = e.target.value;
              if (!g) {
                updateForm('providerPreset', '');
              } else {
                const first = PROVIDER_PRESETS.find((f) => f.group === g);
                if (first) applyPreset(first.id);
              }
            }}
            className={selectCls}
            style={selectPad}
          >
            <option value="">{t("custom")}</option>
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
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>{t("api_format_label")}</label>
          <select
            value={form.providerPreset || ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val) applyPreset(val);
            }}
            className={selectCls}
            style={selectPad}
          >
            <option value="">{t("custom")}</option>
            {filteredPresets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>{t("preset_endpoint_label")}</label>
          <input
            type="text"
            value={presetEndpoint || t("custom")}
            readOnly
            className={cn(inputCls, '!cursor-not-allowed !opacity-60')}
            style={inputPad}
          />
        </div>
      </div>

      {/* Custom endpoint */}
      <div style={{ marginBottom: 16 }}>
        <label className={labelCls} style={{ marginBottom: 7 }}>{t("custom_endpoint_label")}</label>
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => updateForm('baseUrl', e.target.value)}
          placeholder="https://api.openai.com/v1"
          className={inputCls}
          style={inputPad}
        />
      </div>

      {/* Stream toggle card */}
      <div className="rounded-lg border border-border2 bg-s2" style={{ marginTop: 8, marginBottom: 16, padding: '12px 16px' }}>
        <div className="flex items-center gap-3">
          <Toggle checked={form.streamResponse !== false} onChange={(v) => updateForm('streamResponse', v as FormState['streamResponse'])} className="!mb-0 !inline-flex" />
          <div>
            <div className="font-ui text-[13px] font-medium text-t1">
              {t("stream_response")}
            </div>
            <div className="text-[calc(var(--ui-fs)-3px)] text-t3" style={{ marginTop: 2, lineHeight: 1.5 }}>
              {t("stream_response_hint")}
            </div>
          </div>
        </div>
      </div>

      {/* API key */}
      <div style={{ marginBottom: 16 }}>
        <label className={labelCls} style={{ marginBottom: 7 }}>{t("api_key_label")}</label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => updateForm('apiKey', e.target.value)}
          placeholder={form.hasStoredApiKey ? t("api_key_stored") : t("api_key_placeholder")}
          className={cn(inputCls, pwCls)}
          style={inputPad}
        />
      </div>

      {/* Test connection card */}
      <div className="rounded-lg border border-border bg-surface" style={{ marginTop: 16, marginBottom: 16, padding: 16 }}>
        {!form.apiKey && !form.hasStoredApiKey ? (
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="h-2 w-2 rounded-full bg-t4" />
            {t("no_connection_enter_key")}
          </div>
        ) : !form.model ? (
          <div className="flex items-center gap-2 font-ui text-[13px] text-t3">
            <span className="h-2 w-2 rounded-full bg-t4" />
            {t("no_model_selected_begin")}
          </div>
        ) : (
          <div>
            <div className="flex gap-3">
              <button
                className={cn(
                  'rounded-md border font-ui text-[13px] font-medium transition-colors',
                  testOk === true
                    ? 'border-success/30 bg-success/10 text-success'
                    : testOk === false
                      ? 'border-danger/30 bg-danger/10 text-danger'
                      : 'border-border bg-s2 text-t2 hover:border-border2 hover:text-t1'
                )}
                style={{ padding: '6px 16px' }}
                onClick={() => void onTest()}
                disabled={testing}
              >
                {testing ? t("testing") : t("test_connection")}
              </button>
              <button
                className="rounded-md border border-border bg-s2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50"
                style={{ padding: '6px 16px' }}
                onClick={() => void onTestChat()}
                disabled={testingChat}
              >
                {testingChat ? t("sending") : t("test_hi_btn")}
              </button>
            </div>
            {testOk === true && (
              <div style={{ marginTop: 12 }}>
                <span className="inline-flex items-center gap-1.5 rounded bg-success/10 font-ui text-[12px] text-success" style={{ padding: '4px 10px' }}>
                  <Icons.Check />
                  {t("connection_successful")}
                </span>
              </div>
            )}
            {testOk === false && (
              <div style={{ marginTop: 12 }}>
                <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 font-ui text-[12px] text-danger" style={{ padding: '4px 10px' }}>
                  <Icons.Close />
                  {t("connection_failed")}
                </span>
              </div>
            )}
            {chatResult && (
              <div style={{ marginTop: 12 }}>
                {chatResult.reply && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-success/10 font-ui text-[12px] text-success italic" style={{ padding: '4px 10px' }}>
                    &ldquo;
                    {chatResult.reply.length > 200
                      ? chatResult.reply.slice(0, 200) + '...'
                      : chatResult.reply}
                    &rdquo;
                  </span>
                )}
                {chatResult.error && (
                  <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 font-ui text-[12px] text-danger" style={{ padding: '4px 10px' }}>
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
