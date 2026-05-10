import type { ProviderProfileRecord } from '../../app-client.js';
import { PROVIDER_PRESETS, getPresetGroup, PRESET_GROUPS } from '../../provider-presets.js';
import type { FormState } from '../ProviderModal.js';
import { Icons } from '../shared/icons.js';
import { cn } from '../../lib/cn.js';

const labelCls = 'block text-[calc(var(--ui-fs)-3px)] font-medium tracking-[0.06em] uppercase text-t3';
const inputCls = 'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent';
const selectCls = 'w-full h-[38px] bg-s2 border border-border rounded-[6px] font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-[border-color] duration-150 focus:border-accent';
const inputPad = { padding: '0 13px' };
const selectPad = { padding: '0 34px 0 13px' };

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
}

export function ProviderEditHeader({
  form, editingId, providerProfiles, updateForm, applyPreset,
  testOk, testing, onTest, onSave, onCancel, isNew,
}: ProviderEditHeaderProps) {
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
    <div className="mb-5 border-b border-border2 pb-5">
      <div className="mb-4 flex items-center gap-2 font-ui text-[15px] font-semibold text-t1">
        <Icons.Edit />
        Connection Settings
      </div>

      {/* Row 1: profile name + preset group */}
      <div className="grid grid-cols-2 gap-4">
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>Profile Name</label>
          <input type="text" value={form.name} onChange={(e) => updateForm('name', e.target.value)} placeholder="e.g. OpenRouter RP" className={inputCls} style={inputPad} />
          {duplicateNameWarning && (
            <div className="flex items-center gap-1 text-[11px] text-warning" style={{ marginTop: 4 }}>
              <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Alert /></span>
              A profile with this name already exists
            </div>
          )}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>Provider Preset</label>
          <select value={presetGroup ?? ''} onChange={(e) => { const g = e.target.value; if (!g) { updateForm('providerPreset', ''); } else { const first = PROVIDER_PRESETS.find((f) => f.group === g); if (first) applyPreset(first.id); } }} className={selectCls} style={selectPad}>
            <option value="">Custom</option>
            {PRESET_GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </div>
      </div>

      {/* Row 2: API format + preset endpoint */}
      <div className="grid grid-cols-2 gap-4">
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>API Format</label>
          <select value={form.providerPreset || ''} onChange={(e) => { const val = e.target.value; if (val) applyPreset(val); }} className={selectCls} style={selectPad}>
            <option value="">Custom</option>
            {filteredPresets.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label className={labelCls} style={{ marginBottom: 7 }}>Preset Endpoint</label>
          <input type="text" value={presetEndpoint || 'Custom'} readOnly className={cn(inputCls, '!cursor-not-allowed !opacity-60')} style={inputPad} />
        </div>
      </div>

      {/* Custom endpoint */}
      <div style={{ marginBottom: 16 }}>
        <label className={labelCls} style={{ marginBottom: 7 }}>Custom Endpoint (optional)</label>
        <input type="text" value={form.baseUrl} onChange={(e) => updateForm('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" className={inputCls} style={inputPad} />
      </div>

      {/* API key */}
      <div style={{ marginBottom: 16 }}>
        <label className={labelCls} style={{ marginBottom: 7 }}>API Key</label>
        <input type="password" value={form.apiKey} onChange={(e) => updateForm('apiKey', e.target.value)} placeholder={form.hasStoredApiKey ? 'Stored on backend' : 'sk-...'} className={cn(inputCls, 'font-mono tracking-[0.05em]')} style={inputPad} />
      </div>

      {/* Test connection + Save */}
      <div className="mt-2 flex items-center gap-3">
        <button
          className={cn(
            'flex items-center gap-2 rounded-md border py-2 px-4 font-ui text-[13px] font-medium transition-colors',
            testOk === true ? 'border-success/30 bg-success/10 text-success' :
            testOk === false ? 'border-danger/30 bg-danger/10 text-danger' :
            'border-border bg-s2 text-t2 hover:border-border2 hover:text-t1',
          )}
          onClick={() => void onTest()}
          disabled={testing}
        >
          <Icons.trace />
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <div className="flex-1" />
        {!isNew && onCancel && (
          <button onClick={onCancel} className="rounded-md border border-border bg-transparent py-2 px-4 font-ui text-[13px] font-medium text-t2 transition-colors hover:bg-s2 hover:text-t1">
            Cancel
          </button>
        )}
        <button onClick={onSave} className="rounded-md bg-accent py-2 px-5 font-ui text-[13px] font-medium text-white shadow-lg shadow-accent/20 transition-all hover:bg-accent-t">
          Save Settings
        </button>
      </div>
    </div>
  );
}
