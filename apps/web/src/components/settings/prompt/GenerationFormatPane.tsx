import { useEffect, useState } from "react";
import type { AutoTemplateSource, GenerationFormat, NamesBehavior } from "@vibe-tavern/domain";
import { GENERATION_FORMAT_MODE, NAMES_BEHAVIOR } from "@vibe-tavern/domain";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { Icons } from "../../shared/icons.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { Toggle } from "../../shared/Toggle.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { lblCls, monoCls } from "../../build/fields/field-styles.js";

/**
 * Generation-format pane (LOCAL_SUPPORT_PLAN LS-3d): the prompt preset's TC
 * string-shape glue, edited per preset inside the prompt manager's
 * "Generation format" tab.
 *
 * Default view = mode status (auto → where the template comes from; manual →
 * the stored sequences); the manual sequences editor sits in a collapsed
 * advanced accordion (progressive disclosure, same pattern as the sampler
 * panel's advanced accordion). Visible ALWAYS — without an active TC provider
 * profile the whole pane renders greyed with a hint (owner decision
 * 2026-09-09: discoverability before enabling raw mode).
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

  // Advanced manual-sequences accordion (collapsed by default — the status
  // view IS the default view). It opens itself when the preset's stored mode
  // is manual or the user switches to manual.
  const [advOpen, setAdvOpen] = useState(false);
  useEffect(() => {
    if (isManual) setAdvOpen(true);
  }, [isManual]);

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

        {/* Advanced manual sequences — collapsed accordion (sampler-panel pattern) */}
        <div className="overflow-hidden rounded-lg border border-border2">
          <div
            className={cn(
              "flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer",
              advOpen && "!rounded-b-none",
            )}
            onClick={() => setAdvOpen(!advOpen)}
          >
            <span className="flex items-center gap-2">
              <span className={cn("transition-transform", advOpen && "rotate-90")}>
                <Icons.Caret direction="r" />
              </span>
              {t("promptManager.format.advancedTitle")}
            </span>
          </div>
          <AnimatedDisclosure open={advOpen} className="border-t border-border2 bg-surface p-4">
            <div className={cn("grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4", disabled && "pointer-events-none opacity-40")}>
              <SequenceField label={t("promptManager.format.inputSequence")} value={fmt.inputSequence ?? ""} onChange={(v) => update({ inputSequence: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.outputSequence")} value={fmt.outputSequence ?? ""} onChange={(v) => update({ outputSequence: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.firstOutputSequence")} value={fmt.firstOutputSequence ?? ""} onChange={(v) => update({ firstOutputSequence: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.lastOutputSequence")} value={fmt.lastOutputSequence ?? ""} onChange={(v) => update({ lastOutputSequence: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.systemSequence")} value={fmt.systemSequence ?? ""} onChange={(v) => update({ systemSequence: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.systemSequencePrefix")} value={fmt.systemSequencePrefix ?? ""} onChange={(v) => update({ systemSequencePrefix: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.systemSequenceSuffix")} value={fmt.systemSequenceSuffix ?? ""} onChange={(v) => update({ systemSequenceSuffix: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.inputSuffix")} value={fmt.inputSuffix ?? ""} onChange={(v) => update({ inputSuffix: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.outputSuffix")} value={fmt.outputSuffix ?? ""} onChange={(v) => update({ outputSuffix: v })} disabled={disabled} />
              <SequenceField label={t("promptManager.format.systemSuffix")} value={fmt.systemSuffix ?? ""} onChange={(v) => update({ systemSuffix: v })} disabled={disabled} />

              <div className="flex items-center gap-3">
                <Toggle
                  checked={fmt.wrap === true}
                  onChange={(v) => update({ wrap: v })}
                  disabled={disabled}
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
                  disabled={disabled}
                />
                <div className="mt-1 font-ui text-[11px] text-t3">{t("promptManager.format.namesHint")}</div>
              </div>
            </div>
          </AnimatedDisclosure>
        </div>
      </div>
    </div>
  );
}
