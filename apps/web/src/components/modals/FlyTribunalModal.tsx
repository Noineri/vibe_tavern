import { useEffect, useState, type ReactNode } from "react";
import type { FlyPrecedentLifetime, FlyTribunalSettings } from "@vibe-tavern/api-contracts";
import { FLY_HINT_LIST_MAX, FLY_HINT_PLACEHOLDER } from "@vibe-tavern/api-contracts";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { selectFlyGateProgress, useFlyTribunalStore } from "../../stores/fly-tribunal-store.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { Icons } from "../shared/icons.js";
import { Modal } from "../shared/Modal.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { Toggle } from "../shared/Toggle.js";
import { lblCls } from "../../lib/field-tokens.js";
import { useFlyBrain } from "./use-fly-brain.js";

export interface FlyTribunalModalProps {
  open: boolean;
  onClose: () => void;
  onSaveSettings: (settings: FlyTribunalSettings) => Promise<void>;
  onBrainReadyChange?: (ready: boolean) => void;
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-5 py-4 last:border-b-0">
      <h3 className="mb-3 font-ui text-[calc(var(--ui-fs)-2px)] font-semibold text-t1">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function lifetimeValue(value: FlyPrecedentLifetime): "7" | "14" | "30" | "forever" {
  return value === null ? "forever" : String(value) as "7" | "14" | "30";
}

function lifetimeFromValue(value: "7" | "14" | "30" | "forever"): FlyPrecedentLifetime {
  return value === "forever" ? null : Number(value) as 7 | 14 | 30;
}

/** Five-block Fly Tribunal settings modal (FLY_TRIBUNAL_PLAN FT-9). */
export function FlyTribunalModal({ open, onClose, onSaveSettings, onBrainReadyChange }: FlyTribunalModalProps) {
  const { t } = useT();
  const settings = useFlyTribunalStore((state) => state.settings);
  const precedentCount = useFlyTribunalStore((state) => state.precedentCount);
  const gate = selectFlyGateProgress({ precedentCount });
  const resetForAmnesty = useFlyTribunalStore((state) => state.resetForAmnesty);
  const brain = useFlyBrain();
  const [hintDrafts, setHintDrafts] = useState<string[]>(settings.hints);
  const [hintError, setHintError] = useState<string | null>(null);

  useEffect(() => {
    setHintDrafts(settings.hints);
  }, [settings.hints]);

  useEffect(() => {
    onBrainReadyChange?.(brain.state === "ready");
  }, [brain.state, onBrainReadyChange]);

  const save = (next: FlyTribunalSettings): void => {
    void onSaveSettings(next);
  };

  const updateHint = (index: number, value: string): void => {
    const nextDrafts = hintDrafts.map((hint, hintIndex) => hintIndex === index ? value : hint);
    setHintDrafts(nextDrafts);
    if (!value.includes(FLY_HINT_PLACEHOLDER)) {
      setHintError(t("fly_tribunal_hint_placeholder_error", { placeholder: FLY_HINT_PLACEHOLDER }));
      return;
    }
    setHintError(null);
    save({ ...settings, hints: nextDrafts });
  };

  const removeHint = (index: number): void => {
    const next = hintDrafts.filter((_, hintIndex) => hintIndex !== index);
    setHintDrafts(next);
    setHintError(null);
    save({ ...settings, hints: next });
  };

  const addHint = (): void => {
    if (hintDrafts.length >= FLY_HINT_LIST_MAX) return;
    const next = [...hintDrafts, FLY_HINT_PLACEHOLDER];
    setHintDrafts(next);
    setHintError(null);
    save({ ...settings, hints: next });
  };

  const changeScope = (memoryScope: "chat" | "global"): void => {
    if (memoryScope === settings.memoryScope) return;
    save({ ...settings, memoryScope });
    resetForAmnesty();
  };

  const grantAmnesty = (): void => {
    if (!window.confirm(t("fly_tribunal_amnesty_confirm", { gate: gate.gate }))) return;
    resetForAmnesty();
  };

  const reactionOptions = [
    { value: "indication" as const, label: t("fly_tribunal_reaction_indication") },
    { value: "hint" as const, label: t("fly_tribunal_reaction_hint") },
    { value: "auto" as const, label: t("fly_tribunal_reaction_auto") },
  ];
  const capOptions = ["1", "2", "3"].map((value) => ({ value, label: value }));
  const sensitivityOptions = [
    { value: "soft" as const, label: t("fly_tribunal_sensitivity_soft") },
    { value: "normal" as const, label: t("fly_tribunal_sensitivity_normal") },
    { value: "strict" as const, label: t("fly_tribunal_sensitivity_strict") },
  ];
  const confidenceOptions = [
    { value: "normal" as const, label: t("fly_tribunal_confidence_normal") },
    { value: "high" as const, label: t("fly_tribunal_confidence_high") },
    { value: "very-high" as const, label: t("fly_tribunal_confidence_very_high") },
  ];
  const speedOptions = [
    { value: "slow" as const, label: t("fly_tribunal_speed_slow") },
    { value: "normal" as const, label: t("fly_tribunal_speed_normal") },
    { value: "fast" as const, label: t("fly_tribunal_speed_fast") },
  ];
  const lifetimeOptions = [
    { value: "7" as const, label: t("fly_tribunal_lifetime_7") },
    { value: "14" as const, label: t("fly_tribunal_lifetime_14") },
    { value: "30" as const, label: t("fly_tribunal_lifetime_30") },
    { value: "forever" as const, label: t("fly_tribunal_lifetime_forever") },
  ];

  return (
    <Modal open={open} onClose={onClose} title={t("fly_tribunal_title")} description={t("fly_tribunal_subtitle")}>
      <div className="max-h-[calc(100dvh-32px)] w-[min(620px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border2 bg-surface shadow-[0_24px_60px_rgba(0,0,0,.5)]">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-ui text-[calc(var(--ui-fs)+2px)] font-semibold text-t1">{t("fly_tribunal_title")}</h2>
            <p className="mt-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("fly_tribunal_subtitle")}</p>
          </div>
          <button type="button" aria-label={t("close")} className="shrink-0 cursor-pointer text-t3 transition-colors hover:text-t1" onClick={onClose}>
            <Icons.Close />
          </button>
        </div>
        <div className="max-h-[calc(100dvh-150px)] overflow-y-auto">
          <SettingsSection title={t("fly_tribunal_brain_title")}>
            {brain.state === "ready" && brain.manifest !== null && (
              <div className="flex flex-col gap-1 font-ui text-[calc(var(--ui-fs)-2px)] text-t2" data-testid="fly-brain-ready">
                <span className="flex items-center gap-1.5 text-t1"><Icons.Check />{t("fly_tribunal_brain_ready")}</span>
                <span>{t("fly_tribunal_brain_version", { version: brain.manifest.source.version })}</span>
                <span>{t("fly_tribunal_brain_size", { mb: Math.round(brain.manifest.binary.sizeBytes / 1048576) })}</span>
              </div>
            )}
            {brain.state === "downloading" && (
              <div className="flex flex-col gap-1.5" data-testid="fly-brain-downloading">
                <div className="flex justify-between gap-3 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
                  <span>{t("fly_tribunal_brain_downloading")}</span>
                  <span className="tabular-nums">{brain.pct ?? 0}%{brain.receivedMb !== null && brain.totalMb !== null ? ` · ${brain.receivedMb} / ${brain.totalMb} MB` : ""}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-s3"><div className="h-full bg-accent transition-all" style={{ width: `${brain.pct ?? 0}%` }} /></div>
              </div>
            )}
            {brain.state === "error" && <p className="font-ui text-[calc(var(--ui-fs)-2px)] text-danger">{brain.error}</p>}
            {brain.state === "idle" && <p className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("fly_tribunal_brain_idle")}</p>}
            <div className="flex flex-wrap gap-2">
              {brain.state !== "downloading" && <button type="button" className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={brain.download}><Icons.Download />{t(brain.state === "ready" ? "fly_tribunal_brain_update" : "fly_tribunal_brain_download")}</button>}
              {brain.state === "ready" && <button type="button" className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={brain.remove}><Icons.Trash />{t("fly_tribunal_brain_delete")}</button>}
            </div>
            <p className="font-ui text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t4">{t("fly_tribunal_brain_attribution")}</p>
          </SettingsSection>

          <SettingsSection title={t("fly_tribunal_reaction_title")}>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2"><label className={cn(lblCls, "!mb-0")}>{t("fly_tribunal_reaction_level")}</label><span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3" data-testid="fly-tribunal-gate-counter">{t("fly_tribunal_precedents_counter", { current: gate.current, gate: gate.gate })}</span></div>
              <SegmentedControl value={settings.reactionTier} options={reactionOptions} onChange={(reactionTier) => save({ ...settings, reactionTier })} disabled={!gate.unlocked} ariaLabel={t("fly_tribunal_reaction_level")} wrap mobileFill mobileSelect />
              {!gate.unlocked && <p className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("fly_tribunal_reaction_locked", { gate: gate.gate })}</p>}
            </div>
            <div><label className={lblCls}>{t("fly_tribunal_regen_cap")}</label><SegmentedControl value={String(settings.regenCap)} options={capOptions} onChange={(value) => save({ ...settings, regenCap: Number(value) as 1 | 2 | 3 })} ariaLabel={t("fly_tribunal_regen_cap")} compact /></div>
            <div><label className={lblCls}>{t("fly_tribunal_sensitivity")}</label><SegmentedControl value={settings.sensitivity} options={sensitivityOptions} onChange={(sensitivity) => save({ ...settings, sensitivity })} ariaLabel={t("fly_tribunal_sensitivity")} wrap mobileFill mobileSelect /></div>
            {settings.reactionTier === "auto" && <div data-testid="fly-tribunal-auto-confidence"><label className={lblCls}>{t("fly_tribunal_auto_confidence")}</label><SegmentedControl value={settings.autoSwipeConfidence} options={confidenceOptions} onChange={(autoSwipeConfidence) => save({ ...settings, autoSwipeConfidence })} ariaLabel={t("fly_tribunal_auto_confidence")} wrap mobileFill mobileSelect /></div>}
          </SettingsSection>

          <SettingsSection title={t("fly_tribunal_training_title")}>
            <div className="flex items-center justify-between gap-3"><div><p className="font-ui text-[calc(var(--ui-fs)-2px)] text-t1">{t("fly_tribunal_training_enabled")}</p><p className="mt-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("fly_tribunal_training_enabled_hint")}</p></div><Toggle checked={settings.trainingEnabled} onChange={(trainingEnabled) => save({ ...settings, trainingEnabled })} aria-label={t("fly_tribunal_training_enabled")} /></div>
            <div><label className={lblCls}>{t("fly_tribunal_training_speed")}</label><SegmentedControl value={settings.trainingSpeed} options={speedOptions} onChange={(trainingSpeed) => save({ ...settings, trainingSpeed })} ariaLabel={t("fly_tribunal_training_speed")} wrap mobileFill mobileSelect /></div>
            <div><label className={lblCls}>{t("fly_tribunal_lifetime")}</label><SegmentedControl value={lifetimeValue(settings.precedentLifetimeDays)} options={lifetimeOptions} onChange={(value) => save({ ...settings, precedentLifetimeDays: lifetimeFromValue(value) })} ariaLabel={t("fly_tribunal_lifetime")} wrap mobileFill mobileSelect /></div>
          </SettingsSection>

          <SettingsSection title={t("fly_tribunal_hint_title")}>
            <p className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{t("fly_tribunal_hint_hint", { placeholder: FLY_HINT_PLACEHOLDER })}</p>
            {hintDrafts.map((hint, index) => <div key={index} className="flex items-start gap-2"><AutoTextarea value={hint} onChange={(event) => updateHint(index, event.target.value)} aria-label={t("fly_tribunal_hint_template", { index: index + 1 })} minRows={2} maxRows={5} className="min-w-0 flex-1" /><button type="button" aria-label={t("fly_tribunal_hint_remove", { index: index + 1 })} className="mt-1 shrink-0 cursor-pointer text-t3 transition-colors hover:text-danger" onClick={() => removeHint(index)}><Icons.Trash /></button></div>)}
            {hintError && <p className="font-ui text-[calc(var(--ui-fs)-3px)] text-danger" role="alert">{hintError}</p>}
            <button type="button" className="flex h-7 w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40" disabled={hintDrafts.length >= FLY_HINT_LIST_MAX} onClick={addHint}><Icons.Plus />{t("fly_tribunal_hint_add")}</button>
          </SettingsSection>

          <SettingsSection title={t("fly_tribunal_memory_title")}>
            <div><label className={lblCls}>{t("fly_tribunal_memory_scope")}</label><SegmentedControl value={settings.memoryScope} options={[{ value: "chat" as const, label: t("fly_tribunal_memory_chat") }, { value: "global" as const, label: t("fly_tribunal_memory_global") }]} onChange={changeScope} ariaLabel={t("fly_tribunal_memory_scope")} mobileFill /></div>
            <p className="font-ui text-[calc(var(--ui-fs)-3px)] leading-relaxed text-t3">{t("fly_tribunal_memory_scope_hint")}</p>
            <button type="button" className="flex h-7 w-fit cursor-pointer items-center gap-1.5 rounded-md border border-danger/50 bg-transparent px-2.5 font-ui text-[11px] text-danger transition-all hover:bg-danger/10" onClick={grantAmnesty}><Icons.Trash />{t("fly_tribunal_amnesty")}</button>
          </SettingsSection>
        </div>
      </div>
    </Modal>
  );
}
