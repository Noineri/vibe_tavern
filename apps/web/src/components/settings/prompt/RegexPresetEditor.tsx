import { useEffect, useMemo, useState } from "react";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { Toggle } from "../../shared/Toggle.js";
import { ToggleChips } from "../../shared/ToggleChips.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { inputCls, monoUICls, lblCls } from "../../build/fields/field-styles.js";
import { LinkBindingPopover, type LinkBindingRecord, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { useMacroContext } from "../../../stores/chat-selectors.js";
import { getRegexLinks, setRegexLinks } from "../../../api/regex-api.js";
import { invalidateActiveRegexPresets } from "../../../hooks/use-active-regex-presets.js";
import { listPromptPresets } from "../../../api/preset-api.js";
import { compileRegexScript, parseFindRegex, createValueEscapingMacroSource } from "@vibe-tavern/prompt-pipeline";
import { replaceUiMacros } from "../../../lib/macros.js";
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
  /** Instant active-toggle for a SAVED preset (R-7): the parent patches ONLY
   *  `disabled` on the server immediately (never blocked by a dirty draft) and
   *  syncs list + draft. Without a preset the toggle edits the draft alone. */
  onActiveChange?: (nextActive: boolean) => void;
  /** Notify the parent that this preset's binding count changed (R-7 list
   *  badge: «Не применяется» needs to know non-global presets with zero
   *  links). Called after the links PUT resolves. */
  onLinksChanged?: (presetId: string, linkCount: number) => void;
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

const SCOPE_OPTIONS: Array<{ value: "all" | "bind"; labelKey: I18nKey }> = [
  { value: "all", labelKey: "promptManager.regex.scopeAll" },
  { value: "bind", labelKey: "promptManager.regex.scopeBind" },
];

/** Depth modes (R-7): four shapes over the same minDepth/maxDepth pair —
 *  one-sided imported ranges must survive round-trips un-normalized, so the
 *  mode is always INFERRED from the pair, never stored separately. */
type DepthMode = "all" | "recent" | "older" | "range";
const DEPTH_MODES: Array<{ value: DepthMode; labelKey: I18nKey }> = [
  { value: "all", labelKey: "promptManager.regex.depthModeAll" },
  { value: "recent", labelKey: "promptManager.regex.depthModeRecent" },
  { value: "older", labelKey: "promptManager.regex.depthModeOlder" },
  { value: "range", labelKey: "promptManager.regex.depthModeRange" },
];
/** Owner-pinned default for «Последние N» (and the single-N modes generally):
 *  ST's convention — the last 4 messages. */
const DEPTH_DEFAULT_N = "4";

function depthModeOf(draft: RegexPresetDraft): DepthMode {
  const hasMin = draft.minDepth.trim() !== "";
  const hasMax = draft.maxDepth.trim() !== "";
  if (!hasMin && !hasMax) return "all";
  if (!hasMin && hasMax) return "recent";
  if (hasMin && !hasMax) return "older";
  return "range";
}

/** Message placements — the only hooks depth filters (WorldInfo fires during
 *  prompt assembly, Reasoning is depth-0 by construction). */
const MESSAGE_PLACEMENTS: RegexPlacement[] = [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput];

/**
 * Detail editor for one regex preset (R-7 owner-approved layout, top→down):
 * name + «Активен» instant toggle → «Применение» scope + bindings →
 * «Как срабатывает» (placement chips, 4-mode depth, apply-target) → rule
 * fields (mono at input size) → live test pane with macro substitution,
 * no-match/empty distinction and an honesty disclaimer.
 */
export function RegexPresetEditor({ preset, draft, onDraftChange, onActiveChange, onLinksChanged }: RegexPresetEditorProps) {
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
  const macroContext = useMacroContext();
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

  // Links whose target row no longer exists (pre-R-10 deletions left those in
  // the owner's DB). They render as ghost pills in the popover and do NOT
  // count as "bound" for the dead-zone warning — a preset bound only to dead
  // targets applies nowhere.
  const resolvableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of characterTargets) ids.add(c.id);
    for (const p of presetTargets) ids.add(p.id);
    return ids;
  }, [characterTargets, presetTargets]);
  const effectiveBindCount = useMemo(
    () => bindLinks.filter((l) => resolvableIds.has(l.targetId)).length,
    [bindLinks, resolvableIds],
  );

  // «Не применяется» (R-7 owner follow-up): enabled + bind mode + zero
  // resolvable links — the list's red dot spelled out under the name.
  // Mirrors the bindings dead-zone condition exactly.
  const notApplied = presetId !== null && !draft.isGlobal && !draft.disabled && effectiveBindCount === 0;

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
      .then((rows) => {
        invalidateActiveRegexPresets();
        onLinksChanged?.(presetId, rows.length);
      })
      .catch(() => setBindLinks(prev)); // revert on failure
  };

  const update = <K extends keyof RegexPresetDraft>(key: K, value: RegexPresetDraft[K]) => {
    onDraftChange({ ...draft, [key]: value });
  };

  /** Активен toggle (R-7): for a saved preset the parent patches ONLY
   *  `disabled` on the server right away — a dirty draft never blocks it and
   *  the unsaved-changes indicator keeps carrying the draft≠saved story.
   *  Without a preset record (defensive; the modal only mounts the editor for
   *  saved presets) it edits the draft, activating on first Save. */
  const handleActiveToggle = (nextActive: boolean) => {
    if (preset) {
      onActiveChange?.(nextActive);
      return;
    }
    update("disabled", !nextActive);
  };

  const togglePlacement = (code: RegexPlacement) => {
    const next = draft.placement.includes(code)
      ? draft.placement.filter((c) => c !== code)
      : [...draft.placement, code].sort((a, b) => a - b);
    update("placement", next);
  };

  const applyDepthMode = (mode: DepthMode) => {
    if (mode === depthModeOf(draft)) return;
    switch (mode) {
      case "all":
        onDraftChange({ ...draft, minDepth: "", maxDepth: "" });
        break;
      // «Последние N»: max=N (default 4, owner-pinned); min unbounded.
      case "recent":
        onDraftChange({ ...draft, minDepth: "", maxDepth: draft.maxDepth.trim() === "" ? DEPTH_DEFAULT_N : draft.maxDepth });
        break;
      // «Старше N»: min=N, max unbounded — one-sided, must NOT normalize.
      case "older":
        onDraftChange({ ...draft, minDepth: draft.minDepth.trim() === "" ? DEPTH_DEFAULT_N : draft.minDepth, maxDepth: "" });
        break;
      case "range":
        onDraftChange({
          ...draft,
          minDepth: draft.minDepth.trim() === "" ? "1" : draft.minDepth,
          maxDepth: draft.maxDepth.trim() === "" ? DEPTH_DEFAULT_N : draft.maxDepth,
        });
        break;
    }
  };

  const depthMode = depthModeOf(draft);
  const depthUsed = draft.placement.some((p) => MESSAGE_PLACEMENTS.includes(p));

  // Macro seam (R-7 test pane): bind the same UI macro expansion the chat
  // surface uses, so substituteRegex RAW/ESCAPED modes test truthfully against
  // the ACTIVE character/persona. Without an active chat there is no context —
  // every mode behaves as NONE (engine's standalone default).
  const macroSource = useMemo(
    () => (macroContext ? createValueEscapingMacroSource((text) => replaceUiMacros(text, macroContext)) : undefined),
    [macroContext],
  );

  // Live test: compile the DRAFT's find/replace against the sample text.
  // A broken pattern shows inline instead of throwing.
  const testResult = useMemo(() => {
    if (!draft.findRegex.trim()) return { kind: "idle" as const, output: "" };
    const parseable = parseFindRegex(draft.findRegex);
    // Resolve macros exactly as the engine will, so the match check and the
    // expanded-pattern preview agree with the actual substitution.
    let pattern = parseable.pattern;
    if (macroSource && draft.substituteRegex === 1) pattern = macroSource.resolve(pattern);
    else if (macroSource && draft.substituteRegex === 2) pattern = macroSource.resolveEscaped(pattern);
    try {
      // Validate compilation eagerly so invalid patterns surface here.
      new RegExp(pattern, parseable.flags);
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
    const compiled = compileRegexScript(testPreset, macroSource);
    if (!compiled) return { kind: "error" as const, output: t("promptManager.regex.testInvalidPattern") };
    const output = compiled.run(testInput);
    try {
      const hasMatch = new RegExp(pattern, parseable.flags).test(testInput);
      if (!hasMatch) return { kind: "noMatch" as const, output };
    } catch {
      // Some flag combinations (e.g. /g lastIndex carry-over) can throw on
      // reuse — fall through to the plain output below.
    }
    return { kind: "ok" as const, output, unchanged: output === testInput };
  }, [draft, testInput, macroSource, t]);

  // Macro preview: show the expanded find pattern when substitution is live
  // and the pattern actually carries macro tokens.
  const macroPreview = useMemo(() => {
    if (!macroSource || draft.substituteRegex === 0) return null;
    const parseable = parseFindRegex(draft.findRegex);
    if (!/\{\{[^{}]+\}\}/.test(parseable.pattern)) return null;
    return draft.substituteRegex === 2 ? macroSource.resolveEscaped(parseable.pattern) : macroSource.resolve(parseable.pattern);
  }, [macroSource, draft.substituteRegex, draft.findRegex]);

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Name + Активен (R-7): the toggle is positive-polarity and, for a
          saved preset, applies instantly — see handleActiveToggle. */}
      <div className="flex items-end gap-4">
        <div className="min-w-0 flex-1">
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
        <div className="flex shrink-0 items-center gap-2 pb-[7px]">
          <Toggle
            id="regex-active"
            checked={!draft.disabled}
            onChange={handleActiveToggle}
          />
          <label htmlFor="regex-active" className="cursor-pointer font-ui text-[calc(var(--ui-fs)-1px)] text-t2 select-none">
            {t("promptManager.regex.fieldActive")}
          </label>
        </div>
      </div>
      {/* Badge lives OUTSIDE the name/toggle row: inside it, its height
          pushes the items-end-aligned Toggle down (owner report). Full-width
          row below keeps the Toggle level with the name input. */}
      {notApplied && (
        <div className="-mt-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2 py-px font-ui text-[calc(var(--ui-fs)-4px)] leading-tight text-danger-text select-none">
            <span className="h-[6px] w-[6px] rounded-full bg-danger" />
            {t("promptManager.regex.badgeNotApplied")}
          </span>
        </div>
      )}

      {/* Применение (R-7): «Все чаты» (isGlobal) / «Привязать к» + bindings.
          Scope BEFORE rule fields — owner's section order. */}
      <div>
        <div className={lblCls}>{t("promptManager.regex.scopeLabel")}</div>
        <SegmentedControl
          value={draft.isGlobal ? "all" : "bind"}
          onChange={(v) => update("isGlobal", v === "all")}
          wrap
          mobileFill
          options={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />
      </div>

      {/* Bindings (RX-12) — bind this preset to characters + prompt presets.
          Shown only in «Привязать к» mode; the dead-zone warning IS the
          bindings empty-state (R-7): a bind-mode preset with zero resolvable
          targets applies in no chat. */}
      {presetId && !draft.isGlobal && (
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
          {effectiveBindCount === 0 && (
            <div className="mt-1.5 font-ui text-[11px] text-warning">
              {t("promptManager.regex.bindingsDeadZone")}
            </div>
          )}
        </div>
      )}

      {/* Как срабатывает (R-7): placement chips → depth modes → apply-target. */}
      <div>
        <div className={lblCls}>{t("promptManager.regex.behaviorLabel")}</div>
        <div className="flex flex-col gap-4">
          <ToggleChips
            selected={draft.placement.map(String)}
            options={PLACEMENT_OPTIONS.map((o) => ({ value: String(o.code), label: t(o.labelKey) }))}
            onChange={(next) =>
              update(
                "placement",
                next.map((v) => Number(v) as RegexPlacement).sort((a, b) => a - b),
              )
            }
          />

          {/* Depth: 4 modes over minDepth/maxDepth; hidden with a note when
              no message placements are selected (depth filters messages only). */}
          {depthUsed ? (
            <div>
              <SegmentedControl
                value={depthMode}
                onChange={(v) => applyDepthMode(v as DepthMode)}
                wrap
                mobileFill
                options={DEPTH_MODES.map((m) => ({ value: m.value, label: t(m.labelKey) }))}
              />
              {depthMode === "recent" && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("promptManager.regex.depthN")}</span>
                  <NumberInput
                    value={Number(draft.maxDepth) || 1}
                    min={1}
                    onChange={(v) => update("maxDepth", String(v))}
                    className="w-24"
                  />
                </div>
              )}
              {depthMode === "older" && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("promptManager.regex.depthN")}</span>
                  <NumberInput
                    value={Number(draft.minDepth) || 1}
                    min={1}
                    onChange={(v) => update("minDepth", String(v))}
                    className="w-24"
                  />
                </div>
              )}
              {depthMode === "range" && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("promptManager.regex.depthFrom")}</span>
                  <NumberInput
                    value={Number(draft.minDepth) || 0}
                    min={0}
                    onChange={(v) => update("minDepth", String(v))}
                    className="w-24"
                  />
                  <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("promptManager.regex.depthTo")}</span>
                  <NumberInput
                    value={Number(draft.maxDepth) || 1}
                    min={1}
                    onChange={(v) => update("maxDepth", String(v))}
                    className="w-24"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="font-ui text-[11px] text-t4">{t("promptManager.regex.depthNoteHidden")}</div>
          )}

          {/* Apply-target (write-mode) */}
          <div>
            <SegmentedControl
              value={draft.applyTarget}
              onChange={(v) => update("applyTarget", v as RegexApplyTarget)}
              wrap
              mobileFill
              options={APPLY_TARGETS.map((a) => ({
                value: a.value,
                label: t(a.labelKey),
                tooltip: t(a.hintKey),
              }))}
            />
          </div>
        </div>
      </div>

      {/* Rule fields (R-7): mono at the SAME size as regular inputs —
          typeface-only distinction, these are not a lesser class of field. */}
      <div>
        <label className={lblCls} htmlFor="regex-find">{t("promptManager.regex.fieldFind")}</label>
        <AutoTextarea
          id="regex-find"
          className={monoUICls}
          value={draft.findRegex}
          onChange={(e) => update("findRegex", e.target.value)}
          placeholder={t("promptManager.regex.findPlaceholder")}
          minRows={2}
          maxRows={6}
        />
        <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.findHint")}</div>
      </div>

      <div>
        <label className={lblCls} htmlFor="regex-replace">{t("promptManager.regex.fieldReplace")}</label>
        <AutoTextarea
          id="regex-replace"
          className={monoUICls}
          value={draft.replaceString}
          onChange={(e) => update("replaceString", e.target.value)}
          placeholder={t("promptManager.regex.replacePlaceholder")}
          minRows={2}
          maxRows={6}
        />
        <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.replaceHint")}</div>
      </div>

      <div>
        <label className={lblCls} htmlFor="regex-trim">{t("promptManager.regex.fieldTrim")}</label>
        <AutoTextarea
          id="regex-trim"
          className={monoUICls}
          value={draft.trimStrings}
          onChange={(e) => update("trimStrings", e.target.value)}
          placeholder={t("promptManager.regex.trimPlaceholder")}
          minRows={1}
          maxRows={4}
        />
        <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.trimHint")}</div>
      </div>

      {/* Substitute macros — part of the rule (affects the find pattern). */}
      <div>
        <label className={lblCls} htmlFor="regex-substitute">{t("promptManager.regex.fieldSubstitute")}</label>
        <SegmentedControl
          value={String(draft.substituteRegex)}
          onChange={(v) => update("substituteRegex", Number(v) as RegexSubstituteMode)}
          wrap
          mobileFill
          options={SUBSTITUTE_OPTIONS.map((o) => ({
            value: String(o.value),
            label: t(o.labelKey),
          }))}
        />
      </div>

      {/* Live test pane (R-7): macro-substituted run, no-match vs match
          distinction, and an honesty disclaimer — the pane does not simulate
          scope, bindings or depth. */}
      <div className="rounded-md border border-border2 p-3">
        <div className={cn(lblCls, "mb-2")}>
          {t("promptManager.regex.testTitle")}
        </div>
        <div className="mb-2 font-ui text-[11px] text-t4">{t("promptManager.regex.testDisclaimer")}</div>
        <AutoTextarea
          className={monoUICls}
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder={t("promptManager.regex.testInputPlaceholder")}
          aria-label={t("promptManager.regex.testInputLabel")}
          minRows={2}
          maxRows={6}
        />
        <div className="mt-2">
          <div className="font-ui text-[11px] text-t4">{t("promptManager.regex.testOutputLabel")}</div>
          {testResult.kind === "error" ? (
            <div role="alert" aria-label={t("promptManager.regex.testOutputLabel")} className="mt-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 font-mono text-t1 text-danger">
              {testResult.output}
            </div>
          ) : testResult.kind === "noMatch" ? (
            <div aria-label={t("promptManager.regex.testOutputLabel")} className="mt-1 rounded-md border border-border bg-s3 px-2 py-1.5 font-ui text-[calc(var(--ui-fs)-2px)] text-t3">
              {t("promptManager.regex.testNoMatch")}
            </div>
          ) : (
            <div aria-label={t("promptManager.regex.testOutputLabel")} className="mt-1 rounded-md border border-border bg-s3 px-2 py-1.5 font-mono text-t1 whitespace-pre-wrap min-h-[2em]">
              {testResult.kind === "ok" && testResult.output === "" ? (
                <span className="text-t4">{t("promptManager.regex.testMatchEmpty")}</span>
              ) : testResult.kind === "ok" && testResult.unchanged && testResult.output !== "" ? (
                <>
                  {testResult.output}
                  <div className="mt-1 font-ui text-[11px] text-t4">{t("promptManager.regex.testUnchanged")}</div>
                </>
              ) : (
                testResult.output || <span className="text-t4">{t("promptManager.regex.testOutputEmpty")}</span>
              )}
            </div>
          )}
          {macroPreview !== null && (
            <div className="mt-1.5 font-mono text-[calc(var(--ui-fs)-3px)] text-t4">
              <span className="font-ui">{t("promptManager.regex.testMacroPattern")}: </span>
              {macroPreview}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
