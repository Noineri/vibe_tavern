import type { ProviderProfileRecord } from '../../../app-client.js';
import { useT } from '../../../i18n/context.js';
import { PROVIDER_PRESETS, getPresetGroup, getVisiblePresetGroups, getVisibleProviderPresets } from '../../../provider-presets.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import { DropdownSelect } from '../../shared/DropdownSelect.js';
import { labelCls, inputCls, pwCls } from './form-field-classes.js';

interface ProviderEditHeaderProps {
  form: FormState;
  editingId: string | null;
  providerProfiles: ProviderProfileRecord[];
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  applyPreset: (presetId: string) => void;
  testOk: boolean | null;
  testing: boolean;
  onTest: () => void;
  onSave: () => void;
  onCancel?: () => void;
  isNew: boolean;
  isArmServer: boolean;
}

export function ProviderEditHeader({
  form, editingId, providerProfiles, updateForm, applyPreset,
  testOk, testing, onTest, onSave, onCancel, isNew, isArmServer,
}: ProviderEditHeaderProps) {
  const { t } = useT();
  const presetGroup = getPresetGroup(form.providerPreset);
  const visiblePresetGroups = getVisiblePresetGroups(isArmServer);
  const visiblePresets = getVisibleProviderPresets(isArmServer);
  const visiblePresetGroup = presetGroup && visiblePresetGroups.some((g) => g.id === presetGroup) ? presetGroup : null;
  const filteredPresets = visiblePresetGroup
    ? visiblePresets.filter((f) => f.group === visiblePresetGroup)
    : visiblePresets;
  const selectedPreset = form.providerPreset
    ? PROVIDER_PRESETS.find((f) => f.id === form.providerPreset)
    : undefined;
  const presetEndpoint = selectedPreset?.baseUrl ?? '';
  const hidesApiKey = selectedPreset?.noApiKey === true;

  const duplicateNameWarning =
    form.name &&
    providerProfiles.some(
      (p) =>
        p.id !== editingId &&
        p.name.trim().toLowerCase() === form.name.trim().toLowerCase()
    );

  return (
    <div className="mb-5 border-b border-border2 pb-5">
      <div className="mb-4 flex items-center gap-2 font-ui text-[15px] font-semibold text-t1">
        <Icons.Edit />
        {t("provider_connection_settings")}
      </div>

      {/* Row 1: profile name + preset group */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="mb-4">
          <label className={labelCls + " mb-[7px]"}>{t("profile_name")}</label>
          <input type="text" value={form.name} onChange={(e) => updateForm('name', e.target.value)} placeholder={t("profile_name_placeholder")} className={inputCls} />
          {duplicateNameWarning && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-warning">
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
              {t("profile_name_exists")}
            </div>
          )}
        </div>
        <div className="mb-4">
          <label className={labelCls + " mb-[7px]"}>{t("provider_preset_label")}</label>
          <SegmentedControl
            value={visiblePresetGroup ?? ''}
            options={[
              ...visiblePresetGroups.map((g) => ({ value: g.id, label: g.label })),
              { value: '', label: t("custom") },
            ]}
            onChange={(g) => { if (!g) { updateForm('providerPreset', ''); } else { const first = visiblePresets.find((f) => f.group === g); if (first) applyPreset(first.id); } }}
            mobileFill
          />
        </div>
      </div>

      {/* Row 2: API format + preset endpoint */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="mb-4">
          <label className={labelCls + " mb-[7px]"}>{t("api_format_label")}</label>
          <DropdownSelect
            value={form.providerPreset || ''}
            options={visiblePresetGroup ? filteredPresets.map((f) => ({ id: f.id, label: f.label })) : []}
            placeholder={t("custom")}
            disabled={!visiblePresetGroup}
            onChange={(val) => { if (val) applyPreset(val); }}
          />
        </div>
        <div className="mb-4">
          <label className={labelCls + " mb-[7px]"}>{t("preset_endpoint_label")}</label>
          <input type="text" value={presetEndpoint || t("custom")} readOnly className={cn(inputCls, '!cursor-not-allowed !opacity-60')} />
        </div>
      </div>

      {/* Custom endpoint */}
      <div className="mb-4">
        <label className={labelCls + " mb-[7px]"}>{t("custom_endpoint_label")}</label>
        <input type="text" value={form.baseUrl} onChange={(e) => updateForm('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" className={inputCls} />
      </div>

      {/* API key */}
      {hidesApiKey ? (
        <div className="mb-4 rounded-md border border-border2 bg-s2 px-3 py-2 font-ui text-[12px] text-t3">
          {t("api_key_not_required")}
        </div>
      ) : (
        <div className="mb-4">
          <label className={labelCls + " mb-[7px]"}>{t("api_key_label")}</label>
          <input type="password" value={form.apiKey} onChange={(e) => updateForm('apiKey', e.target.value)} placeholder={form.hasStoredApiKey ? t("api_key_stored") : t("api_key_placeholder")} className={cn(inputCls, pwCls)} />
        </div>
      )}

      {/* Test connection + Save */}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <button type="button"
          className={cn(
            'flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 py-2 font-ui text-[13px] font-medium transition-colors sm:min-h-0',
            testOk === true ? 'border-success/30 bg-success/10 text-success' :
            testOk === false ? 'border-danger/30 bg-danger/10 text-danger' :
            'border-border bg-s2 text-t2 hover:border-border2 hover:text-t1',
          )}
          onClick={() => void onTest()}
          disabled={testing}
        >
          <Icons.trace />
          {testing ? t("testing") : t("test_connection")}
        </button>
        <div className="flex-1" />
        {!isNew && onCancel && (
          <button type="button" onClick={onCancel} className="min-h-11 rounded-md border border-border bg-transparent px-4 py-2 font-ui text-[13px] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1 sm:min-h-0">
            {t("cancel")}
          </button>
        )}
        <button type="button" onClick={onSave} className="min-h-11 rounded-md bg-accent px-5 py-2 font-ui text-[13px] font-medium text-on-accent shadow-lg shadow-accent/20 transition-all hover:bg-accent-t sm:min-h-0">
          {t("save_settings_btn")}
        </button>
      </div>
    </div>
  );
}
