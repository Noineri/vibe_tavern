import type { AutoTemplateSource, GenerationFormat, NamesBehavior } from "@vibe-tavern/domain";
import { GENERATION_FORMAT_MODE, NAMES_BEHAVIOR } from "@vibe-tavern/domain";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { Icons } from "../../shared/icons.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { Toggle } from "../../shared/Toggle.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { lblCls, monoCls } from "../../build/fields/field-styles.js";

/**
 * Generation-format pane (LOCAL_SUPPORT_PLAN LS-3d): the prompt preset's TC
 * string-shape glue, edited per preset inside the prompt manager's
 * "Generation format" tab.
 *
 * Default view = mode status (auto → where the template comes from; manual →
 * the stored sequences); the manual sequences render FLAT below the mode
 * toggle — GREYED/inert in auto, editable in manual (owner design LS-6c:
 * the toggle owns visibility semantics; the old collapsed accordion wrapper
 * was removed — it looked equally editable in both modes). Visible ALWAYS —
 * without an active TC provider profile the whole pane renders greyed with a
 * hint (owner decision 2026-09-09: discoverability before enabling raw mode).
 */

interface GenerationFormatPaneProps {
  /** False when no preset is selected — the format is a preset field. */
  hasPreset: boolean;
  /** The selected preset's stored format. Null = never configured (= auto). */
  format: GenerationFormat | null;
  onFormatChange: (next: GenerationFormat | null) => void;
  /** Where AUTO takes its template for the ACTIVE provider profile in TC
   *  mode (`resolveAutoTemplateSource`). Null = TC mode is NOT active — the
   *  pane renders greyed with the enable-raw-mode hint. */
  tcTemplateSource: AutoTemplateSource | null;
  /** Opens the ST format import file picker (handled by the modal). */
  onImportClick: () => void;
}

/** Single-line monospace field for one sequence — sequences are template
 *  strings (`<|im_start|>user`, `\n`, …), so they render mono. */
function SequenceField(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className={lblCls}>{props.label}</label>
      <input
        type="text"
        className={cn(monoCls, "h-8 px-2")}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

export function GenerationFormatPane({ hasPreset, format, onFormatChange, tcTemplateSource, onImportClick }: GenerationFormatPaneProps) {
  const { t } = useT();
  const disabled = !hasPreset || tcTemplateSource === null;
  const fmt: GenerationFormat = format ?? { mode: GENERATION_FORMAT_MODE.auto };
  const isManual = fmt.mode === GENERATION_FORMAT_MODE.manual;
  // LS-6c: the manual sequences are INERT while auto is selected — the mode
  // toggle owns the semantics; the fields stay visible (greyed) so switching
  // to manual reveals the same controls in place.
  const manualDisabled = disabled || !isManual;

  const update = (patch: Partial<GenerationFormat>) => {
    onFormatChange({ ...fmt, ...patch });
  };

  const statusKey =
    tcTemplateSource === "backend"
      ? "promptManager.format.statusBackend"
      : tcTemplateSource === "native"
        ? "promptManager.format.statusNative"
        : "promptManager.format.statusDefault";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {!hasPreset && (
        <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("promptManager.format.noPreset")}</div>
      )}

      {tcTemplateSource === null && (
        <div className="rounded-md border border-border2 bg-s2 px-3 py-2.5">
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("promptManager.format.inactiveTitle")}</div>
          <div className="mt-1 font-ui text-[11px] text-t3">{t("promptManager.format.inactiveHint")}</div>
        </div>
      )}

      <div className={cn("flex flex-col gap-5", disabled && "pointer-events-none opacity-40")}>
        {/* Mode + status */}
        <div>
          <div className="mb-[7px] flex items-center justify-between gap-3">
            <label className={cn(lblCls, "!mb-0")}>{t("promptManager.format.mode")}</label>
            <CustomTooltip content={t("promptManager.format.importTooltip")}>
              <button
                type="button"
                onClick={onImportClick}
                disabled={disabled}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-45"
              >
                <span className="[&_svg]:h-[13px] [&_svg]:w-[13px]"><Icons.Import /></span>
                {t("promptManager.format.import")}
              </button>
            </CustomTooltip>
          </div>
          <SegmentedControl<GenerationFormat["mode"]>
            value={fmt.mode}
            options={[
              { value: GENERATION_FORMAT_MODE.auto, label: t("promptManager.format.modeAuto") },
              { value: GENERATION_FORMAT_MODE.manual, label: t("promptManager.format.modeManual") },
            ]}
            onChange={(v) => update({ mode: v })}
            disabled={disabled}
          />
          <div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 italic">
            {fmt.mode === GENERATION_FORMAT_MODE.auto ? t(statusKey) : t("promptManager.format.statusManual")}
          </div>
        </div>

        {/* Manual sequences — FLAT (LS-6c): greyed/inert in auto, editable
            in manual. No accordion wrapper. */}
        <div>
          <div className="mb-1 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("promptManager.format.advancedTitle")}</div>
          <div className={cn("grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4", manualDisabled && "pointer-events-none opacity-40")}>
            <SequenceField label={t("promptManager.format.inputSequence")} value={fmt.inputSequence ?? ""} onChange={(v) => update({ inputSequence: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.outputSequence")} value={fmt.outputSequence ?? ""} onChange={(v) => update({ outputSequence: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.firstOutputSequence")} value={fmt.firstOutputSequence ?? ""} onChange={(v) => update({ firstOutputSequence: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.lastOutputSequence")} value={fmt.lastOutputSequence ?? ""} onChange={(v) => update({ lastOutputSequence: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.systemSequence")} value={fmt.systemSequence ?? ""} onChange={(v) => update({ systemSequence: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.systemSequencePrefix")} value={fmt.systemSequencePrefix ?? ""} onChange={(v) => update({ systemSequencePrefix: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.systemSequenceSuffix")} value={fmt.systemSequenceSuffix ?? ""} onChange={(v) => update({ systemSequenceSuffix: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.inputSuffix")} value={fmt.inputSuffix ?? ""} onChange={(v) => update({ inputSuffix: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.outputSuffix")} value={fmt.outputSuffix ?? ""} onChange={(v) => update({ outputSuffix: v })} disabled={manualDisabled} />
            <SequenceField label={t("promptManager.format.systemSuffix")} value={fmt.systemSuffix ?? ""} onChange={(v) => update({ systemSuffix: v })} disabled={manualDisabled} />

            <div className="flex items-center gap-3">
              <Toggle
                checked={fmt.wrap === true}
                onChange={(v) => update({ wrap: v })}
                disabled={manualDisabled}
                aria-label={t("promptManager.format.wrap")}
              />
              <div>
                <div className="font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-t2">{t("promptManager.format.wrap")}</div>
                <div className="font-ui text-[11px] text-t3">{t("promptManager.format.wrapHint")}</div>
              </div>
            </div>

            <div>
              <label className={lblCls}>{t("promptManager.format.namesBehavior")}</label>
              <SegmentedControl<NamesBehavior>
                value={fmt.namesBehavior ?? NAMES_BEHAVIOR.force}
                options={[
                  { value: NAMES_BEHAVIOR.force, label: t("promptManager.format.namesForce") },
                  { value: NAMES_BEHAVIOR.always, label: t("promptManager.format.namesAlways") },
                  { value: NAMES_BEHAVIOR.never, label: t("promptManager.format.namesNever") },
                ]}
                onChange={(v) => update({ namesBehavior: v })}
                disabled={manualDisabled}
              />
              <div className="mt-1 font-ui text-[11px] text-t3">{t("promptManager.format.namesHint")}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
