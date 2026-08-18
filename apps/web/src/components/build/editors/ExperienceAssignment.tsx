/**
 * ExperienceAssignment — per-chat Chat Add-ons configurator for ONE interactive
 * experience (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 7 / IR-72A;
 * SCRIPTED_GAMES_DESIGN "Chat Add-ons configuration").
 *
 * This is the chat-local assignment surface, NOT the session setup modal and
 * NOT an authoring surface:
 *  - It selects the interactive rules script and an INDEPENDENT global visual
 *    (one rules script may pair with several visuals; changing the visual does
 *    not change the rules). Authoring either resource belongs in Build.
 *  - It shows ONLY the capabilities the discovered package actually declares
 *    (progressive disclosure): each declared capability is a row with a
 *    localized label, the author's `reason` (data, never translated), and a
 *    grant Toggle. Grants are fail-closed — every grant patch is filtered to
 *    the CURRENT declaration, so stale preexisting grants are never re-emitted.
 *  - `rp_context` granted AND declared reveals the context-mode
 *    SegmentedControl (all five canonical modes; compact summary is described
 *    as an explicit post-start action, never automatic). Un-granting
 *    `rp_context` resets contextMode to "none" in the same patch.
 *  - `model` granted AND declared shows a note that provider/model seats are
 *    pinned at launch (IR-73A setup) — there is deliberately NO provider/model
 *    selector here (Product Variant A).
 *  - Selecting another script immediately patches
 *    `{ scriptId, capabilityGrants: [], contextMode: "none" }` BEFORE its
 *    discovery runs, so grants from the previous package cannot leak into the
 *    next one.
 *
 * The component is fully controlled: it owns NO config state and performs NO
 * persistence — every change goes out through `onPatch` and the host
 * (IR-72B InsightsPanel integration) round-trips the snapshot. Readiness is
 * reported through `onValidityChange` so the host can refuse to enable the
 * add-on while the selected script's discovery is loading or invalid.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTEXT_MODE,
  type ChatId,
  type ExperienceCapability,
  type ExperienceContextMode,
} from "@vibe-tavern/domain";
import type { ExperienceDefinitionDto } from "@vibe-tavern/api-contracts";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { Toggle } from "../../shared/Toggle.js";
import { EmptyState } from "../../shared/empty-state.js";
import { Ic } from "../../shared/icons.js";
import { useT } from "../../../i18n/context.js";
import { useAllCharacters, useChatList } from "../../../stores/snapshot-store.js";
import type Resources from "../../../i18n/resources.js";
import { listAllScripts, testScript } from "../../../api/script-api.js";
import { listExperienceVisuals } from "../../../api/experience-api.js";
import { listPersonas } from "../../../api/persona-api.js";
import type { ExperienceConfigUpdateRequest, ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";

type TKey = keyof Resources["en"];

/** Localized label per canonical capability (exhaustive — a new capability in
 *  Domain fails typecheck here until it gets a label). */
const CAPABILITY_LABEL_KEYS: Record<ExperienceCapability, TKey> = {
  [EXPERIENCE_CAPABILITY.participants]: "experience_cap_participants",
  [EXPERIENCE_CAPABILITY.deterministicRandom]: "experience_cap_deterministic_random",
  [EXPERIENCE_CAPABILITY.model]: "experience_cap_model",
  [EXPERIENCE_CAPABILITY.rpContext]: "experience_cap_rp_context",
  [EXPERIENCE_CAPABILITY.rpAttachment]: "experience_cap_rp_attachment",
};

/** Canonical display order for the context-mode segmented control. */
const CONTEXT_MODE_ORDER: readonly ExperienceContextMode[] = [
  EXPERIENCE_CONTEXT_MODE.none,
  EXPERIENCE_CONTEXT_MODE.currentBranch,
  EXPERIENCE_CONTEXT_MODE.recent,
  EXPERIENCE_CONTEXT_MODE.summariesRecent,
  EXPERIENCE_CONTEXT_MODE.compactSummary,
];

const CONTEXT_MODE_LABEL_KEYS: Record<ExperienceContextMode, TKey> = {
  [EXPERIENCE_CONTEXT_MODE.none]: "experience_context_none",
  [EXPERIENCE_CONTEXT_MODE.currentBranch]: "experience_context_current_branch",
  [EXPERIENCE_CONTEXT_MODE.recent]: "experience_context_recent",
  [EXPERIENCE_CONTEXT_MODE.summariesRecent]: "experience_context_summaries_recent",
  [EXPERIENCE_CONTEXT_MODE.compactSummary]: "experience_context_compact_summary",
};

const CONTEXT_MODE_TOOLTIP_KEYS: Record<ExperienceContextMode, TKey> = {
  [EXPERIENCE_CONTEXT_MODE.none]: "experience_context_none_tip",
  [EXPERIENCE_CONTEXT_MODE.currentBranch]: "experience_context_current_branch_tip",
  [EXPERIENCE_CONTEXT_MODE.recent]: "experience_context_recent_tip",
  [EXPERIENCE_CONTEXT_MODE.summariesRecent]: "experience_context_summaries_recent_tip",
  [EXPERIENCE_CONTEXT_MODE.compactSummary]: "experience_context_compact_summary_tip",
};

/** Async list fetch (scripts / visuals) — loaded independently, so one
 *  failing read never blocks the other selector. */
type ListLoad<T> =
  | { status: "loading" }
  | { status: "ok"; items: T[] }
  | { status: "error" };

/** Selected-script discovery. `scriptId` rides along so a result can only ever
 *  be rendered against the selection that requested it. */
type DiscoveryState =
  | { status: "idle" }
  | { status: "loading"; scriptId: string }
  | { status: "ok"; scriptId: string; definition: ExperienceDefinitionDto }
  | { status: "error"; scriptId: string; titleKey: TKey; detail: string | null };

export interface ExperienceAssignmentProps {
  /** The concrete chat this config belongs to. Anchors the surface to the
   *  chat (test hooks / future Build navigation); reads stay chat-independent
   *  because scripts and visuals are global resources. */
  chatId: ChatId;
  /** Selected interactive rules script, or null for none. */
  scriptId: string | null;
  /** Selected global visual, or null for none (independent of the script). */
  visualId: string | null;
  /** Current capability grants. Rendered/patched only through the discovered
   *  declaration — stale undeclared grants are display-off and never re-emitted. */
  capabilityGrants: ExperienceCapability[];
  /** Current RP-context mode (meaningful only while `rp_context` is granted). */
  contextMode: ExperienceContextMode;
  /** User-chosen RP-context source — character pointer (report item 6), or
   *  null for ambient. Display-only here: the picker lives in the experience
   *  setup modal; this row just shows what the confirmed config says. */
  sourceCharacterId?: string | null;
  /** User-chosen RP-context source — chat pointer, or null. */
  sourceChatId?: string | null;
  /** Wave 3: persona source — the user-identity override pointer, or null. */
  sourcePersonaId?: string | null;
  /** Whether the chat surfaces the experience launcher. */
  launcherVisible: boolean;
  /** Partial config PATCH — the ONLY write channel; the component persists
   *  nothing itself. */
  onPatch: (patch: ExperienceConfigUpdateRequest) => void;
  /** True while a PATCH is in flight — disables every interactive control. */
  pending: boolean;
  /** Readiness contract for the host (IR-72B): called with `true` only while a
   *  script is selected, present in the interactive script list, AND its
   *  discovery produced a clean interactive definition; `false` in every
   *  other state (idle / loading / wrong kind / null definition / discovery
   *  error / request failure / missing script). Fires on transitions (plus
   *  once on mount), not on every render. */
  onValidityChange?: (ready: boolean) => void;
}

export function ExperienceAssignment({
  chatId,
  scriptId,
  visualId,
  capabilityGrants,
  contextMode,
  sourceCharacterId = null,
  sourceChatId = null,
  sourcePersonaId = null,
  launcherVisible,
  onPatch,
  pending,
  onValidityChange,
}: ExperienceAssignmentProps) {
  const { t } = useT();

  // Source pointers → display labels (report item 6). Falls back to the raw id
  // when the source was deleted (label-level, privacy-safe).
  const allCharacters = useAllCharacters();
  const chatList = useChatList();
  const sourcePreviewText = (() => {
    if (sourceCharacterId === null && sourceChatId === null) return null;
    const charName =
      sourceCharacterId !== null
        ? (allCharacters.find((c) => c.id === sourceCharacterId)?.name ?? sourceCharacterId)
        : null;
    const chatTitle =
      sourceChatId !== null ? (chatList.find((c) => c.id === sourceChatId)?.title ?? sourceChatId) : null;
    if (charName !== null && chatTitle !== null) return t("experience_setup_source_preview_both", { character: charName, chat: chatTitle });
    if (chatTitle !== null) return t("experience_setup_source_preview_chat", { chat: chatTitle });
    return t("experience_setup_source_preview_character", { character: charName ?? "" });
  })();

  // Wave 3 (PS-4): persona names for the identity-override row — fetched
  // once per mount, best-effort (raw-id fallback covers a failed fetch).
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    listPersonas()
      .then((personas) => {
        if (cancelled) return;
        setPersonaList(personas.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        /* best-effort: the preview falls back to the raw id */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sourcePersonaPreviewText = (() => {
    if (sourcePersonaId === null) return null;
    const name = personaList.find((p) => p.id === sourcePersonaId)?.name ?? sourcePersonaId;
    return t("experience_setup_source_preview_persona", { persona: name });
  })();

  const [scriptsLoad, setScriptsLoad] = useState<ListLoad<ScriptRecord>>({ status: "loading" });
  const [visualsLoad, setVisualsLoad] = useState<ListLoad<ExperienceVisualRow>>({ status: "loading" });
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: "idle" });

  // Every interactive-kind script (any scope) — the selector's option source.
  useEffect(() => {
    let cancelled = false;
    listAllScripts()
      .then((all) => {
        if (cancelled) return;
        setScriptsLoad({ status: "ok", items: all.filter((s) => s.scriptKind === "interactive") });
      })
      .catch(() => {
        if (!cancelled) setScriptsLoad({ status: "error" });
      });
    return () => { cancelled = true; };
  }, []);

  // Global visuals — independent of the script list and of the selected script.
  useEffect(() => {
    let cancelled = false;
    listExperienceVisuals({ scopeType: "global" })
      .then((visuals) => {
        if (cancelled) return;
        setVisualsLoad({ status: "ok", items: visuals });
      })
      .catch(() => {
        if (!cancelled) setVisualsLoad({ status: "error" });
      });
    return () => { cancelled = true; };
  }, []);

  // Discover the selected script's interactive definition via the shared
  // script-test endpoint (IR-12 sandbox registration). The cancellation flag
  // plus the scriptId carried in DiscoveryState make stale results harmless:
  // a late resolution can neither overwrite a newer selection nor render
  // against it.
  useEffect(() => {
    if (scriptId === null) {
      setDiscovery({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDiscovery({ status: "loading", scriptId });
    testScript(scriptId, {})
      .then((result) => {
        if (cancelled) return;
        if (result.kind !== "interactive") {
          setDiscovery({ status: "error", scriptId, titleKey: "experience_assign_error_wrong_kind", detail: null });
          return;
        }
        if (result.discoveryError !== null) {
          setDiscovery({ status: "error", scriptId, titleKey: "experience_assign_error_discovery", detail: result.discoveryError });
          return;
        }
        if (result.definition === null) {
          setDiscovery({ status: "error", scriptId, titleKey: "experience_assign_error_invalid", detail: null });
          return;
        }
        setDiscovery({ status: "ok", scriptId, definition: result.definition });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiscovery({
          status: "error",
          scriptId,
          titleKey: "experience_assign_error_load",
          detail: err instanceof Error ? err.message : null,
        });
      });
    return () => { cancelled = true; };
  }, [scriptId]);

  // The discovery rendered below is ALWAYS the one for the current selection:
  // between a scriptId prop change and the effect's "loading" write, the state
  // still holds the previous script's result — this guard demotes it to
  // loading instead of letting the previous package's capabilities paint.
  const activeDiscovery: DiscoveryState = (() => {
    if (scriptId === null) return { status: "idle" };
    if (discovery.status !== "idle" && discovery.scriptId === scriptId) return discovery;
    return { status: "loading", scriptId };
  })();

  const interactiveScripts = scriptsLoad.status === "ok" ? scriptsLoad.items : null;
  // "Missing" can only be asserted once the list loaded; a failed list leaves
  // the discovery error states to carry the message.
  const scriptMissing =
    scriptId !== null && interactiveScripts !== null && !interactiveScripts.some((s) => s.id === scriptId);

  const declaredCapabilities =
    activeDiscovery.status === "ok"
      ? activeDiscovery.definition.declaredCapabilities
      : [];
  const declaredSet = new Set(declaredCapabilities.map((d) => d.capability));
  // Fail-closed grants: only values inside the CURRENT declaration are live.
  const effectiveGrants = capabilityGrants.filter((g) => declaredSet.has(g));

  const ready =
    scriptId !== null
    && scriptsLoad.status === "ok"
    && !scriptMissing
    && activeDiscovery.status === "ok";

  // Report readiness transitions (plus the initial value) to the host.
  const lastReportedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastReportedRef.current === ready) return;
    lastReportedRef.current = ready;
    onValidityChange?.(ready);
  }, [ready, onValidityChange]);

  /** Selecting a script clears grants + context BEFORE discovery — grants are
   *  per-package, so a new package always starts from the empty set. */
  function selectScript(id: string) {
    if (id === "") {
      onPatch({
        scriptId: null,
        capabilityGrants: [],
        contextMode: EXPERIENCE_CONTEXT_MODE.none,
      });
      return;
    }
    // Auto-apply the experience's default visual (paired at creation) so the
    // user doesn't re-bind a visual per chat. Only seeds when the script
    // declares a default AND that visual still exists in the loaded list
    // (stale-link guard). When the script has no default, the existing per-chat
    // visual is left untouched — the user can still pick one manually, and an
    // explicit dropdown choice always wins on subsequent edits.
    const patch: ExperienceConfigUpdateRequest = {
      scriptId: id,
      capabilityGrants: [],
      contextMode: EXPERIENCE_CONTEXT_MODE.none,
    };
    const script = scriptsLoad.status === "ok" ? scriptsLoad.items.find((s) => s.id === id) : undefined;
    const visuals = visualsLoad.status === "ok" ? visualsLoad.items : [];
    if (script?.defaultVisualId && visuals.some((v) => v.id === script.defaultVisualId)) {
      patch.visualId = script.defaultVisualId;
    }
    onPatch(patch);
  }

  /** Grant/revoke one capability. The emitted array is rebuilt from the
   *  declaration-filtered grants, so undeclared stale values never ship.
   *  Revoking `rp_context` also collapses the context mode to "none". */
  function patchGrant(capability: ExperienceCapability, grant: boolean) {
    const next = grant
      ? (effectiveGrants.includes(capability) ? effectiveGrants : [...effectiveGrants, capability])
      : effectiveGrants.filter((g) => g !== capability);
    const patch: ExperienceConfigUpdateRequest = { capabilityGrants: next };
    if (!grant && capability === EXPERIENCE_CAPABILITY.rpContext) {
      patch.contextMode = EXPERIENCE_CONTEXT_MODE.none;
    }
    onPatch(patch);
  }

  const rpContextActive =
    declaredSet.has(EXPERIENCE_CAPABILITY.rpContext) && effectiveGrants.includes(EXPERIENCE_CAPABILITY.rpContext);
  const modelActive =
    declaredSet.has(EXPERIENCE_CAPABILITY.model) && effectiveGrants.includes(EXPERIENCE_CAPABILITY.model);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-s2 p-4" data-chat-id={chatId}>
      {scriptsLoad.status === "error" && (
        <p className="font-ui text-[12px] leading-relaxed text-danger-text">
          {t("experience_assign_scripts_load_error")}
        </p>
      )}

      {/* Rules script selector — replaced by the empty state only when the
          list loaded and there is genuinely nothing to select. */}
      {scriptsLoad.status === "ok" && scriptsLoad.items.length === 0 ? (
        <EmptyState
          icon={<Ic.sparkles />}
          title={t("experience_assign_no_scripts_title")}
          sub={t("experience_assign_no_scripts_sub")}
        />
      ) : (
        <FieldBlock label={t("experience_assign_script_label")}>
          <DropdownSelect
            value={scriptId ?? ""}
            options={(interactiveScripts ?? []).map((s) => ({ id: s.id, label: s.name }))}
            placeholder={t("experience_assign_script_placeholder")}
            searchPlaceholder={t("experience_assign_script_search")}
            defaultOption={t("experience_assign_no_script_option")}
            onChange={selectScript}
            disabled={pending || scriptsLoad.status !== "ok"}
          />
        </FieldBlock>
      )}

      {/* Discovery outcome for the current selection — capability-dependent
          controls exist ONLY in the ok branch. */}
      {scriptId !== null && scriptsLoad.status === "ok" && scriptsLoad.items.length > 0 && (
        scriptMissing ? (
          <DiscoveryError title={t("experience_assign_script_missing")} />
        ) : activeDiscovery.status === "loading" ? (
          <p className="font-ui text-[12px] text-t4">{t("experience_assign_discovering")}</p>
        ) : activeDiscovery.status === "error" ? (
          <DiscoveryError title={t(activeDiscovery.titleKey)} detail={activeDiscovery.detail} />
        ) : activeDiscovery.status === "ok" ? (
          <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-ui text-[12px] font-medium text-t2">
                {activeDiscovery.definition.manifest.name}
              </span>
              <span className="min-w-0 truncate font-mono text-[10px] text-t4">
                {activeDiscovery.definition.manifest.id}
              </span>
            </div>

            <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
              {t("experience_assign_capabilities_label")}
            </span>
            {declaredCapabilities.length === 0 ? (
              <p className="font-ui text-[12px] leading-relaxed text-t4">
                {t("experience_assign_no_capabilities")}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {declaredCapabilities.map((decl) => (
                  <div
                    key={decl.capability}
                    className="flex items-center gap-2 rounded-md bg-s2 px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-ui text-[12px] font-medium text-t2">
                        {t(CAPABILITY_LABEL_KEYS[decl.capability])}
                      </div>
                      {decl.reason && (
                        <div className="mt-0.5 font-ui text-[11px] leading-relaxed text-t4">
                          {decl.reason}
                        </div>
                      )}
                    </div>
                    <Toggle
                      checked={effectiveGrants.includes(decl.capability)}
                      onChange={(v) => patchGrant(decl.capability, v)}
                      disabled={pending}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* RP-context mode — only once rp_context is declared AND granted. */}
            {rpContextActive && (
              <div className="flex flex-col gap-1.5">
                <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
                  {t("experience_assign_context_label")}
                </span>
                <SegmentedControl
                  value={contextMode}
                  options={CONTEXT_MODE_ORDER.map((mode) => ({
                    value: mode,
                    label: t(CONTEXT_MODE_LABEL_KEYS[mode]),
                    tooltip: t(CONTEXT_MODE_TOOLTIP_KEYS[mode]),
                  }))}
                  onChange={(v) => onPatch({ contextMode: v as ExperienceContextMode })}
                  compact
                  wrap
                  disabled={pending}
                />
                {(sourcePreviewText !== null || sourcePersonaPreviewText !== null) && (
                  <p className="font-ui text-[11px] leading-relaxed text-t3" data-testid="experience-assign-source">
                    {sourcePreviewText}
                    {sourcePersonaPreviewText !== null && (
                      <>
                        {sourcePreviewText !== null && <br />}
                        {sourcePersonaPreviewText}
                      </>
                    )}
                  </p>
                )}
              </div>
            )}

            {/* Model seats pin provider/model at launch (IR-73A) — note only,
                never a selector here. */}
            {modelActive && (
              <div className="flex items-start gap-2 rounded-md border border-border bg-s2 px-2.5 py-2">
                <span className="mt-0.5 shrink-0 text-t3"><Ic.brain /></span>
                <p className="font-ui text-[12px] leading-relaxed text-t3">
                  {t("experience_assign_model_note")}
                </p>
              </div>
            )}
          </div>
        ) : null
      )}

      {/* Visual selector — independent of the script; may stay unbound. */}
      <FieldBlock label={t("experience_assign_visual_label")}>
        <DropdownSelect
          value={visualId ?? ""}
          options={(visualsLoad.status === "ok" ? visualsLoad.items : []).map((v) => ({ id: v.id, label: v.name }))}
          placeholder={t("experience_assign_visual_placeholder")}
          searchPlaceholder={t("experience_assign_visual_search")}
          defaultOption={t("experience_assign_no_visual_option")}
          onChange={(id) => onPatch({ visualId: id === "" ? null : id })}
          disabled={pending || visualsLoad.status === "loading"}
        />
        {visualsLoad.status === "error" && (
          <p className="font-ui text-[11px] leading-relaxed text-danger-text">
            {t("experience_assign_visuals_load_error")}
          </p>
        )}
      </FieldBlock>

      {/* Launcher visibility — ordinary config, independent of the package. */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-ui text-[12px] text-t2">{t("experience_assign_launcher_label")}</span>
        <Toggle
          checked={launcherVisible}
          onChange={(v) => onPatch({ launcherVisible: v })}
          disabled={pending}
        />
      </div>
    </div>
  );
}

/** Section label above a control (no fixed width — Russian runs 20–30% longer). */
function FieldBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{label}</span>
      {children}
    </div>
  );
}

/** Discovery/validation failure — mirrors the DiceScriptTester discovery-error
 *  treatment (danger box; the raw VM/API message shown verbatim as local
 *  script validation feedback). */
function DiscoveryError({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="rounded-md border border-danger bg-danger-dim px-2.5 py-2">
      <div className="font-ui text-[11px] font-semibold uppercase text-danger-text">{title}</div>
      {detail && (
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{detail}</pre>
      )}
    </div>
  );
}
