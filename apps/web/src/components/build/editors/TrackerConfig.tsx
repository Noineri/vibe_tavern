import { useState, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { ChatId, SceneTrackerConfig, SceneTrackerConfigPatch } from "@vibe-tavern/domain";
import { normalizeSceneTrackerConfig, synthesizeSceneSample, findInvalidXmlKeys, SCENE_AUTO_MODE, SCENE_PROMPT_FORMAT } from "@vibe-tavern/domain";
import { sceneTrackerDslSchema } from "@vibe-tavern/api-contracts";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { Toggle } from "../../shared/Toggle.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { NumberInput } from "../../shared/NumberInput.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { SceneStateView } from "../../shared/SceneStateView.js";
import { formatSceneHistory } from "@vibe-tavern/prompt-pipeline";
import { inputCls, monoCls, inputPad, lblCls } from "../fields/field-styles.js";
import { SceneHistoryBackfill } from "./SceneHistoryBackfill.js";
import { useT } from "../../../i18n/context.js";
import { useSnapshotStore } from "../../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import { updateInsightsConfigAction, previewSceneAction } from "../../../stores/api-actions/chat-actions.js";
import { findCurrentInsightsCompletionTarget } from "../../../stores/api-actions/insights-completion-actions.js";
import { fetchProviderModelsAction } from "../../../stores/api-actions/provider-actions.js";
import { useSceneRenderStore, type SceneRenderVariant } from "../../../stores/scene-render-store.js";

/** A copyable worked example for the DSL authoring disclosure — exercises every
 *  node kind ($type, ranged number, object/properties, array/items, label). */
const SCENE_DSL_EXAMPLE = `{
  "mood": { "$type": "string", "label": "Mood" },
  "tension": { "$type": "number", "min": 0, "max": 10 },
  "location": {
    "$type": "object",
    "properties": { "room": { "$type": "string" } }
  },
  "tags": { "$type": "array", "items": { "$type": "string" } }
}`;

/**
 * Scene Tracker config editor (SCENE_TRACKER_PLAN SCN-11). Mirrors the Objective
 * config editor's structure but uses a DRAFT-state model: every field edits a
 * local copy, a Save button persists the whole draft as a partial PATCH (the
 * store deep-merges it into `tracker`, preserving Objective), and a Preview
 * **Preview** button synthesizes an instant schema-conforming placeholder
 * sample (no LLM, no network) so the render layout can be inspected for free
 * while iterating on the schema; **Test generation** trial-runs the REAL
 * generate pipeline with the DRAFT config against the selected assistant
 * variant WITHOUT committing (transient) — the only way to catch a DSL /
 * prompt that makes the model emit non-conforming data. The split keeps
 * render-checking free and instant while still preserving pipeline validation.
 *
 * The draft model exists for three reasons the Objective editor (auto-save on
 * blur) doesn't share: (1) the DSL must validate before it can save or preview;
 * (2) preview runs against the unsaved draft, not the stored config; (3) a dirty
 * draft is protected from background snapshot syncs (a background refresh only
 * patches objectiveState + a message, never the tracker config — but the guard
 * is belt-and-suspenders against another tab's edit). Switching chats discards
 * the draft (an explicit action); staying on the chat preserves it.
 *
 * Test generation is cancellable (owned AbortController), preserves the
 * LAST-VALID result across retries (a failed retry toasts but keeps the prior
 * sample), and is gated on a valid schema + a selected assistant variant. Both
 * the placeholder sample and a real generation write the same transient
 * `previewState` (whichever ran last wins); neither is ever ingested into the
 * snapshot.
 */
export function TrackerConfig({ chatId }: { chatId: ChatId }) {
  const { t } = useT();
  const activeChat = useSnapshotStore((s) => s.activeChat);
  const renderVariant = useSceneRenderStore((s) => s.variant);
  const setRenderVariant = useSceneRenderStore((s) => s.setVariant);

  const rawTracker = activeChat?.insightsConfig?.tracker;
  const savedTracker = useMemo(() => normalizeSceneTrackerConfig(rawTracker), [JSON.stringify(rawTracker)]);

  const [draft, setDraft] = useState<SceneTrackerConfig>(savedTracker);
  const [schemaText, setSchemaText] = useState(() => JSON.stringify(savedTracker.schema, null, 2));
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [previewState, setPreviewState] = useState<Record<string, unknown> | null>(null);
  const [testing, setTesting] = useState(false);
  const testAbort = useRef<AbortController | null>(null);

  // Re-sync the draft from the stored config. On a CHAT SWITCH (chatId changed)
  // the draft is discarded — switching chats is an explicit action. On a
  // background sync (same chat, stored config changed) the draft is preserved
  // while dirty (dirty protection); otherwise it tracks the stored value.
  const prevChatId = useRef(chatId);
  useEffect(() => {
    const switched = prevChatId.current !== chatId;
    prevChatId.current = chatId;
    if (!switched && dirty) return;
    setDraft(savedTracker);
    setSchemaText(JSON.stringify(savedTracker.schema, null, 2));
    setSchemaError(null);
    if (switched) {
      setDirty(false);
      setPreviewState(null);
    }
  }, [savedTracker, chatId, dirty]);

  // Abort any in-flight generation test on unmount (no persistence, no dangling fetch).
  useEffect(() => () => testAbort.current?.abort(), []);

  function update<K extends keyof SceneTrackerConfig>(field: K, value: SceneTrackerConfig[K]) {
    setDraft((d) => ({ ...d, [field]: value }));
    setDirty(true);
  }

  function onSchemaChange(text: string) {
    setSchemaText(text);
    setDirty(true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : t("scn_schema_invalid_json"));
      return;
    }
    const result = sceneTrackerDslSchema.safeParse(parsed);
    if (!result.success) {
      setSchemaError(formatDslError(result.error.issues));
      return;
    }
    setSchemaError(null);
    setDraft((d) => ({ ...d, schema: result.data }));
  }

  async function save() {
    if (effectiveSchemaError || saving) return;
    setSaving(true);
    try {
      await updateInsightsConfigAction(chatId, { insightsConfig: { tracker: configPatch(draft) } });
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("scn_save_failed"));
    } finally {
      setSaving(false);
    }
  }

  /** Instant placeholder preview — synthesizes a schema-conforming sample from
   *  the DRAFT schema (no LLM, no network). Demonstrates the render layout only;
   *  it never validates the generation pipeline (use Test generation for that). */
  function previewSample() {
    if (effectiveSchemaError) return;
    setPreviewState(synthesizeSceneSample(draft.schema));
  }

  async function testGeneration() {
    if (effectiveSchemaError || testing) return;
    const target = findCurrentInsightsCompletionTarget(chatId);
    if (!target?.variantId) {
      toast.error(t("scn_no_target"));
      return;
    }
    testAbort.current?.abort();
    const controller = new AbortController();
    testAbort.current = controller;
    setTesting(true);
    try {
      const res = await previewSceneAction(chatId, { branchId: target.branchId, messageId: target.messageId, variantId: target.variantId }, draft, controller.signal);
      if (controller.signal.aborted) return;
      setPreviewState(res.sceneState); // last-valid preserved across retries
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error(err instanceof Error ? err.message : t("scn_preview_failed"));
      // keep the prior previewState (last-valid preservation)
    } finally {
      if (testAbort.current === controller) {
        testAbort.current = null;
        setTesting(false);
      }
    }
  }

  function stopTest() {
    testAbort.current?.abort();
  }

  // XML prompt format requires ASCII-safe field names (the serializer emits
  // `<key>` tags and only escapes entities, not tag-name chars, so a space /
  // leading digit / `$` would yield malformed XML). Surface it as a schema error
  // so Save/Preview/Test are blocked until the keys are fixed or the format is
  // switched back to JSON. Reactive to both schema + promptFormat (not just the
  // schema text), so flipping the format to XML re-checks immediately.
  const xmlKeyError = useMemo(() => {
    if (draft.promptFormat !== SCENE_PROMPT_FORMAT.xml) return null;
    const bad = findInvalidXmlKeys(draft.schema);
    return bad.length > 0 ? `${t("scn_xml_key_error")} ${bad.join(", ")}` : null;
  }, [draft.promptFormat, draft.schema, t]);
  const effectiveSchemaError = schemaError ?? xmlKeyError;

  const canSave = dirty && !effectiveSchemaError && !saving;
  // Instant preview needs only a valid schema. The generation-test button stays
  // ENABLED while testing so Stop is clickable (disabled-buttons are not
  // clickable in a real browser — gating Stop on `!testing` would break cancel).
  const canPreview = !effectiveSchemaError;
  const spinner = <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-s2/50 p-4">
      {/* DSL schema editor */}
      <div>
        <label className={lblCls}>{t("scn_schema_label")}</label>
        <p className="mb-1.5 mt-0.5 font-ui text-[10px] leading-relaxed text-t4">{t("scn_schema_hint")}</p>
        <div className="mt-1.5 overflow-hidden rounded-md border border-border2">
          <CodeEditor
            value={schemaText}
            onChange={onSchemaChange}
            minHeight="160px"
            className="font-mono text-[12px]"
          />
        </div>
        {effectiveSchemaError && (
          <p className="mt-1.5 font-ui text-[11px] leading-relaxed text-danger-text">{effectiveSchemaError}</p>
        )}
        {/* Authoring aid — grammar summary + a copyable worked example
            (progressive disclosure: collapsed until the user needs it). */}
        <details className="group mt-1.5">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1 font-ui text-[11px] text-t4 hover:text-t3">
            <Ic.help />
            {t("scn_schema_example_summary")}
          </summary>
          <div className="mt-1.5 space-y-1.5 rounded-md border border-border2 bg-s2/40 p-2">
            <p className="font-ui text-[11px] leading-relaxed text-t3">{t("scn_schema_grammar")}</p>
            <div className="relative">
              <pre className={cn(monoCls, "max-h-56 overflow-auto rounded p-2 pr-9 text-[11px] leading-relaxed text-t2")}>{SCENE_DSL_EXAMPLE}</pre>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(SCENE_DSL_EXAMPLE);
                  toast.success(t("copied"));
                }}
                className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded text-t4 hover:bg-s2 hover:text-t2"
                title={t("copy")}
              >
                <Ic.copy />
              </button>
            </div>
          </div>
        </details>
      </div>

      {/* Auto-generate mode */}
      <div>
        <label className={lblCls}>{t("scn_auto_mode_label")}</label>
        <div className="mt-1.5 flex gap-1.5">
          {([SCENE_AUTO_MODE.assistant, SCENE_AUTO_MODE.manual] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => update("autoMode", mode)}
              className={cn(
                "flex-1 rounded-md border px-3 py-1.5 font-ui text-[12px] transition-colors",
                draft.autoMode === mode
                  ? "border-accent bg-accent-dim text-accent"
                  : "border-border2 bg-s2 text-t3 hover:border-accent",
              )}
            >
              {t(mode === SCENE_AUTO_MODE.assistant ? "scn_auto_mode_assistant" : "scn_auto_mode_manual")}
            </button>
          ))}
        </div>
      </div>

      {/* Scalar controls */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <ScalarField label={t("scn_context_window_label")} hint={t("scn_context_window_hint")}>
          <NumberInput value={draft.contextWindow} min={1} onChange={(v) => update("contextWindow", v)} />
        </ScalarField>
        <ScalarField label={t("scn_continuity_label")} hint={t("scn_continuity_hint")}>
          <NumberInput value={draft.continuityLastN} min={0} onChange={(v) => update("continuityLastN", v)} />
        </ScalarField>
        <ScalarField label={t("scn_inject_last_n_label")} hint={t("scn_inject_last_n_hint")}>
          <NumberInput value={draft.injectLastN} min={0} onChange={(v) => update("injectLastN", v)} />
        </ScalarField>
      </div>

      {/* Model selection (secondary insight model — mirrors Objective/Summary) */}
      <SceneModelSelector draft={draft} onUpdate={update} />

      {/* Advanced config (injection depth, prompt format, prompt overrides) */}
      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 font-ui text-[11px] font-medium uppercase tracking-[0.05em] text-t3 hover:text-t2"
        >
          {Ic.caret(advancedOpen ? "d" : "r")}
          {t("scn_advanced_label")}
        </button>
        {advancedOpen && (
          <div className="mt-2 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <ScalarField label={t("scn_depth_label")} hint={t("scn_depth_hint")}>
                <NumberInput value={draft.injectionDepth} min={1} onChange={(v) => update("injectionDepth", v)} />
              </ScalarField>
              <div>
                <label className={lblCls}>{t("scn_prompt_format_label")}</label>
                <DropdownSelect
                  value={draft.promptFormat}
                  options={[
                    { id: SCENE_PROMPT_FORMAT.json, label: "JSON" },
                    { id: SCENE_PROMPT_FORMAT.xml, label: "XML" },
                  ]}
                  onChange={(id) => update("promptFormat", id as SceneTrackerConfig["promptFormat"])}
                  className="mt-1.5"
                />
              </div>
            </div>
            <PromptField
              label={t("scn_generate_prompt_label")}
              hint={t("scn_prompt_hint")}
              defaultValue={draft.generatePrompt}
              onSave={(v) => update("generatePrompt", v)}
            />
            <PromptField
              label={t("scn_inject_prompt_label")}
              hint={t("scn_prompt_hint")}
              defaultValue={draft.injectPrompt}
              onSave={(v) => update("injectPrompt", v)}
            />
          </div>
        )}
      </div>

      {/* Save + Preview actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-ui text-[12px] font-medium transition-opacity disabled:opacity-40",
            dirty ? "bg-accent text-on-accent hover:opacity-90" : "border border-border2 bg-s2 text-t3",
          )}
        >
          {saving ? spinner : <Ic.floppy />}
          {t("scn_save_button")}
        </button>
        {/* Instant placeholder preview — no LLM; synthesizes a schema-conforming
            sample so the render layout can be inspected for free. */}
        <button
          type="button"
          onClick={() => previewSample()}
          disabled={!canPreview}
          className="inline-flex items-center gap-1.5 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:border-accent disabled:opacity-40"
        >
          <Ic.eye />
          {t("scn_preview_button")}
        </button>
        {/* Test generation — real AI call; validates the pipeline end-to-end.
            Stays enabled while testing so Stop is clickable in a real browser. */}
        <button
          type="button"
          onClick={() => (testing ? stopTest() : void testGeneration())}
          disabled={effectiveSchemaError !== null && !testing}
          title={t("scn_test_generation_hint")}
          className="inline-flex items-center gap-1.5 rounded-md border border-border2 bg-s2 px-3 py-1.5 font-ui text-[12px] font-medium text-t2 transition-colors hover:border-accent disabled:opacity-40"
        >
          {testing ? spinner : <Ic.regen />}
          {t(testing ? "scn_preview_stop_button" : "scn_test_generation_button")}
        </button>
        {dirty && <span className="font-ui text-[11px] text-accent">{t("scn_dirty_hint")}</span>}
        {/* Render variant — shared with the chat header (Scene zone expanded).
            Always visible so it can be set before running Preview; selecting it
            here also re-renders the header. Raw JSON stays a Preview-only
            disclosure below the rendered output. */}
        <div className="ml-auto">
          <SegmentedControl
            compact
            value={renderVariant}
            onChange={(v) => setRenderVariant(v as SceneRenderVariant)}
            options={[
              { value: "rich", label: t("scn_preview_mode_rich") },
              { value: "compact", label: t("scn_preview_mode_compact") },
            ]}
          />
        </div>
      </div>

      {/* Preview result (transient — last-valid preserved). Rendered in the
          shared variant (same as the header); Raw JSON is a collapsed disclosure. */}
      {previewState !== null && (
        <div className="rounded-md border border-border bg-s2 p-3">
          <div className="mb-2 flex items-center gap-1.5 font-ui text-[11px] font-medium uppercase tracking-[0.05em] text-t3">
            <Ic.eye />
            {t("scn_preview_title")}
          </div>
          <div className="max-h-64 overflow-auto rounded p-1">
            <SceneStateView schema={draft.schema} data={previewState} variant={renderVariant} className="gap-1" />
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer select-none font-ui text-[11px] text-t4 hover:text-t3">{t("scn_preview_raw_json")}</summary>
            <pre className={cn(monoCls, "mt-1 max-h-48 overflow-auto rounded p-2 text-[11px] leading-relaxed text-t2")}>
              {JSON.stringify(previewState, null, 2)}
            </pre>
          </details>
          {draft.promptFormat === SCENE_PROMPT_FORMAT.xml && (
            <details className="mt-2">
              <summary className="cursor-pointer select-none font-ui text-[11px] text-t4 hover:text-t3">{t("scn_preview_raw_xml")}</summary>
              <pre className={cn(monoCls, "mt-1 max-h-48 overflow-auto rounded p-2 text-[11px] leading-relaxed text-t2")}>
                {formatSceneHistory([previewState], "xml")}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* History backfill (SCN-15) — Build → Insights → Scene → History */}
      <div className="border-t border-border pt-3">
        <label className={lblCls}>{t("scn_history_label")}</label>
        <p className="mb-2 mt-0.5 font-ui text-[10px] leading-relaxed text-t4">{t("scn_history_hint")}</p>
        <SceneHistoryBackfill chatId={chatId} />
      </div>
    </div>
  );
}

/** Omit server-managed revision/schemaHash for the partial PATCH. */
function configPatch(draft: SceneTrackerConfig): SceneTrackerConfigPatch {
  const { revision: _r, schemaHash: _s, ...patch } = draft;
  return patch;
}

/** Format Zod DSL issues into a single inline error string with dotted paths. */
function formatDslError(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .slice(0, 4)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

function ScalarField({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={lblCls}>{label}</label>
      <div className="mt-1.5">{children}</div>
      <p className="mt-1 font-ui text-[10px] leading-relaxed text-t4">{hint}</p>
    </div>
  );
}

function PromptField({ label, hint, defaultValue, onSave }: { label: string; hint: string; defaultValue: string; onSave: (v: string) => void }) {
  return (
    <div>
      <label className={lblCls}>{label}</label>
      <AutoTextarea
        className={monoCls + " mt-1.5"}
        style={inputPad}
        defaultValue={defaultValue}
        placeholder={hint}
        minRows={2}
        onBlur={(e) => { if (e.target.value !== defaultValue) onSave(e.target.value); }}
      />
    </div>
  );
}

// ─── Model selection (secondary insight model — mirrors ObjectiveConfig) ──

function SceneModelSelector({
  draft,
  onUpdate,
}: {
  draft: SceneTrackerConfig;
  onUpdate: <K extends keyof SceneTrackerConfig>(field: K, value: SceneTrackerConfig[K]) => void;
}) {
  const { t } = useT();
  const profiles = useProviderDataStore((s) => s.profiles);
  const activeProvider = useMemo(() => profiles.find((p) => p.isActive) ?? profiles[0] ?? null, [profiles]);
  const useChatModel = draft.useChatModel;
  const pinnedModel = draft.model;

  const profileId = useChatModel ? (activeProvider?.id ?? "") : (draft.providerProfileId ?? "");
  const profile = profiles.find((p) => p.id === profileId) ?? null;

  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  useEffect(() => {
    if (!profileId) { setModels([]); return; }
    let cancelled = false;
    setLoadingModels(true);
    fetchProviderModelsAction(profileId)
      .then((res) => {
        if (cancelled) return;
        setModels(res.models.map((m) => ({ id: m.id, label: m.label ?? m.id })));
      })
      .catch(() => { if (!cancelled) setModels([]); })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [profileId]);

  const providerOptions = useMemo(() => profiles.map((p) => ({ id: p.id, label: p.name })), [profiles]);
  const effectiveModel = (
    useChatModel
      ? (profile?.defaultModel ?? "")
      : (pinnedModel ?? profile?.defaultModel ?? "")
  ).trim();

  return (
    <div className="border-t border-border pt-3">
      <label className={lblCls}>{t("scn_model_label")}</label>
      <label className="mb-2 mt-1.5 flex items-center gap-2 font-ui text-[12px] text-t2">
        <Toggle checked={useChatModel} onChange={(v) => onUpdate("useChatModel", v)} />
        {t("scn_use_chat_model")}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <DropdownSelect
          value={profileId}
          options={providerOptions}
          onChange={(id) => { onUpdate("providerProfileId", id); onUpdate("model", null); }}
          disabled={useChatModel}
          placeholder={t("scn_provider_label")}
          searchPlaceholder={t("scn_provider_label")}
        />
        <div className="flex items-center gap-1.5">
          <DropdownSelect
            value={effectiveModel}
            options={models}
            onChange={(id) => onUpdate("model", id)}
            disabled={useChatModel || !profileId || loadingModels}
            placeholder={loadingModels ? "…" : t("scn_model_label")}
            searchPlaceholder={t("scn_model_label")}
            className="flex-1"
          />
          <button
            type="button"
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-40",
              pinnedModel ? "border-accent bg-accent-dim text-accent" : "border-border text-t4 hover:text-t3",
            )}
            title={pinnedModel ? t("scn_model_unpin") : t("scn_model_pin")}
            onClick={() => onUpdate("model", pinnedModel ? null : (effectiveModel || null))}
            disabled={useChatModel || !effectiveModel}
          >
            {pinnedModel ? <Ic.starFilled /> : <Ic.star />}
          </button>
        </div>
      </div>
    </div>
  );
}
