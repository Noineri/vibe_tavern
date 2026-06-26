import React from 'react';
import { useT } from '../../../i18n/context.js';
import type { ProviderProfileRecord } from '../../../app-client.js';
import { PROVIDER_PRESETS, getPresetGroup, getVisibleProviderPresets, getVisiblePresetGroups } from '../../../provider-presets.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { Toggle } from '../../shared/Toggle.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { DropdownSelect } from '../../shared/DropdownSelect.js';

const labelCls =
  'block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3';
const inputCls =
  'w-full h-11 sm:h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent px-[13px]';
const selectCls =
  'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent pl-[13px] sel-arrow';
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
  /** Hide endpoint, API key, stream toggle, and test card (wizard compact mode after successful connection) */
  hideConnectionFields?: boolean;
  /** Hide model-dependent test chat button (wizard provider edit mode) */
  hideTestChat?: boolean;
  /** When true (ARM/Termux build), Local presets (localhost-bound) are hidden from the selector. Mirrors ProviderEditHeader. */
  isArmServer: boolean;
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
  hideConnectionFields,
  hideTestChat,
  isArmServer,
}: ProviderFormProps) {
  const { t } = useT();
  const visiblePresets = getVisibleProviderPresets(isArmServer);
  const visiblePresetGroups = getVisiblePresetGroups(isArmServer);
  const presetGroup = getPresetGroup(form.providerPreset);
  const visiblePresetGroup = presetGroup && visiblePresetGroups.some((g) => g.id === presetGroup) ? presetGroup : null;
  const filteredPresets = visiblePresetGroup
    ? visiblePresets.filter((f) => f.group === visiblePresetGroup)
    : visiblePresets;
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("profile_name")}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm('name', e.target.value)}
            placeholder={t("profile_name_placeholder")}
            className={inputCls}
          />
          {duplicateNameWarning && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
              {t("profile_name_exists")}
            </div>
          )}
        </div>
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("provider_preset_label")}</label>
          <SegmentedControl
            value={visiblePresetGroup ?? ''}
            options={[
              ...visiblePresetGroups.map((g) => ({ value: g.id, label: g.label })),
              { value: '', label: t("custom") },
            ]}
            onChange={(g) => {
              if (!g) {
                updateForm('providerPreset', '');
              } else {
                const first = visiblePresets.find((f) => f.group === g);
                if (first) applyPreset(first.id);
              }
            }}
            mobileFill
          />
        </div>
      </div>

      {/* Row 2: API format + preset endpoint */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("api_format_label")}</label>
          <DropdownSelect
            value={form.providerPreset || ''}
            options={visiblePresetGroup ? filteredPresets.map((f) => ({ id: f.id, label: f.label })) : []}
            placeholder={t("custom")}
            disabled={!visiblePresetGroup}
            onChange={(val) => {
              if (val) applyPreset(val);
            }}
          />
        </div>
        <div className="mb-3">
          <label className={labelCls + " mb-[6px]"}>{t("preset_endpoint_label")}</label>
          <input
            type="text"
            value={presetEndpoint || t("custom")}
            readOnly
            className={cn(inputCls, '!cursor-not-allowed !opacity-60')}
          />
        </div>
      </div>

      {!hideConnectionFields && (<>
      {/* Custom endpoint */}
      <div className="mb-3">
        <label className={labelCls + " mb-[6px]"}>{t("custom_endpoint_label")}</label>
        <input
          type="text"
          value={form.baseUrl}
          onChange={(e) => updateForm('baseUrl', e.target.value)}
          placeholder="https://api.openai.com/v1"
          className={inputCls}
        />
      </div>

      {/* Stream toggle card */}
      <div className="my-3 rounded-lg border border-border2 bg-s2 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Toggle checked={form.streamResponse !== false} onChange={(v) => updateForm('streamResponse', v as FormState['streamResponse'])} className="!mb-0 !inline-flex" />
          <div>
            <div className="font-ui text-[13px] font-medium text-t1">
              {t("stream_response")}
            </div>
            <div className="mt-0.5 text-[calc(var(--ui-fs)-3px)] leading-[1.5] text-t3">
              {t("stream_response_hint")}
            </div>
          </div>
        </div>
      </div>

      {/* API key */}
      <div className="mb-3">
        <label className={labelCls + " mb-[6px]"}>{t("api_key_label")}</label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => updateForm('apiKey', e.target.value)}
          placeholder={form.hasStoredApiKey ? t("api_key_stored") : t("api_key_placeholder")}
          className={cn(inputCls, pwCls)}
        />
      </div>

      {/* Test connection card */}
      <div className="my-3 rounded-lg border border-border bg-surface p-3.5">
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
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
              <button type="button"
                className={cn(
                  'min-h-11 rounded-md border px-4 py-2 font-ui text-[13px] font-medium transition-colors sm:min-h-0 sm:py-1.5',
                  testOk === true
                    ? 'border-success/30 bg-success/10 text-success'
                    : testOk === false
                      ? 'border-danger/30 bg-danger/10 text-danger'
                      : 'border-border bg-s2 text-t2 hover:border-border2 hover:text-t1'
                )}
                onClick={() => void onTest()}
                disabled={testing}
              >
                {testing ? t("testing") : t("test_connection")}
              </button>
              {!hideTestChat && (
                <button type="button"
                  className="min-h-11 rounded-md border border-border bg-s2 px-4 py-2 font-ui text-[13px] font-medium text-t2 transition-colors hover:border-border2 hover:text-t1 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
                  onClick={() => void onTestChat()}
                  disabled={testingChat}
                >
                  {testingChat ? t("sending") : t("test_hi_btn")}
                </button>
              )}
            </div>
            {testOk === true && (
              <div className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] text-success">
                  <Icons.Check />
                  {t("connection_successful")}
                </span>
              </div>
            )}
            {testOk === false && (
              <div className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                  <Icons.Close />
                  {t("connection_failed")}
                </span>
              </div>
            )}
            {!hideTestChat && chatResult && (
              <div className="mt-3">
                {chatResult.reply && (
                  <span className="inline-flex max-w-full items-center gap-1.5 break-words rounded bg-success/10 px-2.5 py-1 font-ui text-[12px] italic text-success">
                    &ldquo;
                    {chatResult.reply.length > 200
                      ? chatResult.reply.slice(0, 200) + '...'
                      : chatResult.reply}
                    &rdquo;
                  </span>
                )}
                {chatResult.error && (
                  <span className="inline-flex max-w-full items-center gap-1.5 break-words rounded bg-danger/10 px-2.5 py-1 font-ui text-[12px] text-danger">
                    <Icons.Close />
                    {chatResult.error}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </>)}
    </>
  );
}
