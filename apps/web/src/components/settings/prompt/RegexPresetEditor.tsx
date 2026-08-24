import { useEffect, useMemo, useState } from "react";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { Icons } from "../../shared/icons.js";
import { inputCls, monoCls, lblCls } from "../../build/fields/field-styles.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { getRegexLinks, setRegexLinks } from "../../../api/regex-api.js";
import { invalidateActiveRegexPresets } from "../../../hooks/use-active-regex-presets.js";
import { listPromptPresets } from "../../../api/preset-api.js";
import { compileRegexScript, parseFindRegex } from "@vibe-tavern/prompt-pipeline";
import { applyTargetFlags, regexApplyTargetOf, brandId, REGEX_PLACEMENT, type RegexApplyTarget, type RegexPlacement, type RegexPreset, type RegexSubstituteMode } from "@vibe-tavern/domain";
import type { RegexPresetRecord } from "../../../api/types.js";
import type Resources from "../../../i18n/resources.js";

/** A statically-known i18n key — the option tables below carry these so
 *  `t()` calls stay compile-checked (no `tDynamic` escape hatch needed). */
type I18nKey = keyof Resources["en"];

export interface RegexPresetDraft {
  name: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string;
  substituteRegex: RegexSubstituteMode;
  placement: RegexPlacement[];
  minDepth: string;
  maxDepth: string;
  isGlobal: boolean;
  disabled: boolean;
  applyTarget: RegexApplyTarget;
}

export function regexDraftFromRecord(p: RegexPresetRecord): RegexPresetDraft {
  return {
    name: p.name,
    findRegex: p.findRegex,
    replaceString: p.replaceString,
    trimStrings: p.trimStrings.join("\n"),
    substituteRegex: p.substituteRegex as RegexSubstituteMode,
    placement: [...p.placement] as RegexPlacement[],
    minDepth: p.minDepth === null ? "" : String(p.minDepth),
    maxDepth: p.maxDepth === null ? "" : String(p.maxDepth),
    isGlobal: p.isGlobal,
    disabled: p.disabled,
    applyTarget: regexApplyTargetOf(p),
  };
}

export function emptyRegexDraft(): RegexPresetDraft {
  return {
    name: "",
    findRegex: "",
    replaceString: "",
    trimStrings: "",
    substituteRegex: 0,
    placement: [REGEX_PLACEMENT.AiOutput],
    minDepth: "",
    maxDepth: "",
    isGlobal: false,
    disabled: false,
    applyTarget: "persist",
  };
}

interface RegexPresetEditorProps {
  /** The saved preset being edited, or null for a new preset. */
  preset: RegexPresetRecord | null;
  draft: RegexPresetDraft;
  onDraftChange: (draft: RegexPresetDraft) => void;
}

const PLACEMENT_OPTIONS: Array<{ code: RegexPlacement; labelKey: I18nKey }> = [
  { code: REGEX_PLACEMENT.UserInput, labelKey: "promptManager.regex.placementUserInput" },
  { code: REGEX_PLACEMENT.AiOutput, labelKey: "promptManager.regex.placementAiOutput" },
  { code: REGEX_PLACEMENT.WorldInfo, labelKey: "promptManager.regex.placementWorldInfo" },
  { code: REGEX_PLACEMENT.Reasoning, labelKey: "promptManager.regex.placementReasoning" },
];

const APPLY_TARGETS: Array<{ value: RegexApplyTarget; labelKey: I18nKey; hintKey: I18nKey }> = [
  { value: "persist", labelKey: "promptManager.regex.applyPersist", hintKey: "promptManager.regex.applyPersistHint" },
  { value: "display", labelKey: "promptManager.regex.applyDisplay", hintKey: "promptManager.regex.applyDisplayHint" },
  { value: "prompt", labelKey: "promptManager.regex.applyPrompt", hintKey: "promptManager.regex.applyPromptHint" },
  { value: "display_prompt", labelKey: "promptManager.regex.applyDisplayPrompt", hintKey: "promptManager.regex.applyDisplayPromptHint" },
];

const SUBSTITUTE_OPTIONS: Array<{ value: RegexSubstituteMode; labelKey: I18nKey }> = [
  { value: 0, labelKey: "promptManager.regex.substituteNone" },
  { value: 1, labelKey: "promptManager.regex.substituteRaw" },
  { value: 2, labelKey: "promptManager.regex.substituteEscaped" },
];

/**
 * Detail editor for one regex preset — grouped fields (name / find / replace /
 * trim / substitute / placement / depth / global / disabled / apply-target) plus
 * a live test pane that runs the pure regex engine client-side.
 */
export function RegexPresetEditor({ preset, draft, onDraftChange }: RegexPresetEditorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [testInput, setTestInput] = useState("");

  // ── Bindings (RX-12) ──
  // Forward-direction binding: this preset → characters + prompt presets.
  // Characters come from the same snapshot-store hook LorebookEditor uses;
  // prompt presets load lazily via the API (the editor is only mounted inside
  // the Prompt Manager, so a per-open fetch is cheap). Links are loaded for
  // the SELECTED (already saved) preset; a new unsaved preset shows no
  // bindings section — there is nothing to bind until it exists.
  const allCharacters = useAllCharacters();
  const [bindLinks, setBindLinks] = useState<Array<{ targetType: "character" | "preset"; targetId: string }>>([]);
  const [promptPresets, setPromptPresets] = useState<Array<{ id: string; name: string }>>([]);
  const presetId = preset?.id ?? null;

  useEffect(() => {
    setBindLinks([]);
    if (!presetId) return;
    let cancelled = false;
    // Load failures degrade to an empty binding row (non-blocking) — the user
    // can retry by reselecting the preset.
    getRegexLinks(presetId)
      .then((rows) => { if (!cancelled) setBindLinks(rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId }))); })
      .catch(() => { if (!cancelled) setBindLinks([]); });
    listPromptPresets()
      .then((list) => { if (!cancelled) setPromptPresets(list.map((p) => ({ id: p.id, name: p.name }))); })
      .catch(() => { if (!cancelled) setPromptPresets([]); });
    return () => { cancelled = true; };
  }, [presetId]);

  const characterTargets: LinkTarget[] = useMemo(
    () =>
      allCharacters.map((c) => ({
        id: c.id,
        name: c.name,
        avatarAssetId: c.avatarAssetId,
        kind: "characters" as const,
        avatarExt: c.avatarExt,
        avatarFullExt: c.avatarFullExt,
        avatarFullAssetId: c.avatarFullAssetId,
        updatedAt: c.updatedAt,
      })),
    [allCharacters],
  );
  const presetTargets: LinkTarget[] = useMemo(
    () => promptPresets.map((p) => ({ id: p.id, name: p.name, avatarAssetId: null })),
    [promptPresets],
  );

  const handleSetBindLinks = (next: LinkBindingRecord[]) => {
    if (!presetId) return;
    // The popover's union is wider than this endpoint accepts; this editor
    // only offers character/preset sections, so the guard narrows, never drops.
    const narrowed = next.filter(
      (l): l is { targetType: "character" | "preset"; targetId: string } =>
        l.targetType === "character" || l.targetType === "preset",
    );
    const prev = bindLinks;
    setBindLinks(narrowed); // optimistic
    setRegexLinks(presetId, narrowed)
      .then(() => invalidateActiveRegexPresets())
      .catch(() => setBindLinks(prev)); // revert on failure
  };

  const update = <K extends keyof RegexPresetDraft>(key: K, value: RegexPresetDraft[K]) => {
    onDraftChange({ ...draft, [key]: value });
  };

  const togglePlacement = (code: RegexPlacement) => {
    const next = draft.placement.includes(code)
      ? draft.placement.filter((c) => c !== code)
      : [...draft.placement, code].sort((a, b) => a - b);
    update("placement", next);
  };

  // Live test: compile the DRAFT's find/replace against the sample text.
  // A broken pattern shows inline instead of throwing.
  const testResult = useMemo(() => {
    if (!draft.findRegex.trim()) return { kind: "idle" as const, output: "" };
    const parseable = parseFindRegex(draft.findRegex);
    try {
      // Validate compilation eagerly so invalid patterns surface here.
      new RegExp(parseable.pattern, parseable.flags);
    } catch (err) {
      return { kind: "error" as const, output: err instanceof Error ? err.message : String(err) };
    }
    if (!testInput) return { kind: "idle" as const, output: "" };
    // compileRegexScript expects the domain RegexPreset shape; build a
    // minimal one from the draft — the engine reads only the fields it
    // transforms. The id is a dummy branded value for the client-side test.
    const flags = applyTargetFlags(draft.applyTarget);
    const testPreset: RegexPreset = {
      id: brandId("test"),
      name: draft.name,
      findRegex: draft.findRegex,
      replaceString: draft.replaceString,
      trimStrings: draft.trimStrings.split("\n").filter((s) => s.length > 0),
      substituteRegex: draft.substituteRegex,
      disabled: false,
      markdownOnly: flags.markdownOnly,
      promptOnly: flags.promptOnly,
      runOnEdit: true,
      minDepth: null,
      maxDepth: null,
      placement: draft.placement,
      isGlobal: draft.isGlobal,
      sortOrder: 0,
      createdAt: "",
      updatedAt: "",
    };
    const compiled = compileRegexScript(testPreset);
    if (!compiled) return { kind: "error" as const, output: t("promptManager.regex.testInvalidPattern") };
    return { kind: "ok" as const, output: compiled.run(testInput) };
  }, [draft, testInput, t]);

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Name */}
      <div>
        <label className={lblCls} htmlFor="regex-name">{t("promptManager.regex.fieldName")}</label>
        <input
          id="regex-name"
          type="text"
          className={inputCls}
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder={t("promptManager.regex.namePlaceholder")}
        />
      </div>

      {/* Find regex */}
      <div>
        <label className={lblCls} htmlFor="regex-find">{t("promptManager.regex.fieldFind")}</label>
        <AutoTextarea
          id="regex-find"
          className={monoCls}
          value={draft.findRegex}
          onChange={(e) => update("findRegex", e.target.value)}
          placeholder={t("promptManager.regex.findPlaceholder")}
          minRows={2}
          maxRows={6}
        />
        <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.findHint")}</div>
      </div>

      {/* Replace */}
      <div>
        <label className={lblCls} htmlFor="regex-replace">{t("promptManager.regex.fieldReplace")}</label>
        <AutoTextarea
          id="regex-replace"
          className={monoCls}
          value={draft.replaceString}
          onChange={(e) => update("replaceString", e.target.value)}
          placeholder={t("promptManager.regex.replacePlaceholder")}
          minRows={2}
          maxRows={6}
        />
        <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.replaceHint")}</div>
      </div>

      {/* Trim strings */}
      <div>
        <label className={lblCls} htmlFor="regex-trim">{t("promptManager.regex.fieldTrim")}</label>
        <AutoTextarea
          id="regex-trim"
          className={monoCls}
          value={draft.trimStrings}
          onChange={(e) => update("trimStrings", e.target.value)}
          placeholder={t("promptManager.regex.trimPlaceholder")}
          minRows={1}
          maxRows={4}
        />
        <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.trimHint")}</div>
      </div>

      {/* Substitute macros */}
      <div>
        <label className={lblCls} htmlFor="regex-substitute">{t("promptManager.regex.fieldSubstitute")}</label>
        <select
          id="regex-substitute"
          className={inputCls}
          value={draft.substituteRegex}
          onChange={(e) => update("substituteRegex", Number(e.target.value) as RegexSubstituteMode)}
        >
          {SUBSTITUTE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
          ))}
        </select>
      </div>

      {/* Placement */}
      <div>
        <div className={lblCls}>{t("promptManager.regex.fieldPlacement")}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {PLACEMENT_OPTIONS.map((o) => (
            <Checkbox
              key={o.code}
              id={`regex-placement-${o.code}`}
              checked={draft.placement.includes(o.code)}
              onChange={() => togglePlacement(o.code)}
              label={t(o.labelKey)}
            />
          ))}
        </div>
      </div>

      {/* Depth */}
      <div className="flex gap-4">
        <div className="flex-1">
          <label className={lblCls} htmlFor="regex-min-depth">{t("promptManager.regex.fieldMinDepth")}</label>
          <input
            id="regex-min-depth"
            type="number"
            className={inputCls}
            value={draft.minDepth}
            onChange={(e) => update("minDepth", e.target.value)}
            placeholder={t("promptManager.regex.depthUnlimited")}
            min={0}
          />
        </div>
        <div className="flex-1">
          <label className={lblCls} htmlFor="regex-max-depth">{t("promptManager.regex.fieldMaxDepth")}</label>
          <input
            id="regex-max-depth"
            type="number"
            className={inputCls}
            value={draft.maxDepth}
            onChange={(e) => update("maxDepth", e.target.value)}
            placeholder={t("promptManager.regex.depthUnlimited")}
            min={0}
          />
        </div>
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox
          id="regex-global"
          checked={draft.isGlobal}
          onChange={(v) => update("isGlobal", v)}
          label={t("promptManager.regex.fieldGlobal")}
        />
        <Checkbox
          id="regex-disabled"
          checked={draft.disabled}
          onChange={(v) => update("disabled", v)}
          label={t("promptManager.regex.fieldDisabled")}
        />
      </div>

      {/* Apply-target (write-mode) */}
      <div>
        <div className={lblCls}>{t("promptManager.regex.fieldApplyTarget")}</div>
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t("promptManager.regex.fieldApplyTarget")}>
          {APPLY_TARGETS.map((a) => (
            <CustomTooltip key={a.value} content={t(a.hintKey)}>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="regex-apply-target"
                  value={a.value}
                  checked={draft.applyTarget === a.value}
                  onChange={() => update("applyTarget", a.value)}
                  className="accent-accent"
                />
                <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t1">{t(a.labelKey)}</span>
              </label>
            </CustomTooltip>
          ))}
        </div>
      </div>

      {/* Bindings (RX-12) — bind this preset to characters + prompt presets */}
      {presetId && (
        <div>
          <div className={lblCls}>{t("promptManager.regex.bindingsLabel")}</div>
          <LinkBindingPopover
            links={bindLinks}
            characters={characterTargets}
            personas={[]}
            presets={presetTargets}
            onSetLinks={handleSetBindLinks}
            t={t}
            isMobile={isMobile}
            tooltipLabel={t("promptManager.regex.bindingsAdd")}
            emptyLabel={t("promptManager.regex.bindingsEmpty")}
            characterSectionLabel={t("promptManager.regex.sectionCharacters")}
            presetSectionLabel={t("promptManager.regex.sectionPresets")}
          />
        </div>
      )}

      {/* Live test pane */}
      <div className="rounded-md border border-border2 p-3">
        <div className={cn(lblCls, "mb-2")}>
          {t("promptManager.regex.testTitle")}
        </div>
        <AutoTextarea
          className={monoCls}
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder={t("promptManager.regex.testInputPlaceholder")}
          minRows={2}
          maxRows={6}
        />
        <div className="mt-2">
          <div className="font-ui text-[11px] text-t4">{t("promptManager.regex.testOutputLabel")}</div>
          {testResult.kind === "error" ? (
            <div className="mt-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 font-mono text-xs text-danger">
              {testResult.output}
            </div>
          ) : (
            <div className="mt-1 rounded-md border border-border bg-s3 px-2 py-1.5 font-mono text-xs text-t1 whitespace-pre-wrap min-h-[2em]">
              {testResult.output || <span className="text-t4">{t("promptManager.regex.testOutputEmpty")}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
