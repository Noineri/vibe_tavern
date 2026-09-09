import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PROVIDER_TYPE } from '@vibe-tavern/domain';
import { useT } from '../../../i18n/context.js';
import type { FormState } from '../../modals/ProviderModal.js';
import { ChipInput } from '../../shared/ChipInput.js';
import { LogitBiasPanel } from './LogitBiasPanel.js';
import { Icons } from '../../shared/icons.js';
import { cn } from '../../../lib/cn.js';
import { CustomTooltip } from '../../shared/Tooltip.js';
import { SegmentedControl } from '../../shared/SegmentedControl.js';
import type { SamplerCapabilityFlags, SamplerFieldId } from '@vibe-tavern/domain';
import { NumberInput } from '../../shared/NumberInput.js';
import { AnimatedDisclosure } from '../../shared/AnimatedDisclosure.js';
import { samplerPresetPayloadSchema, type SamplerSet } from '@vibe-tavern/api-contracts';
import { computeOverlayPatch } from '../../../hooks/save-provider-patch.js';
import { applySamplerPresetFields, filterOverlayByCapabilities, overlayDivergesFromSet } from '../../../lib/sampler-clipboard.js';
import {
  createSamplerSet,
  deleteSamplerSet,
  importSamplerSet,
  listSamplerSets,
  updateSamplerSet,
} from '../../../api/sampler-set-api.js';
import { DropdownSelect } from '../../shared/DropdownSelect.js';
import { DestructiveConfirmModal } from '../../shared/destructive-confirm-modal.js';
import type { ModelSettingsOverlay } from '@vibe-tavern/domain';

/* ── SamplerField sub-component ────────────────────────────────────── */

interface SamplerFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  tooltip?: string;
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
  tooltip,
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
      <label className="mb-[7px] flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
        <span>{label}</span>
        {tooltip && (
          <CustomTooltip content={tooltip} side="top" align="start">
            <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border2 bg-s3 text-[10px] font-semibold normal-case tracking-normal text-t3">?</span>
          </CustomTooltip>
        )}
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
          className="h-[30px] w-[60px] shrink-0"
          min={min}
          max={max}
          step={step}
          value={val}
          onChange={onChange}
          disabled={disabled}
          hideControls
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

/** Default sampler values when custom samplers are toggled ON. */
const CUSTOM_SAMPLER_DEFAULTS = {
  topP: 0.95,
  topK: 75,
  topA: 1.0,
  minP: 0,
  typicalP: 1.0,
  tfsZ: 1.0,
  adaptiveTarget: -1,
  adaptiveDecay: 0.9,
  dynatempRange: 0,
  dynatempExponent: 1,
  topNSigma: 0,
  smoothingFactor: 0,
  repeatLastN: 0,
  mirostat: 0,
  mirostatTau: 5.0,
  mirostatEta: 0.1,
  dryMultiplier: 0,
  dryBase: 1.75,
  dryAllowedLength: 2,
  dryPenaltyLastN: -1,
  drySequenceBreakers: [] as string[],
  bannedStrings: [] as string[],
  xtcThreshold: 0.1,
  xtcProbability: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  repetitionPenalty: 0,
} as const;

interface ProviderSamplerPanelProps {
  form: FormState;
  updateForm: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  capabilities?: { logitBias?: boolean; samplers?: SamplerCapabilityFlags; [k: string]: unknown } | null;
}

export function ProviderSamplerPanel({ form, updateForm, capabilities }: ProviderSamplerPanelProps) {
  const { t } = useT();
  const [advOpen, setAdvOpen] = useState(false);
  const disabled = !form.customSamplers;
  const samplerCaps = capabilities?.samplers;
  const supports = (field: SamplerFieldId) => samplerCaps?.[field] ?? true;

  const handleToggleCustomSamplers = (enabled: boolean) => {
    if (enabled) {
      // Apply custom sampler defaults when enabling
      updateForm('customSamplers', true);
      updateForm('topP', CUSTOM_SAMPLER_DEFAULTS.topP);
      updateForm('topK', CUSTOM_SAMPLER_DEFAULTS.topK);
      updateForm('topA', CUSTOM_SAMPLER_DEFAULTS.topA);
      updateForm('minP', CUSTOM_SAMPLER_DEFAULTS.minP);
      updateForm('typicalP', CUSTOM_SAMPLER_DEFAULTS.typicalP);
      updateForm('tfsZ', CUSTOM_SAMPLER_DEFAULTS.tfsZ);
      updateForm('adaptiveTarget', CUSTOM_SAMPLER_DEFAULTS.adaptiveTarget);
      updateForm('adaptiveDecay', CUSTOM_SAMPLER_DEFAULTS.adaptiveDecay);
      updateForm('dynatempRange', CUSTOM_SAMPLER_DEFAULTS.dynatempRange);
      updateForm('dynatempExponent', CUSTOM_SAMPLER_DEFAULTS.dynatempExponent);
      updateForm('topNSigma', CUSTOM_SAMPLER_DEFAULTS.topNSigma);
      updateForm('smoothingFactor', CUSTOM_SAMPLER_DEFAULTS.smoothingFactor);
      updateForm('repeatLastN', CUSTOM_SAMPLER_DEFAULTS.repeatLastN);
      updateForm('mirostat', CUSTOM_SAMPLER_DEFAULTS.mirostat);
      updateForm('mirostatTau', CUSTOM_SAMPLER_DEFAULTS.mirostatTau);
      updateForm('mirostatEta', CUSTOM_SAMPLER_DEFAULTS.mirostatEta);
      updateForm('dryMultiplier', CUSTOM_SAMPLER_DEFAULTS.dryMultiplier);
      updateForm('dryBase', CUSTOM_SAMPLER_DEFAULTS.dryBase);
      updateForm('dryAllowedLength', CUSTOM_SAMPLER_DEFAULTS.dryAllowedLength);
      updateForm('drySequenceBreakers', CUSTOM_SAMPLER_DEFAULTS.drySequenceBreakers);
      updateForm('bannedStrings', CUSTOM_SAMPLER_DEFAULTS.bannedStrings);
      updateForm('dryPenaltyLastN', CUSTOM_SAMPLER_DEFAULTS.dryPenaltyLastN);
      updateForm('xtcThreshold', CUSTOM_SAMPLER_DEFAULTS.xtcThreshold);
      updateForm('xtcProbability', CUSTOM_SAMPLER_DEFAULTS.xtcProbability);
      updateForm('frequencyPenalty', CUSTOM_SAMPLER_DEFAULTS.frequencyPenalty);
      updateForm('presencePenalty', CUSTOM_SAMPLER_DEFAULTS.presencePenalty);
      updateForm('repetitionPenalty', CUSTOM_SAMPLER_DEFAULTS.repetitionPenalty);
      setAdvOpen(true);
    } else {
      updateForm('customSamplers', false);
    }
  };

  // ── Named sampler-set library (LOCAL_SUPPORT_PLAN LS-5) ──
  // The clipboard copy/paste buttons are REPLACED by the set row: a bounded
  // inline DropdownSelect + 7 icon-only actions (+ / 💾 / ✏ / 🔄 / 🗑 / ⬆ / ⬇).
  // The clipboard trio (schema + apply + extract) IS the set engine —
  // applySamplerPresetFields/computeOverlayPatch keep their clipboards-era
  // boundary (their tests stay); only the clipboard I/O went away.
  //
  // Semantics (LS-5e, owner-confirmed):
  //  - Apply (select / re-select / 🔄) = safeParse → filter by the panel's
  //    per-protocol capability set (LS-5f — unsupported values never enter the
  //    form) → applySamplerPresetFields (overlay-vs-base routing is free).
  //  - 💾 = computeOverlayPatch(form) → update the selected set's payload.
  //  - «+» = the same payload under the morph-entered name.
  //  - Profile.samplerSetId rides updateForm on apply/💾/+; cleared by delete
  //    of that set and by picking "no set".
  //  - Dirty dot: the applied (capability-filtered) payload vs the current
  //    extract, field-wise deep compare; cleared by 💾 and by re-applying.
  const [sets, setSets] = useState<SamplerSet[]>([]);
  const [setsLoaded, setSetsLoaded] = useState(false);
  /** Morph state: the dropdown is replaced by a name input (input + ✓ + ✕,
   *  lorebook-accordion inline-rename clone). "new" = the «+» save-as-new flow;
   *  "rename" = the pencil flow, prefilled with the set's current name. */
  const [morph, setMorph] = useState<null | { intent: 'new' | 'rename'; value: string }>(null);
  /** Server-side name-collision rejection (the inline warning shows for both
   *  the client-side check and a raced 409). Cleared on any name edit. */
  const [morphConflict, setMorphConflict] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The payload currently considered APPLIED (capability-filtered): the
   *  dirty-dot baseline. Filled by apply/💾/+; back-filled from the profile's
   *  pre-selected set on first load (no re-apply — the values already live on
   *  the profile from a previous session). */
  const appliedRef = useRef<{ setId: string; baseline: Partial<ModelSettingsOverlay> } | null>(null);
  const [, forceRender] = useState(0);
  const bumpApplied = () => forceRender((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void listSamplerSets()
      .then((list) => {
        if (cancelled) return;
        setSets(list);
        setSetsLoaded(true);
      })
      .catch(() => {
        // Library fetch failure leaves the row in its no-set state — the panel
        // itself (knobs + autosave) keeps working. A retry happens on remount.
        if (!cancelled) setSetsLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = sets.find((s) => s.id === form.samplerSetId) ?? null;

  // Back-fill the dirty-dot baseline from the profile's pre-selected set once
  // the library arrives (previous-session pre-selection — no re-apply).
  useEffect(() => {
    if (!setsLoaded || !form.samplerSetId) return;
    if (appliedRef.current?.setId === form.samplerSetId) return;
    const set = sets.find((s) => s.id === form.samplerSetId);
    if (!set) return;
    const parsed = samplerPresetPayloadSchema.safeParse(set.payload);
    if (!parsed.success) return;
    appliedRef.current = { setId: set.id, baseline: filterOverlayByCapabilities(parsed.data, supports) };
    bumpApplied();
  });

  const isDirty = Boolean(
    selected &&
      appliedRef.current?.setId === selected.id &&
      overlayDivergesFromSet(appliedRef.current.baseline, computeOverlayPatch(form)),
  );

  const applySet = (set: SamplerSet) => {
    const parsed = samplerPresetPayloadSchema.safeParse(set.payload);
    if (!parsed.success) {
      toast.error(t('sampler_set_invalid'));
      return;
    }
    // Per-protocol filtering ON APPLY (LS-5f): unsupported values never enter
    // the form, so they can't persist invisibly onto the profile.
    const filtered = filterOverlayByCapabilities(parsed.data, supports);
    applySamplerPresetFields(filtered, updateForm);
    appliedRef.current = { setId: set.id, baseline: filtered };
    bumpApplied();
    updateForm('samplerSetId', set.id);
    toast.success(t('sampler_set_applied', { name: set.name }));
  };

  const handleSelectSet = (id: string) => {
    if (!id) {
      // Explicit "no set": clear the pointer, keep the panel's current values.
      updateForm('samplerSetId', null);
      appliedRef.current = null;
      bumpApplied();
      return;
    }
    const set = sets.find((s) => s.id === id);
    if (set) applySet(set);
  };

  const handleSaveIntoSet = async () => {
    if (!selected) return;
    const payload = computeOverlayPatch(form);
    try {
      const updated = await updateSamplerSet(selected.id, { payload });
      setSets((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      appliedRef.current = { setId: updated.id, baseline: filterOverlayByCapabilities(payload, supports) };
      bumpApplied();
      updateForm('samplerSetId', updated.id);
      toast.success(t('sampler_set_saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sampler_set_action_failed'));
    }
  };

  const handleMorphConfirm = async () => {
    if (!morph) return;
    const name = morph.value.trim();
    if (!name) return;
    if (morph.intent === 'new') {
      try {
        const created = await createSamplerSet({ name, payload: computeOverlayPatch(form) });
        setSets((list) => [...list, created]);
        appliedRef.current = { setId: created.id, baseline: filterOverlayByCapabilities(created.payload, supports) };
        bumpApplied();
        updateForm('samplerSetId', created.id);
        setMorph(null);
        setMorphConflict(false);
        toast.success(t('sampler_set_created'));
      } catch (error) {
        // A raced name collision (someone else created the name) shows the
        // same inline warning as the client-side check.
        setMorphConflict(true);
        toast.error(error instanceof Error ? error.message : t('sampler_set_action_failed'));
      }
      return;
    }
    if (!selected) return;
    try {
      const updated = await updateSamplerSet(selected.id, { name });
      setSets((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      setMorph(null);
      setMorphConflict(false);
      toast.success(t('sampler_set_renamed'));
    } catch (error) {
      setMorphConflict(true);
      toast.error(error instanceof Error ? error.message : t('sampler_set_action_failed'));
    }
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteId) return;
    const target = sets.find((s) => s.id === confirmDeleteId);
    try {
      await deleteSamplerSet(confirmDeleteId);
      setSets((list) => list.filter((s) => s.id !== confirmDeleteId));
      if (form.samplerSetId === confirmDeleteId) {
        // Deleting a set never touches profiles that already applied it
        // (copy-on-select) — only the pointer clears.
        updateForm('samplerSetId', null);
      }
      if (appliedRef.current?.setId === confirmDeleteId) {
        appliedRef.current = null;
        bumpApplied();
      }
      setConfirmDeleteId(null);
      if (target) toast.success(t('sampler_set_deleted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sampler_set_action_failed'));
    }
  };

  const handleImportFile = async (file: File) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      toast.error(t('sampler_set_import_failed'));
      return;
    }
    const name = file.name.replace(/\.json$/i, '').trim() || t('sampler_set_import_default_name');
    try {
      const { set, notes } = await importSamplerSet({ name, raw });
      setSets((list) => [...list.filter((s) => s.id !== set.id), set]);
      if (notes.length > 0) toast.warning(notes.join(' · '));
      toast.success(t('sampler_set_imported', { name: set.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sampler_set_import_failed'));
    }
  };

  const handleExportSet = () => {
    if (!selected) return;
    // VT-native set JSON = the raw payload (a valid samplerPresetPayloadSchema
    // object): re-uploading it via the import endpoint round-trips losslessly.
    // VT carries fields ST lacks (adaptive-p, DRY tail), so a 1:1 ST-compatible
    // export is not promised (LS-5 edge case 6).
    const payloadJson = JSON.stringify(selected.payload, null, 2);
    const blob = new Blob([payloadJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selected.name.replace(/[/\\:*?"<>|]/g, '_')}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  // Inline collision check (ProviderEditHeader duplicateNameWarning clone):
  // trim + case-insensitive, excluding the renamed set itself.
  const morphName = morph?.value.trim() ?? '';
  const morphSelfId = morph?.intent === 'rename' ? selected?.id : null;
  const morphClientConflict =
    morphName.length > 0 &&
    sets.some(
      (s) => s.id !== morphSelfId && s.name.trim().toLowerCase() === morphName.toLowerCase(),
    );
  const morphShowConflict = morphClientConflict || morphConflict;
  const morphConfirmDisabled = morphName.length === 0 || morphShowConflict;

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
          {form.providerPreset === PROVIDER_TYPE.koboldCpp && (
            <div className="mt-1 font-ui text-[11px] text-t3 italic">{t("context_kobold_hint")}</div>
          )}
        </div>

        {/* Token padding (LS-1d): safety margin subtracted from the context
            budget — compensates chat-template overhead the estimator can't
            see (local backends). Profile-level, consumed server-side via
            effectiveContextBudget. */}
        <div>
          <CustomTooltip content={t("token_padding_hint")}>
            <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
              {t("token_padding")}
            </label>
          </CustomTooltip>
          <InlineNumField
            value={form.tokenPadding}
            placeholder="0"
            onBlur={(v) => updateForm('tokenPadding', Math.max(0, Math.round(v)))}
          />
        </div>

        {/* Temperature */}
        {supports('temperature') && (
          <SamplerField
            label={`${t("sampler_temperature")} (${form.temperature})`}
            tooltip={t("sampler_temperature_hint")}
            min={0}
            max={2}
            step={0.05}
            value={form.temperature}
            onChange={(v) => updateForm('temperature', v)}
          />
        )}

        {/* Reasoning effort */}
        {supports('reasoningEffort') && (
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
        )}
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
          {/* Named sampler-set row (LS-5): bounded inline dropdown + 7 icon
              actions + the customSamplers toggle switch. Icon-only per the
              owner's final decision — no labels, tooltips only. */}
          <div className="flex items-center gap-1">
            {morph ? (
              /* ── Morph state: dropdown → name input (lorebook-accordion
                  inline-rename clone: input + ✓ + ✕, Enter = save, autofocus) ── */
              <div className="flex min-w-0 items-center gap-1">
                <div className="flex min-w-0 flex-col">
                  <input
                    type="text"
                    data-testid="sampler-set-name-input"
                    className={cn(
                      "h-7 w-[180px] rounded border bg-bg px-2 text-[12px] text-t1 outline-none",
                      morphShowConflict ? "border-danger" : "border-accent",
                    )}
                    value={morph.value}
                    onChange={(e) => {
                      setMorph({ ...morph, value: e.target.value });
                      setMorphConflict(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleMorphConfirm();
                      if (e.key === 'Escape') setMorph(null);
                    }}
                    placeholder={t('sampler_set_name_placeholder')}
                    autoFocus
                  />
                  {morphShowConflict && (
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] text-warning">
                      <span className="[&_svg]:h-[10px] [&_svg]:w-[10px]"><Icons.Alert /></span>
                      {t('sampler_set_name_exists')}
                    </div>
                  )}
                </div>
                <CustomTooltip content={t('confirm')}>
                  <button
                    type="button"
                    data-testid="sampler-set-morph-confirm"
                    disabled={morphConfirmDisabled}
                    onClick={(e) => { e.stopPropagation(); void handleMorphConfirm(); }}
                    className="flex h-7 w-7 items-center justify-center rounded text-accent-t transition-colors hover:bg-[var(--border)] disabled:pointer-events-none disabled:opacity-40"
                    aria-label={t('confirm')}
                  >
                    <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Check /></span>
                  </button>
                </CustomTooltip>
                <CustomTooltip content={t('cancel')}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setMorph(null); }}
                    className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
                    aria-label={t('cancel')}
                  >
                    <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Close /></span>
                  </button>
                </CustomTooltip>
              </div>
            ) : (
              <div className="flex min-w-0 items-center">
                <DropdownSelect
                  value={form.samplerSetId ?? ''}
                  options={sets.map((s) => ({ id: s.id, label: s.name }))}
                  defaultOption={t('sampler_set_none')}
                  placeholder={t('sampler_set_placeholder')}
                  onChange={handleSelectSet}
                  /* Inline slot (AGENTS.md inline-row gotcha): bounded auto
                     width, NO form-fill trigger, NO detail in the collapsed
                     trigger; the popup gets its own fixed width. */
                  triggerClassName="h-7 w-auto max-w-[200px] rounded border border-border bg-s2 px-2 py-0 text-[12px] hover:border-accent"
                  triggerDetail={false}
                  contentWidth={260}
                  triggerLeading={
                    isDirty ? (
                      /* Dirty dot (owner): values diverged from the set.
                         Cleared by 💾 and by re-applying/re-selecting. */
                      <span
                        data-testid="sampler-set-dirty-dot"
                        className="h-[6px] w-[6px] shrink-0 rounded-full bg-accent"
                      />
                    ) : undefined
                  }
                  triggerTestId="sampler-set-trigger"
                />
              </div>
            )}
            {/* Icon-only action row. Pencil/refresh/trash/download act on the
                selected set — disabled when none is selected (same rule as
                diskette/refresh; no target = no action). */}
            <CustomTooltip content={t('sampler_set_new')}>
              <button
                type="button"
                data-testid="sampler-set-new"
                onClick={(e) => { e.stopPropagation(); setMorph({ intent: 'new', value: '' }); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
                aria-label={t('sampler_set_new')}
              >
                <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Plus /></span>
              </button>
            </CustomTooltip>
            <CustomTooltip content={t('sampler_set_save')}>
              <button
                type="button"
                data-testid="sampler-set-save"
                disabled={!selected}
                onClick={(e) => { e.stopPropagation(); void handleSaveIntoSet(); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('sampler_set_save')}
              >
                <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Floppy /></span>
              </button>
            </CustomTooltip>
            <CustomTooltip content={t('sampler_set_rename')}>
              <button
                type="button"
                data-testid="sampler-set-rename"
                disabled={!selected}
                onClick={(e) => { e.stopPropagation(); setMorph({ intent: 'rename', value: selected?.name ?? '' }); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('sampler_set_rename')}
              >
                <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Edit /></span>
              </button>
            </CustomTooltip>
            <CustomTooltip content={t('sampler_set_revert')}>
              <button
                type="button"
                data-testid="sampler-set-revert"
                disabled={!selected}
                onClick={(e) => { e.stopPropagation(); if (selected) applySet(selected); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('sampler_set_revert')}
              >
                <span className="[&_svg]:h-[11px] [&_svg]:w-[11px]"><Icons.Regen /></span>
              </button>
            </CustomTooltip>
            <CustomTooltip content={t('sampler_set_delete')}>
              <button
                type="button"
                data-testid="sampler-set-delete"
                disabled={!selected}
                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(selected?.id ?? null); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-danger disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('sampler_set_delete')}
              >
                <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Trash /></span>
              </button>
            </CustomTooltip>
            <CustomTooltip content={t('sampler_set_import')}>
              <button
                type="button"
                data-testid="sampler-set-import"
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1"
                aria-label={t('sampler_set_import')}
              >
                <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Import /></span>
              </button>
            </CustomTooltip>
            <CustomTooltip content={t('sampler_set_export')}>
              <button
                type="button"
                data-testid="sampler-set-export"
                disabled={!selected}
                onClick={(e) => { e.stopPropagation(); handleExportSet(); }}
                className="flex h-7 w-7 items-center justify-center rounded text-t3 transition-colors hover:bg-[var(--border)] hover:text-t1 disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('sampler_set_export')}
              >
                <span className="[&_svg]:h-[12px] [&_svg]:w-[12px]"><Icons.Download /></span>
              </button>
            </CustomTooltip>
            {/* Hidden file input for the point-import (upload icon). */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleImportFile(file);
              }}
            />
            {/* Toggle switch right in the accordion header */}
            <div
              className={cn("relative ml-1 h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors", form.customSamplers ? "bg-accent" : "bg-s3")}
              onClick={(e) => { e.stopPropagation(); handleToggleCustomSamplers(!form.customSamplers); }}
            >
              <div className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform", form.customSamplers ? "translate-x-[18px]" : "translate-x-0.5")} />
            </div>
          </div>
        </div>

        <AnimatedDisclosure open={advOpen} className="border-t border-border2 bg-surface p-4">
            {/* Two-column sampler grid */}
            <div className={cn("grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4", disabled && "opacity-40 pointer-events-none")}>
              {supports('topP') && (
                <SamplerField
                  label={t("sampler_top_p")}
                  tooltip={t("sampler_top_p_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.topP}
                  onChange={(v) => updateForm('topP', v)}
                  disabled={disabled}
                />
              )}
              {supports('frequencyPenalty') && (
                <SamplerField
                  label={t("sampler_freq_penalty")}
                  tooltip={t("sampler_freq_penalty_hint")}
                  min={-2}
                  max={2}
                  step={0.1}
                  value={form.frequencyPenalty}
                  onChange={(v) => updateForm('frequencyPenalty', v)}
                  disabled={disabled}
                />
              )}
              {supports('topK') && (
                <SamplerField
                  label={t("sampler_top_k")}
                  tooltip={t("sampler_top_k_hint")}
                  min={0}
                  max={100}
                  step={1}
                  isInteger={true}
                  value={form.topK}
                  onChange={(v) => updateForm('topK', v)}
                  disabled={disabled}
                />
              )}
              {supports('presencePenalty') && (
                <SamplerField
                  label={t("sampler_pres_penalty")}
                  tooltip={t("sampler_pres_penalty_hint")}
                  min={-2}
                  max={2}
                  step={0.1}
                  value={form.presencePenalty}
                  onChange={(v) => updateForm('presencePenalty', v)}
                  disabled={disabled}
                />
              )}
              {supports('topA') && (
                <SamplerField
                  label={t("sampler_top_a")}
                  tooltip={t("sampler_top_a_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.topA ?? 0}
                  onChange={(v) => updateForm('topA', v)}
                  disabled={disabled}
                />
              )}
              {supports('repetitionPenalty') && (
                <SamplerField
                  label={t("sampler_rep_penalty")}
                  tooltip={t("sampler_rep_penalty_hint")}
                  min={0}
                  max={2}
                  step={0.05}
                  value={form.repetitionPenalty}
                  onChange={(v) => updateForm('repetitionPenalty', v)}
                  disabled={disabled}
                />
              )}
              {supports('minP') && (
                <SamplerField
                  label={t("sampler_min_p")}
                  tooltip={t("sampler_min_p_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.minP}
                  onChange={(v) => updateForm('minP', v)}
                  disabled={disabled}
                />
              )}
              {supports('typicalP') && (
                <SamplerField
                  label={t("sampler_typical_p")}
                  tooltip={t("sampler_typical_p_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.typicalP}
                  onChange={(v) => updateForm('typicalP', v)}
                  disabled={disabled}
                />
              )}
              {supports('tfsZ') && (
                <SamplerField
                  label={t("sampler_tfs_z")}
                  tooltip={t("sampler_tfs_z_hint")}
                  min={0}
                  max={2}
                  step={0.01}
                  value={form.tfsZ}
                  onChange={(v) => updateForm('tfsZ', v)}
                  disabled={disabled}
                />
              )}
              {supports('adaptiveTarget') && (
                <SamplerField
                  label={t("sampler_adaptive_target")}
                  tooltip={t("sampler_adaptive_target_hint")}
                  min={-1}
                  max={1}
                  step={0.01}
                  value={form.adaptiveTarget}
                  onChange={(v) => updateForm('adaptiveTarget', v)}
                  disabled={disabled}
                />
              )}
              {supports('adaptiveDecay') && (
                <SamplerField
                  label={t("sampler_adaptive_decay")}
                  tooltip={t("sampler_adaptive_decay_hint")}
                  min={0}
                  max={0.99}
                  step={0.01}
                  value={form.adaptiveDecay}
                  onChange={(v) => updateForm('adaptiveDecay', v)}
                  disabled={disabled}
                />
              )}
              {supports('dynatempRange') && (
                <SamplerField
                  label={t("sampler_dynatemp_range")}
                  tooltip={t("sampler_dynatemp_range_hint")}
                  min={0}
                  max={10}
                  step={0.1}
                  value={form.dynatempRange}
                  onChange={(v) => updateForm('dynatempRange', v)}
                  disabled={disabled}
                />
              )}
              {supports('dynatempExponent') && (
                <SamplerField
                  label={t("sampler_dynatemp_exponent")}
                  tooltip={t("sampler_dynatemp_exponent_hint")}
                  min={0}
                  max={2}
                  step={0.05}
                  value={form.dynatempExponent}
                  onChange={(v) => updateForm('dynatempExponent', v)}
                  disabled={disabled}
                />
              )}
              {supports('topNSigma') && (
                <SamplerField
                  label={t("sampler_top_n_sigma")}
                  tooltip={t("sampler_top_n_sigma_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.topNSigma}
                  onChange={(v) => updateForm('topNSigma', v)}
                  disabled={disabled}
                />
              )}
              {supports('smoothingFactor') && (
                <SamplerField
                  label={t("sampler_smoothing_factor")}
                  tooltip={t("sampler_smoothing_factor_hint")}
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={form.smoothingFactor}
                  onChange={(v) => updateForm('smoothingFactor', v)}
                  disabled={disabled}
                />
              )}
              {supports('repeatLastN') && (
                <SamplerField
                  label={t("sampler_repeat_last_n")}
                  tooltip={t("sampler_repeat_last_n_hint")}
                  min={0}
                  max={4096}
                  step={1}
                  isInteger={true}
                  value={form.repeatLastN}
                  onChange={(v) => updateForm('repeatLastN', v)}
                  disabled={disabled}
                />
              )}
              {supports('mirostat') && (
                <SamplerField
                  label={t("sampler_mirostat")}
                  tooltip={t("sampler_mirostat_hint")}
                  min={0}
                  max={2}
                  step={1}
                  isInteger={true}
                  value={form.mirostat}
                  onChange={(v) => updateForm('mirostat', v)}
                  disabled={disabled}
                />
              )}
              {supports('mirostatTau') && (
                <SamplerField
                  label={t("sampler_mirostat_tau")}
                  tooltip={t("sampler_mirostat_tau_hint")}
                  min={0}
                  max={10}
                  step={0.1}
                  value={form.mirostatTau}
                  onChange={(v) => updateForm('mirostatTau', v)}
                  disabled={disabled}
                />
              )}
              {supports('mirostatEta') && (
                <SamplerField
                  label={t("sampler_mirostat_eta")}
                  tooltip={t("sampler_mirostat_eta_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.mirostatEta}
                  onChange={(v) => updateForm('mirostatEta', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryMultiplier') && (
                <SamplerField
                  label={t("sampler_dry_multiplier")}
                  tooltip={t("sampler_dry_multiplier_hint")}
                  min={0}
                  max={5}
                  step={0.05}
                  value={form.dryMultiplier}
                  onChange={(v) => updateForm('dryMultiplier', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryBase') && (
                <SamplerField
                  label={t("sampler_dry_base")}
                  tooltip={t("sampler_dry_base_hint")}
                  min={0}
                  max={4}
                  step={0.05}
                  value={form.dryBase}
                  onChange={(v) => updateForm('dryBase', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryAllowedLength') && (
                <SamplerField
                  label={t("sampler_dry_allowed_length")}
                  tooltip={t("sampler_dry_allowed_length_hint")}
                  min={0}
                  max={32}
                  step={1}
                  isInteger={true}
                  value={form.dryAllowedLength}
                  onChange={(v) => updateForm('dryAllowedLength', v)}
                  disabled={disabled}
                />
              )}
              {supports('dryPenaltyLastN') && (
                <SamplerField
                  label={t("sampler_dry_penalty_last_n")}
                  tooltip={t("sampler_dry_penalty_last_n_hint")}
                  min={-1}
                  max={4096}
                  step={1}
                  isInteger={true}
                  value={form.dryPenaltyLastN}
                  onChange={(v) => updateForm('dryPenaltyLastN', v)}
                  disabled={disabled}
                />
              )}
              {supports('xtcThreshold') && (
                <SamplerField
                  label={t("sampler_xtc_threshold")}
                  tooltip={t("sampler_xtc_threshold_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.xtcThreshold}
                  onChange={(v) => updateForm('xtcThreshold', v)}
                  disabled={disabled}
                />
              )}
              {supports('xtcProbability') && (
                <SamplerField
                  label={t("sampler_xtc_probability")}
                  tooltip={t("sampler_xtc_probability_hint")}
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.xtcProbability}
                  onChange={(v) => updateForm('xtcProbability', v)}
                  disabled={disabled}
                />
              )}
            </div>

            {supports('drySequenceBreakers') && (
              <div className={cn("mt-4", disabled && "opacity-40 pointer-events-none")}>
                <label className="mb-[7px] flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                  <span>{t("sampler_dry_sequence_breakers")}</span>
                  <CustomTooltip content={t("sampler_dry_sequence_breakers_hint")} side="top" align="start">
                    <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border2 bg-s3 text-[10px] font-semibold normal-case tracking-normal text-t3">?</span>
                  </CustomTooltip>
                </label>
                <ChipInput
                  values={form.drySequenceBreakers}
                  onChange={(v) => updateForm('drySequenceBreakers', v)}
                  placeholder={t("sampler_dry_sequence_breakers_placeholder")}
                  disabled={disabled}
                  showPresets={false}
                  tooltip={t("sampler_dry_sequence_breakers_hint")}
                />
              </div>
            )}

            {/* Banned Strings — KoboldCPP antislop phrase banning (B3); same chip-list shape as DRY breakers */}
            {supports('bannedStrings') && (
              <div className={cn("mt-4", disabled && "opacity-40 pointer-events-none")}>
                <label className="mb-[7px] flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                  <span>{t("sampler_banned_strings")}</span>
                  <CustomTooltip content={t("sampler_banned_strings_hint")} side="top" align="start">
                    <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border2 bg-s3 text-[10px] font-semibold normal-case tracking-normal text-t3">?</span>
                  </CustomTooltip>
                </label>
                <ChipInput
                  values={form.bannedStrings}
                  onChange={(v) => updateForm('bannedStrings', v)}
                  placeholder={t("sampler_banned_strings_placeholder")}
                  disabled={disabled}
                  showPresets={false}
                  tooltip={t("sampler_banned_strings_hint")}
                />
              </div>
            )}

            {/* Stop Sequences — full width */}
            {supports('stopSequences') && (
            <div className={cn("mt-4", disabled && "opacity-40 pointer-events-none")}>
              <CustomTooltip content={t("stop_seqs_hint")}>
                <label className="mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">
                  {t("stop_seqs_label")}
                </label>
              </CustomTooltip>
              <ChipInput
                values={form.stopSequences}
                onChange={(v) => updateForm('stopSequences', v)}
                placeholder={t("stop_seqs_placeholder")}
                disabled={disabled}
                showPresets
                presetsLabel={t("special_chars_label")}
                tooltip={t("special_chars_hint")}
              />
            </div>
            )}

            {capabilities?.logitBias && supports('logitBias') && (
              <LogitBiasPanel
                entries={form.logitBias}
                onChange={(v) => updateForm('logitBias', v)}
                disabled={disabled}
                supported
                model={form.model}
              />
            )}
        </AnimatedDisclosure>

        {/* Destructive confirm for set deletion (LS-5 edge case 5): deleting a
            set never touches profiles that already applied it (copy-on-select). */}
        {confirmDeleteId && (
          <DestructiveConfirmModal
            title={t('sampler_set_delete_title')}
            body={t('sampler_set_delete_body', { name: sets.find((s) => s.id === confirmDeleteId)?.name ?? '' })}
            onConfirm={() => { void handleConfirmDelete(); }}
            onCancel={() => setConfirmDeleteId(null)}
          />
        )}
      </div>
    </div>
  );
}
