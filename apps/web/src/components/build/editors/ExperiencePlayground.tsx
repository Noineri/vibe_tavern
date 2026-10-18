/**
 * ExperiencePlayground — the interactive play-loop authoring surface
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-84B).
 *
 * Mounted by the ExperienceCopilotShell inside the "Try" tab (XU-6; before
 * XU-4/XU-6 it was a modal next to the since-retired IR-81D InteractiveTester)
 * and fed BOTH unsaved buffers via props: the CURRENT UNSAVED rules buffer
 * (`code`) and the CURRENT UNSAVED visual source (`visualSource`, null when no
 * visual is selected). This is the turn-by-turn PLAY loop over the IR-84A
 * in-memory playground driver (POST /api/experience/playground/start|advance
 * via the two client functions in api/experience-api.ts):
 *
 *  - Start: discover + create + project the author's roster through the REAL
 *    kernel, advancing any LEADING script-controlled seats synchronously until
 *    the first human/model/idle boundary. The author picks the human seat to
 *    drive (default: the first human seat). The validated definition, initial
 *    projection, accumulated events/effects/console, revision, status, and the
 *    boundary stop-reason render read-only; a broken rules body renders the
 *    typed vm_error with the kernel kind.
 *  - Drive: clicking a legal action (or submitting a custom one) applies ONE
 *    human action via the real reduce — requestId idempotency +
 *    expectedRevision CAS are editable fields so replays and stale revisions
 *    stay directly exercisable — then script seats advance synchronously to
 *    the next boundary. Each turn renders the bumped revision, this turn's
 *    events/effects/console, and the new projection. A model boundary renders
 *    as an informational stub (no provider is ever called), never an error.
 *  - Visual: the current visual source renders inside the isolated
 *    {@link ExperienceFrame} (`sandbox="allow-scripts"` WITHOUT
 *    `allow-same-origin` — the opaque origin) and receives every turn's
 *    projection through the host bridge (state is posted TO the frame, never
 *    to the host DOM). A visual-initiated action advances the SAME playground
 *    session and is acked via sendResult/sendError (the bridge's
 *    duplicate-click lock is always cleared).
 *
 * Read-only invariant: every input and result lives in local component state.
 * This panel imports NO store and never writes one — a full
 * start → advance → reset cycle leaves the rules draft, the visual draft, and
 * every persistent store byte-identical — and it never forwards an action to
 * any chat/session. Reset tears the session + frame down client-side (the
 * server-side session is ephemeral process memory owned by the IR-84A driver).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT,
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  EXPERIENCE_LAUNCH_CAPABILITIES as CAPABILITIES,
  deriveDefaultLaunchContext,
  type ExperienceCapability,
} from "@vibe-tavern/domain";
import type {
  ExperienceActionDto,
  ExperienceCopilotLaunchContext,
} from "@vibe-tavern/api-contracts";
import { Ic } from "../../shared/icons.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { cn } from "../../../lib/cn.js";
import { parseOptionalJsonDiagnosed } from "../../../lib/json-parse-diagnostic.js";
import {
  SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY,
  scriptExecutionGuard,
  type ScriptSafetyWarningFlow,
} from "../../../lib/script-execution-guard.js";
import { useScriptSafetySettingsStore } from "../../../stores/script-safety-settings-store.js";
import { ImportedScriptWarningModal } from "./script-safety/ImportedScriptWarningModal.js";
import { FindingsWarningModal } from "./script-safety/FindingsWarningModal.js";
import { useT } from "../../../i18n/context.js";
import {
  advanceExperiencePlayground,
  discoverExperience,
  runExperiencePlaygroundTimer,
  runExperienceRoundModel,
  runExperienceTest,
  simulateExperienceTest,
  startExperiencePlayground,
} from "../../../api/experience-api.js";
import type {
  ExperienceParticipant,
  ExperiencePlaygroundAdvanceRequest,
  ExperiencePlaygroundData,
  ExperienceTestDefinition,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
  ScriptRecord,
} from "../../../api/types.js";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
  type ExperienceModelSeatRequest,
  type ExperienceRoundCommitClaim,
} from "../../experience/ExperienceFrame.js";
import { ExperienceRoundFinishedPanel } from "../../experience/ExperienceModal.js";
import { PlaygroundStartOptions } from "./experience-playground-start-options.js";
import { CONTROLLER_LABEL_KEY, PlaygroundRoster } from "./experience-playground-roster.js";
import { PlaygroundErrorPanel } from "./experience-playground-error.js";
import { PlaygroundDiagnostics } from "./experience-playground-diagnostics.js";
import { usePlaygroundModelOptions } from "./experience-playground-model-options.js";
import type { ExperienceLoopConfig } from "../../../lib/experience-loop-host.js";
import type { LoopDiagSample } from "../../../lib/experience-bridge.js";
import {
  buildRealtimeLoopConfig,
  createPlaygroundModelSeam,
} from "../../../lib/experience-realtime.js";
import {
  deriveSetupValuesFromSettings,
  mergeAbsentSetupDefaults,
  SetupFieldRow,
  validateSetupFields,
  type SetupField,
} from "../../experience/setup-fields.js";
import {
  buildPlaygroundDigest,
  buildPlaygroundLogDigest,
  buildRealtimeLoopDigest,
  buildRunTestDigest,
  buildRunTestErrorDigest,
  buildSimulateDigest,
  type CopilotDigest,
  type PlaygroundSessionLog,
} from "../../../lib/experience-copilot-digest.js";
import { copyText } from "../../../lib/clipboard.js";
import {
  clearPlaygroundConfig,
  loadPlaygroundConfig,
  savePlaygroundConfig,
} from "../../../lib/playground-config-persistence.js";
import {
  CAPABILITY_LABEL_KEY,
  PlaygroundSetupCheck,
  PlaygroundSetupResetButton,
} from "./experience-playground-setup-check.js";
import { blockCls, blockLabelCls } from "./experience-playground-results.js";
import {
  asSettingsObject,
  slugifyId,
  toPlaygroundError,
  uniqueIdFor,
  type AdvanceOutcome,
  type PlaygroundErrorView,
  type PlaygroundSeat,
} from "./experience-playground-model.js";

// ─── Local constants ─────────────────────────────────────────────────────────

/** LOBBY-A (EXPERIENCE_ENGINE_LOBBY_REPORT fix step 1): the setup-field discovery debounce. The unsaved rules buffer changes per keystroke; the pre-LOBBY-A auto-derive fired a compile per keystroke while the roster was untouched. The debounce coalesces that churn AND is what makes it affordable to keep discovering (for the declared setup fields) even after the roster is user-owned. */
const DISCOVERY_DEBOUNCE_MS = 400;

/** Grounding step 6 (EXPERIENCE_COPILOT_GROUNDING_REPORT): the empty
 *  whole-session log. Shared by the state initializer, Reset, and the start
 *  failure paths (the log is always replaced wholesale, never mutated). */
const EMPTY_SESSION_LOG: PlaygroundSessionLog = { events: [], effects: [], console: [], turns: 0 };

// ─── Component ───────────────────────────────────────────────────────────────

interface ExperiencePlaygroundProps {
  /** The CURRENT UNSAVED rules buffer (owned by the ExperienceEditor). */
  code: string;
  /** The CURRENT UNSAVED visual source, or null when no visual is selected.
   *  Rendered read-only inside the isolated frame; never edited here. */
  visualSource: string | null;
  /** Owning script's id (fix item 9a): keys the localStorage persistence of
   *  the test config (roster/models/grants/seed/settings/human seat). When
   *  absent (the standalone panel use), nothing persists — the pre-9a
   *  behavior. */
  scriptId?: string;
  /** SS-7B2: the owning rules script's trust data (origin/firstEnabledAt),
   *  threaded from the ExperienceEditor through the copilot shell. The
   *  debounced AUTOMATIC discovery routes it through the script execution
   *  guard: an imported never-enabled script sends NO discovery request and
   *  renders the shared localized auto-skip state instead. Absent (the
   *  standalone panel use) keeps the pre-B2 discovery behavior. */
  script?: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null;
  /** ER-14: when provided (by the copilot shell), a "Send diagnostics to
   *  assistant" button appears INSIDE the Developer-diagnostics disclosure and
   *  posts the live session digest into the copilot thread. Undefined outside
   *  the shell (standalone playground use → no button). */
  onSendToCopilot?: (digest: CopilotDigest) => void;
  /** SS-7B4: opens the Rules editor at a finding from this inline Try surface. */
  onShowInCode?: (line: number) => void;
  /** Latest roster/grants/settings/seed for copilot diagnostics. */
  onLaunchContextChange?: (context: ExperienceCopilotLaunchContext) => void;
}

export function ExperiencePlayground({ code, visualSource, scriptId, script, onSendToCopilot, onShowInCode, onLaunchContextChange }: ExperiencePlaygroundProps) {
  const { t } = useT();

  // Play context (local only). Fix item 9a: lazily rehydrated from the
  // localStorage persistence when a scriptId keys it — a restored config
  // counts as "touched" so the auto-derive effect never overrides it.
  const [seats, setSeats] = useState<PlaygroundSeat[]>(() => {
    const persisted = scriptId === undefined ? null : loadPlaygroundConfig(scriptId);
    if (persisted !== null && persisted.seats.length > 0) {
      return persisted.seats.map((seat) => ({ ...seat }));
    }
    return [{ id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human }];
  });
  const [grants, setGrants] = useState<readonly ExperienceCapability[]>(() => {
    const persisted = scriptId === undefined ? null : loadPlaygroundConfig(scriptId);
    return persisted !== null ? [...persisted.grants] : [];
  });
  const [seed, setSeed] = useState(() => {
    const persisted = scriptId === undefined ? null : loadPlaygroundConfig(scriptId);
    return persisted !== null ? persisted.seed : "";
  });
  const [settingsJson, setSettingsJson] = useState(() => {
    const persisted = scriptId === undefined ? null : loadPlaygroundConfig(scriptId);
    return persisted !== null ? persisted.settingsJson : "";
  });
  /** The seat the author drives; "" = the driver default (first human seat). */
  const [humanSeatId, setHumanSeatId] = useState(() => {
    const persisted = scriptId === undefined ? null : loadPlaygroundConfig(scriptId);
    return persisted !== null ? persisted.humanSeatId : "";
  });
  // XU-2: "Random start" toggle. ON by default for a FRESH config (no persisted
  // state): a non-technical user gets a fresh start without understanding
  // seeds. A restored config uses its persisted flag (normalized to false when
  // absent — backward compatible).
  const [randomStart, setRandomStart] = useState(() => {
    const persisted = scriptId === undefined ? null : loadPlaygroundConfig(scriptId);
    return persisted !== null ? persisted.randomStart : true;
  });
  /** The last randomly-generated seed (XU-2): shown read-only in the disabled
   *  seed input while the toggle is ON, so the author can still see what was
   *  used without hand-managing a seed. */
  const [lastUsedSeed, setLastUsedSeed] = useState("");

  // LOBBY-A (EXPERIENCE_ENGINE_LOBBY_REPORT fix step 1): the setup fields
  // declared by the CURRENT rules buffer (discovered), plus the per-field
  // validation errors painted inline. The settings JSON stays the single
  // source of truth — the form renders it and every edit writes back into it.
  const [setupFields, setSetupFields] = useState<SetupField[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** LOBBY-A: the collapsed "advanced" disclosure over the raw settings JSON
   *  (technical users; verbatim: hide the JSON for technical users under
   *  an accordion). Local only — never persisted. */
  const [settingsJsonOpen, setSettingsJsonOpen] = useState(false);
  /** LOBBY-A: settings became the user's explicit choice (a form edit or a
   *  textarea edit) — or the config was restored. Persisting no longer
   * requires a roster edit: `seatsTouched` gates only the roster auto-derive,
   * so a settings-only configuration survives a remount. */
  const [settingsTouched, setSettingsTouched] = useState(
    () => scriptId !== undefined && loadPlaygroundConfig(scriptId) !== null,
  );

  // Session + turn form (local only). requestId/expectedRevision are
  // author-editable (prefilled from the last envelope) so idempotent replays
  // and stale-revision conflicts are directly exercisable.
  const [session, setSession] = useState<ExperiencePlaygroundData | null>(null);
  const [definition, setDefinition] = useState<ExperienceTestDefinition | null>(null);
  const [error, setError] = useState<PlaygroundErrorView | null>(null);
  const [busy, setBusy] = useState<"start" | "advance" | null>(null);
  // Grounding step 6: the whole-session LOG accumulator. The server returns
  // every event on start but only the CURRENT turn's events/effects/console on
  // advance and timer beats (D5.3), so the full log is stitched client-side.
  // Replaced on start, appended on every advance/timer-beat response, cleared
  // on Reset; the status-strip "send log" / "copy log" buttons feed it to
  // buildPlaygroundLogDigest.
  const [sessionLog, setSessionLog] = useState<PlaygroundSessionLog>(EMPTY_SESSION_LOG);
  /** Grounding step 6: the launch context the CURRENT session was started
   *  with (the exact roster/grants/seed sent) — captured at start so the log
   *  describes how the session RAN, not the since-edited live config. Cleared
   *  on Reset alongside the log. */
  const [logLaunchContext, setLogLaunchContext] = useState<ExperienceCopilotLaunchContext | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  // RM-9: the discovered manifest's realtime signal (tickMs). Null = turn
  // mode — the classic server-driven flow, byte-identical to pre-RM-9.
  const [discoveredRealtime, setDiscoveredRealtime] = useState<{ tickMs: number | undefined } | null>(null);
  // RM-9: the LATCHED realtime round config — set exactly once at start and
  // cleared on reset. NEVER derived inline in JSX: the frame rebuilds its
  // document when the serialized config changes, so an unstable config would
  // restart the loop on every render.
  const [realtimeRound, setRealtimeRound] = useState<ExperienceLoopConfig | null>(null);
  /** RM-13: the latest loop diagnostics sample from the frame (replace
   *  semantics — the SDK owns the ~1/s cadence and the bounds). Null until
   *  the loop arms; STAYS null when the round never boots (itself a signal
   *  the diagnostics section renders explicitly). */
  const [loopDiag, setLoopDiag] = useState<LoopDiagSample | null>(null);
  /** The finalized round claim (latched once — a duplicate commit is noise). */
  const [roundClaim, setRoundClaim] = useState<ExperienceRoundCommitClaim | null>(null);
  /** Overlay-dismissed flag for the round-finished panel (Reset/Restart stay
   *  the real exit — dismissing only uncovers the frozen visual). */
  const [roundPanelDismissed, setRoundPanelDismissed] = useState(false);
  const [actionType, setActionType] = useState("");
  const [payloadJson, setPayloadJson] = useState("");
  const [requestId, setRequestId] = useState("pg-req-1");
  const [expectedRevision, setExpectedRevision] = useState("0");
  // XU-4: the single-action form's optional participant (the retired tester
  // carried a participant selector; the playground's custom action form gains
  // it, empty = the projection viewer default).
  const [actionParticipantId, setActionParticipantId] = useState("");
  // XU-4: absorbed one-shot tester results (discover / simulate). These run
  // against the STATELESS tester endpoints and are independent of the live
  // playground session (they stay available before/without a session).
  const [testerResult, setTesterResult] = useState<ExperienceTestRunData | null>(null);
  const [simResult, setSimResult] = useState<ExperienceTestSimulateData | null>(null);
  /** Grounding step 7: the seed each diagnostics result RAN with, captured at
   *  request time (the inputs may be edited after the result lands; the shown
   *  seed must stay the one that ran). "" = no seed was sent (the server's
   *  deterministic default). */
  const [testerResultSeed, setTesterResultSeed] = useState("");
  const [simResultSeed, setSimResultSeed] = useState("");
  const [testerBusy, setTesterBusy] = useState<"run" | "simulate" | null>(null);
  const [scriptWarningFlow, setScriptWarningFlow] = useState<ScriptSafetyWarningFlow | null>(null);
  const pendingExplicitActionRef = useRef<(() => void) | null>(null);

  // IR-90E: collapsed Developer diagnostics (novice-readable default).
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // XU-1: which seat's id editor is currently revealed (null = none).
  const [editingIdIndex, setEditingIdIndex] = useState<number | null>(null);
  // XU-3: the launch-setup accordion (expanded until a session becomes live)
  // and the typed-error technical-details disclosure (closed by default).
  // Neither is persisted — both derive from live component state.
  const [setupOpen, setSetupOpen] = useState(true);
  const [errorTechOpen, setErrorTechOpen] = useState(false);
  // IR-90E: auto-derive tracks whether the user has manually modified the
  // roster (once touched, auto-derive never overrides). A RESTORED config
  // (fix item 9a) counts as touched — the persisted roster is the user's
  // explicit choice and must not be re-derived away.
  const [seatsTouched, setSeatsTouched] = useState(() => (scriptId !== undefined && loadPlaygroundConfig(scriptId) !== null));
  const [deriving, setDeriving] = useState(false);
  // The LAST SUCCESSFUL discovery's declared capabilities (null = none: failed
  // or SS-7B2-skipped). Feeds the setup-mismatch check and the reset.
  const [declaredCapabilities, setDeclaredCapabilities] = useState<string[] | null>(null);
  // Live mirror for the discovery callbacks: the reset flips seatsTouched back
  // to false and must NOT re-fire the discovery (it is a dep of the effect).
  const seatsTouchedRef = useRef(seatsTouched);
  seatsTouchedRef.current = seatsTouched;

  // Isolated frame wiring. The bridge captures its callbacks at creation, so
  // the frame-facing handlers delegate through refs (the IR-73B seam pattern);
  // the frame is keyed by playgroundSessionId so every session gets a fresh
  // bridge + document.
  const frameRef = useRef<ExperienceFrameHandle>(null);
  const [frameReady, setFrameReady] = useState(false);
  const sessionRef = useRef<ExperiencePlaygroundData | null>(null);
  sessionRef.current = session;
  // RM-9: the bridge captures its callbacks ONCE per session (IR-73B), so
  // realtime-aware handlers read live state through refs, never closures.
  const realtimeRoundRef = useRef<ExperienceLoopConfig | null>(null);
  realtimeRoundRef.current = realtimeRound;
  const seatsRef = useRef(seats);
  seatsRef.current = seats;
  // LOBBY-A: the latest settings JSON for the discovery callback — the
  // write-through default seeding runs inside the discovery then-block, which
  // closes over the render-time string.
  const settingsJsonRef = useRef(settingsJson);
  settingsJsonRef.current = settingsJson;
  // XU-3: previous session-active flag so the launch-setup accordion collapses
  // exactly when a session becomes live (and re-expands on reset).
  const prevSessionActive = useRef(false);

  const participants: ExperienceParticipant[] = seats
    .filter((seat) => seat.id.trim() !== "")
    .map((seat) => ({
      id: seat.id.trim(),
      label: seat.label.trim() === "" ? seat.id.trim() : seat.label.trim(),
      controller: seat.controller,
      ...(seat.controller === EXPERIENCE_CONTROLLER.model && seat.providerProfileId !== undefined
        ? { providerProfileId: seat.providerProfileId }
        : {}),
      ...(seat.controller === EXPERIENCE_CONTROLLER.model && seat.modelId !== undefined
        ? { modelId: seat.modelId }
        : {}),
    }));

  useEffect(() => {
    if (onLaunchContextChange === undefined) return;
    const parsed = parseOptionalJsonDiagnosed(settingsJson);
    const parsedSettings = parsed.ok
      ? parsed.present
        ? asSettingsObject(parsed.value)
        : {}
      : null;
    const activeSeed = randomStart ? lastUsedSeed.trim() : seed.trim();
    onLaunchContextChange({
      participants,
      capabilityGrants: [...grants],
      ...(parsedSettings !== null ? { settings: parsedSettings } : {}),
      ...(activeSeed !== "" ? { seed: activeSeed } : {}),
      ...(humanSeatId !== "" ? { humanSeatId } : {}),
    });
  }, [participants, grants, settingsJson, seed, lastUsedSeed, randomStart, humanSeatId, onLaunchContextChange]);

  const updateSeat = (index: number, patch: Partial<PlaygroundSeat>) => {
    setSeatsTouched(true);
    setSeats((prev) => prev.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)));
  };

  /** Label change with auto-id tracking: while a seat's id is still
   *  auto-managed (never hand-edited), regenerate it from the new name,
   *  deduping against every OTHER seat. Hand-edited and restored seats keep
   *  their id verbatim. */
  const updateSeatLabel = (index: number, label: string) => {
    setSeatsTouched(true);
    setSeats((prev) =>
      prev.map((seat, i) => {
        if (i !== index) return seat;
        if (seat.idAuto !== true) return { ...seat, label };
        const taken = new Set(prev.filter((_, j) => j !== index).map((s) => s.id));
        return { ...seat, label, id: uniqueIdFor(slugifyId(label), taken), idAuto: true };
      }),
    );
  };

  /** Hand-editing the id breaks auto-tracking permanently: the id becomes the
   *  user's explicit choice, so renames no longer regenerate it. */
  const updateSeatId = (index: number, id: string) => {
    setSeatsTouched(true);
    setSeats((prev) => prev.map((seat, i) => (i === index ? { ...seat, id, idAuto: false } : seat)));
  };

  // Fix item 9a: persist the test config on every manual change (the mount
  // path above is the only restore point; the save is cheap — the envelope is
  // tiny). Skipped while auto-derive is in flight (seatsTouched false): a
  // derived-not-yet-touched config is not the user's choice yet. Saving on ANY
  // touched change keeps the persisted row in lockstep with what the author
  // sees, so an unmount mid-configuration loses nothing.
  // LOBBY-A: `settingsTouched` extends the gate to settings-only edits (a
  // form/textarea edit persists without freezing the roster auto-derive).
  useEffect(() => {
    if (scriptId === undefined || (!seatsTouched && !settingsTouched)) return;
    savePlaygroundConfig(scriptId, {
      seats: seats.map((seat) => ({
        id: seat.id,
        label: seat.label,
        controller: seat.controller,
        ...(seat.providerProfileId !== undefined ? { providerProfileId: seat.providerProfileId } : {}),
        ...(seat.modelId !== undefined ? { modelId: seat.modelId } : {}),
      })),
      grants,
      seed,
      settingsJson,
      humanSeatId,
      randomStart,
    });
  }, [scriptId, seatsTouched, settingsTouched, seats, grants, seed, settingsJson, humanSeatId, randomStart]);

  const toggleGrant = (capability: ExperienceCapability, checked: boolean) => {
    setSeatsTouched(true);
    setGrants((prev) => (checked ? [...prev, capability] : prev.filter((c) => c !== capability)));
  };

  /** XU-2: toggling "Random start" touches the config so it persists (the save
   *  effect is gated on seatsTouched). */
  const handleRandomStartChange = (checked: boolean) => {
    setSeatsTouched(true);
    setRandomStart(checked);
  };

  // IR-90E: provider/model option loading — see experience-playground-model-options.ts.
  const { providerOptions, loadingProfiles, ensureModels, modelOptionsFor } = usePlaygroundModelOptions(seats);

  // ── LOBBY-A: the setup form over the settings JSON ────────────────────────
  //
  // The settings JSON string stays the single source of truth (persisted by
  // the save effect above, sent by start/discover/simulate below). The
  // declared-fields form RENDERS it (derived values, no duplicate form state)
  // and every edit writes back into it — textarea, persisted config, and
  // launch payload can never drift apart. `null` = the JSON is not a plain
  // object (broken or array/scalar): the form is unavailable then, the raw
  // JSON path applies as before LOBBY-A.
  const settingsObject = useMemo<Record<string, unknown> | null>(() => {
    const parsed = parseOptionalJsonDiagnosed(settingsJson);
    if (!parsed.ok) return null;
    if (!parsed.present) return {};
    return asSettingsObject(parsed.value);
  }, [settingsJson]);

  const setupFormAvailable = setupFields.length > 0 && settingsObject !== null;

  const setupForm = useMemo(
    () => deriveSetupValuesFromSettings(setupFields, settingsObject ?? {}),
    [setupFields, settingsObject],
  );

  /** LOBBY-A: write the package's declared ABSENT defaults into the settings
   *  JSON (write-through seeding — what the textarea shows is what Start
   *  sends, and the persisted config carries the defaults). Existing explicit
   *  entries are never touched; a no-change merge returns the same reference,
   *  so a hand-formatted JSON body is not rewritten. Runs from the discovery
   *  then-block only (a discovery event), never as a continuous normalizer —
   *  re-adding a key the user is mid-deleting in the advanced textarea would
   *  fight their editing. */
  const seedDefaultsIntoSettings = (fields: SetupField[]) => {
    if (fields.length === 0) return;
    const parsed = parseOptionalJsonDiagnosed(settingsJsonRef.current);
    if (!parsed.ok) return; // broken JSON — user is mid-edit; leave it alone
    const base = parsed.present ? asSettingsObject(parsed.value) : {};
    if (base === null) return;
    const merged = mergeAbsentSetupDefaults(base, fields);
    if (merged !== base) setSettingsJson(JSON.stringify(merged));
  };

  // SS-7B2 (SCRIPT_SAFETY_PLAN): the debounced discovery below is AUTOMATIC
  // script execution — it routes through the shared scriptExecutionGuard, so
  // an imported never-enabled script sends NO discovery request and renders
  // the shared localized auto-skip state instead (explicit Validate / Start /
  // Restart / Discover / Auto-run stay untouched — they are SS-7B4). The
  // decision derives from the script's trust fields only and is reduced to a
  // boolean before it reaches the effect deps, so the unstable merged-record
  // identity threaded from the editor cannot re-fire the discovery. The
  // automatic branch of the guard never consults the suppress flag; null is
  // the honest "not loaded here" value.
  const autoDiscoveryDecision = scriptExecutionGuard({
    script: script ?? null,
    code,
    kind: "interactive",
    intent: "automatic",
    suppressImportWarnings: null,
  });
  const autoDiscoverySkipped = autoDiscoveryDecision.kind === "skip-auto";

  /** SS-7B4: explicit Try actions use the same trust/findings decision as the
   * editor validation. Stateless endpoints deliberately receive no acknowledgement. */
  const runExplicitAction = (action: () => void) => {
    const decision = scriptExecutionGuard({
      script: script ?? null,
      code,
      kind: "interactive",
      intent: "explicit",
      suppressImportWarnings: useScriptSafetySettingsStore.getState().suppressImportWarnings,
    });
    if (decision.kind === "ok") {
      action();
      return;
    }
    if (decision.kind === "warn") {
      pendingExplicitActionRef.current = action;
      setScriptWarningFlow(decision.flow);
    }
  };

  const confirmExplicitAction = () => {
    const action = pendingExplicitActionRef.current;
    pendingExplicitActionRef.current = null;
    setScriptWarningFlow(null);
    action?.();
  };

  const cancelExplicitAction = () => {
    pendingExplicitActionRef.current = null;
    setScriptWarningFlow(null);
  };

  const showExplicitFindingInCode = (line: number) => {
    cancelExplicitAction();
    onShowInCode?.(line);
  };

  // IR-90E: auto-derive an ordinary setup (roster + grants) from the discovered
  // definition when the panel opens and the user hasn't manually configured
  // seats. Uses the REAL discovery through the discover-only endpoint (not
  // brittle text parsing). It never runs `create`, so rules whose `create`
  // uses context.random / context.participants still discover without grants
  // — the pre-fix /test/run call executed `create` with no grants and fell
  // back to the default for them. Discovery failure (broken rules) explicitly
  // restores the safe default single human seat plus empty grants.
  // LOBBY-A: the discovery is (a) DEBOUNCED — the unsaved rules buffer changes
  // per keystroke, and the pre-LOBBY-A effect fired a compile on each one —
  // and (b) no longer skipped for a user-owned roster: it ALWAYS captures the
  // declared setup fields (the launch form) so a RESTORED config (seatsTouched)
  // gets the form too. Only the roster/grant derivation stays gated on the
  // untouched flag.
  useEffect(() => {
    if (code.trim() === "") { setDeclaredCapabilities(null); return; }
    // SS-7B2: untrusted imports never run the automatic discovery — the
    // shared localized auto-skip state replaces the discovery-driven UI.
    if (autoDiscoverySkipped) { setDeclaredCapabilities(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setDeriving(true);
      discoverExperience({ rulesCode: code })
        .then((data) => {
          if (cancelled) return;
          const fields = data.definition.setup?.fields ?? [];
          setSetupFields(fields);
          seedDefaultsIntoSettings(fields);
          // RM-9: mode tracking is independent of roster ownership — it must
          // update even for a user-owned roster (before the early return).
          const manifest = data.definition.manifest;
          setDiscoveredRealtime(manifest.mode === "realtime" ? { tickMs: manifest.tickMs } : null);
          const declared = data.definition.declaredCapabilities.map((c) => c.capability);
          setDeclaredCapabilities(declared);
          if (seatsTouchedRef.current) return; // roster/grants are the user's explicit choice
          const derived = deriveDefaultLaunchContext(declared);
          setGrants(derived.capabilityGrants);
          setSeats(derived.participants);
        })
        .catch(() => {
          if (cancelled) return;
          // Discovery failed (broken rules): no setup fields (the JSON textarea
          // fallback applies) and the safe default single human seat plus empty
          // grants — but never clobber a user-owned roster.
          setSetupFields([]);
          setDiscoveredRealtime(null);
          setDeclaredCapabilities(null);
          if (seatsTouchedRef.current) return;
          setSeats([...DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT.participants]);
          setGrants([...DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT.capabilityGrants]);
        })
      .finally(() => { if (!cancelled) setDeriving(false); });
    }, DISCOVERY_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, autoDiscoverySkipped]);

  /** Reset the launch setup to the app's defaults: drop the persisted config,
   *  re-derive roster + grants from the LAST discovery (no request), re-seed the
   *  setup fields' defaults, and hand both ownership flags back to the
   *  auto-derive. Seed / random-start are not reset; a live session is untouched. */
  const handleResetSetup = () => {
    if (scriptId !== undefined) clearPlaygroundConfig(scriptId);
    const defaults = declaredCapabilities === null
      ? DEFAULT_BROKEN_RULES_LAUNCH_CONTEXT
      : deriveDefaultLaunchContext(declaredCapabilities);
    setSeats([...defaults.participants]);
    setGrants([...defaults.capabilityGrants]);
    setHumanSeatId("");
    setSettingsJson("");
    settingsJsonRef.current = "";
    setFieldErrors({});
    seedDefaultsIntoSettings(setupFields);
    setSeatsTouched(false);
    setSettingsTouched(false);
  };

  /** The ONE advance path (host chrome AND frame actions): apply one human
   *  action to the live session, then let the driver advance script seats.
   *  Stable (refs + setState only) so the bridge closure never strands. */
  const advanceWith = useCallback(
    async (humanAction: ExperiencePlaygroundAdvanceRequest["humanAction"]): Promise<AdvanceOutcome> => {
      const current = sessionRef.current;
      if (current === null) {
        return { ok: false, error: { message: t("experience_playground_no_session"), console: [] } };
      }
      setBusy("advance");
      setError(null);
      try {
        const data = await advanceExperiencePlayground({
          playgroundSessionId: current.playgroundSessionId,
          humanAction,
        });
        setSession(data);
        // Grounding step 6: advance responses carry only THIS turn's
        // events/effects/console — stitch them onto the session log (one human
        // turn applied).
        setSessionLog((prev) => ({
          events: [...prev.events, ...data.events],
          effects: [...prev.effects, ...data.effects],
          console: [...prev.console, ...data.console],
          turns: prev.turns + 1,
        }));
        return { ok: true, data };
      } catch (advanceError) {
        const view = toPlaygroundError(advanceError);
        setError(view);
        return { ok: false, error: view };
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  /** LOBBY-A: one shared settings-resolution path for start/discover/simulate.
   *  Parses the settings JSON (the single source of truth). When the package
   *  declares setup fields AND the JSON is a plain object, the declared fields
   *  go through validateSetupFields — per-field errors paint inline and the
   *  launch is blocked — and are sent with the modal's omission semantics
   *  (untouched optional empties absent, authored defaults present);
   *  undeclared extra keys ride along untouched. Broken/non-object JSON keeps
   *  the pre-LOBBY-A behavior (sent verbatim / rejected by the schema). */
  const buildLaunchSettings = ():
    | { ok: true; value: unknown }
    | { ok: false; message: string } => {
    const parsed = parseOptionalJsonDiagnosed(settingsJson);
    if (!parsed.ok) {
      return { ok: false, message: `${t("experience_tester_settings_invalid")} — ${parsed.diagnostic}` };
    }
    if (!parsed.present) return { ok: true, value: {} };
    if (setupFields.length === 0 || settingsObject === null) {
      return { ok: true, value: parsed.value };
    }
    const validated = validateSetupFields({ fields: setupFields, values: setupForm.values, entered: setupForm.entered, t });
    if (!validated.ok) {
      setFieldErrors(validated.errors);
      return { ok: false, message: t("experience_playground_settings_field_errors") };
    }
    // A pass must clear the painted errors too: a failed launch can be fixed
    // through the advanced JSON textarea (applySetupFieldValue never runs),
    // and a stale inline error would survive the successful relaunch.
    setFieldErrors({});
    const extras = { ...settingsObject };
    for (const field of setupFields) delete extras[field.id];
    return { ok: true, value: { ...extras, ...validated.settings } };
  };

  /** LOBBY-A: one setup-field edit → merge into the settings JSON (the source
   *  of truth). Absent semantics (no-default boolean uncheck) deletes the key;
   *  numbers are stored as JSON numbers; undeclared extra keys ride along. */
  const applySetupFieldValue = (field: SetupField, raw: string | number | boolean | undefined) => {
    const base = settingsObject ?? {};
    let next: Record<string, unknown>;
    if (raw === undefined) {
      const { [field.id]: _removed, ...rest } = base;
      next = rest;
    } else {
      next = { ...base, [field.id]: field.kind === "number" ? Number(raw) : raw };
    }
    setSettingsTouched(true);
    setSettingsJson(JSON.stringify(next));
    setFieldErrors((prev) => {
      if (!(field.id in prev)) return prev;
      const reduced = { ...prev };
      delete reduced[field.id];
      return reduced;
    });
  };

  /** LOBBY-A: boolean toggle with the modal's semantics — a no-default boolean
   *  cycles absent ↔ true (unchecking restores absence); a defaulted boolean
   *  writes an explicit true/false. */
  const toggleSetupBoolean = (field: SetupField) => {
    if (field.kind !== "boolean") return;
    const current = setupForm.values[field.id];
    if (field.default === undefined) {
      applySetupFieldValue(field, current === true ? undefined : true);
    } else {
      applySetupFieldValue(field, !(current === true));
    }
  };

  /** Start a fresh ephemeral session from the CURRENT UNSAVED buffers. */
  const handleStart = async () => {
    const settings = buildLaunchSettings();
    if (!settings.ok) {
      setError({ message: settings.message, console: [] });
      return;
    }
    // XU-2: a fresh random seed per launch when the toggle is ON; OFF keeps the
    // manual seed path verbatim (empty = the server deterministic default).
    const launchSeed = randomStart ? String(Math.floor(Math.random() * 2 ** 31)) : seed.trim();
    if (randomStart) setLastUsedSeed(launchSeed);
    setBusy("start");
    setError(null);
    setFrameReady(false);
    try {
      const data = await startExperiencePlayground({
        rulesCode: code,
        settings: settings.value,
        participants,
        capabilityGrants: [...grants],
        ...(launchSeed !== "" ? { seed: launchSeed } : {}),
        ...(humanSeatId !== "" ? { humanSeatId } : {}),
      });
      setSession(data);
      setDefinition(data.definition ?? null);
      setAppliedCount(0);
      setRequestId("pg-req-1");
      setExpectedRevision(String(data.revision));
      // Grounding step 6: the log starts from THIS session's start envelope
      // (start carries every event so far) and the launch context is captured
      // as actually sent — the exact roster/grants/seed the session ran with.
      setSessionLog({ events: data.events, effects: data.effects, console: data.console, turns: 0 });
      setLogLaunchContext({
        participants,
        capabilityGrants: [...grants],
        ...(launchSeed !== "" ? { seed: launchSeed } : {}),
        ...(humanSeatId !== "" ? { humanSeatId } : {}),
      });
      // RM-9: realtime mode latches the frame loop config — from here the
      // round runs entirely INSIDE the sandboxed frame (no advance/timer
      // round-trips; the server start above only ran `create` in the real
      // sandbox and echoed the resolved numeric seed).
      if (discoveredRealtime !== null) {
        const built = buildRealtimeLoopConfig({
          rulesSource: code,
          tickMs: discoveredRealtime.tickMs,
          initialState: data.state,
          initialSettings: settings.value,
          seed: data.seed,
          seats,
          humanSeatId,
        });
        if (!built.ok) {
          setSession(null);
          setDefinition(null);
          setSessionLog(EMPTY_SESSION_LOG);
          setLogLaunchContext(null);
          setError({ message: built.message, console: [] });
          return;
        }
        setRealtimeRound(built.config);
        setLoopDiag(null);
        setRoundClaim(null);
        setRoundPanelDismissed(false);
      }
    } catch (startError) {
      setSession(null);
      setDefinition(null);
      setSessionLog(EMPTY_SESSION_LOG);
      setLogLaunchContext(null);
      setError(toPlaygroundError(startError));
    } finally {
      setBusy(null);
    }
  };

  /** Reset: tear the session + frame down client-side. No draft or store is
   *  touched (this panel holds none); the server-side session is ephemeral. */
  const handleReset = () => {
    setSession(null);
    setDefinition(null);
    setError(null);
    setBusy(null);
    setAppliedCount(0);
    setActionType("");
    setPayloadJson("");
    setRequestId("pg-req-1");
    setExpectedRevision("0");
    setFrameReady(false);
    // Grounding step 6: Reset also clears the whole-session log and its
    // captured launch context — the next session's log starts clean.
    setSessionLog(EMPTY_SESSION_LOG);
    setLogLaunchContext(null);
    // RM-9: a reset also buries the round — the latched loop config and any
    // finished-round claim go with the session (the frame unmounts, so the
    // loop dies with it; a stopped round is lost by design).
    setRealtimeRound(null);
    setLoopDiag(null);
    setRoundClaim(null);
    setRoundPanelDismissed(false);
  };

  /** Fix item 9b: one-click restart with the SAME settings — re-runs Start
   *  from the CURRENT rules buffer with the CURRENT config, replacing the
   *  Reset → Start → re-configure loop of iterative testing. */
  const handleRestart = () => {
    handleReset();
    void handleStart();
  };

  /** Submit one action from the host chrome (legal-action button or the custom
   *  form), building the CAS pair from the editable requestId/expectedRevision
   *  fields. On success the form advances to the next requestId + the live
   *  revision; on a typed failure nothing is applied. */
  const submitAction = async (type: string, participantId?: string, payload?: { present: boolean; value?: unknown }) => {
    const revision = Number.parseInt(expectedRevision, 10);
    if (!Number.isInteger(revision) || revision < 0 || String(revision) !== expectedRevision.trim()) {
      setError({ message: t("experience_tester_action_revision_invalid"), console: [] });
      return;
    }
    const outcome = await advanceWith({
      type,
      requestId: requestId.trim() !== "" ? requestId.trim() : `pg-req-${appliedCount + 1}`,
      expectedRevision: revision,
      ...(participantId !== undefined ? { participantId } : {}),
      ...(payload?.present === true ? { payload: payload.value } : {}),
    });
    if (outcome.ok) {
      setAppliedCount(appliedCount + 1);
      setRequestId(`pg-req-${appliedCount + 2}`);
      setExpectedRevision(String(outcome.data.revision));
      setActionType("");
      setPayloadJson("");
      setActionParticipantId("");
    }
  };

  /** Custom-action form submit (payload validated locally first). XU-4: an
   *  optional participant from the roster joins the existing fields; empty =
   *  the projection-viewer default. */
  const handleApplyAction = async () => {
    const type = actionType.trim();
    if (type === "") return;
    const payload = parseOptionalJsonDiagnosed(payloadJson);
    if (!payload.ok) {
      setError({ message: `${t("experience_tester_action_payload_invalid")} — ${payload.diagnostic}`, console: [] });
      return;
    }
    await submitAction(type, actionParticipantId !== "" ? actionParticipantId : undefined, payload);
  };

  /** Grounding step 7: the seed the stateless diagnostics calls run with —
   *  parity with the launch path (XU-2). "Random start" ON: the LAST
   *  launch's random seed, falling back to the manual seed before anything
   *  was launched (both resolved trimmed, the way the launch path resolves
   *  its own seed); OFF: the manual seed verbatim (the pre-step-7 behavior). */
  const diagnosticsSeed = (): string => {
    if (!randomStart) return seed.trim();
    const last = lastUsedSeed.trim();
    return last !== "" ? last : seed.trim();
  };

  /** XU-4: on-demand create-only discover over the STATELESS tester (the
   *  retired InteractiveTester's run path). Reuses the CURRENT roster/grants/
   *  settings so the diagnostics reflect the same context a start would use,
   *  and runs on {@link diagnosticsSeed} — with "Random start" on, the same
   *  seed the author's current game runs on (grounding step 7), so the result
   *  describes that game rather than a different random draw. */
  const handleDiscover = async () => {
    const settings = buildLaunchSettings();
    if (!settings.ok) {
      setError({ message: settings.message, console: [] });
      return;
    }
    setTesterBusy("run");
    setError(null);
    const runSeed = diagnosticsSeed();
    try {
      const data = await runExperienceTest({
        rulesCode: code,
        settings: settings.value,
        participants,
        capabilityGrants: [...grants],
        ...(runSeed !== "" ? { seed: runSeed } : {}),
        actions: [],
      });
      setTesterResult(data);
      setTesterResultSeed(runSeed);
    } catch (runError) {
      setError(toPlaygroundError(runError));
    } finally {
      setTesterBusy(null);
    }
  };

  /** XU-4: bounded auto-advance of script seats via the STATELESS tester (the
   *  retired InteractiveTester's simulate path), reporting the typed stop
   *  reason. Same context as {@link handleDiscover}. */
  const handleSimulate = async () => {
    const settings = buildLaunchSettings();
    if (!settings.ok) {
      setError({ message: settings.message, console: [] });
      return;
    }
    setTesterBusy("simulate");
    setError(null);
    const simSeed = diagnosticsSeed();
    try {
      const data = await simulateExperienceTest({
        rulesCode: code,
        settings: settings.value,
        participants,
        capabilityGrants: [...grants],
        ...(simSeed !== "" ? { seed: simSeed } : {}),
      });
      setSimResult(data);
      setSimResultSeed(simSeed);
    } catch (simError) {
      setError(toPlaygroundError(simError));
    } finally {
      setTesterBusy(null);
    }
  };

  /** RM-9: the Try-it model seam — stable identity (refs + setState only) so
   *  the bridge closure never strands; the roster is read live through
   *  seatsRef. Mirrors the RM-6 modal contract: resolve to the reply (posted
   *  into the round) or null (fail-closed, nothing enters the frame). */
  const modelSeam = useMemo(
    () =>
      createPlaygroundModelSeam({
        roundModel: runExperienceRoundModel,
        seatProfile: (seatId) => {
          const seat = seatsRef.current.find(
            (s) => s.id === seatId && s.controller === EXPERIENCE_CONTROLLER.model,
          );
          if (seat === undefined || seat.providerProfileId === undefined || seat.modelId === undefined) {
            return null;
          }
          return { providerProfileId: seat.providerProfileId, modelId: seat.modelId };
        },
        onError: (message) => setError({ message, console: [] }),
      }),
    [],
  );

  /** Stable frame-action handler (IR-73B seam): the visual's intention carries
   *  the SDK-filled requestId/expectedRevision and advances the SAME
   *  playground session. Success acks the bridge (sendResult clears the
   *  duplicate-click lock; the session effect below pushes the new view);
   *  failure maps the typed playground error to a bridge code keyed to the
   *  visual requestId so the lock always clears. */
  const handleFrameAction = useCallback(
    async (action: ExperienceActionDto) => {
      // RM-9: a realtime round is driven by the frame loop — a TURN action
      // from the visual (experience.act()) is a mode error, never an advance
      // (the frame loop and the server session must never become two
      // authorities). Fail-closed: the bridge lock clears, nothing applies.
      if (realtimeRoundRef.current !== null) {
        frameRef.current?.sendError("invalid_action", t("experience_playground_realtime_turn_disabled"), {
          requestId: action.requestId,
        });
        return;
      }
      const outcome = await advanceWith(action);
      if (outcome.ok) {
        // IR-90E: synchronize the host's form state so the prominent host
        // legal actions + custom action form do not become stale after a
        // visual-initiated action.
        setAppliedCount((prev) => prev + 1);
        setRequestId(`pg-req-${appliedCount + 2}`);
        setExpectedRevision(String(outcome.data.revision));
        frameRef.current?.sendResult(action.requestId, outcome.data.revision, outcome.data.status);
        return;
      }
      const view = outcome.error;
      frameRef.current?.sendError(
        view.code === "stale_revision" ? "stale_revision" : "invalid_action",
        view.message,
        {
          requestId: action.requestId,
          ...(view.currentRevision !== undefined ? { revision: view.currentRevision } : {}),
        },
      );
    },
    [advanceWith, appliedCount],
  );

  // Push the latest turn's projection into the isolated frame whenever the
  // session advances or the frame completes its handshake. State goes TO the
  // frame through the bridge only — never to the host DOM.
  // RM-9: a realtime round projects INSIDE the frame (the loop runs
  // runProject per animation frame); the host never pushes turn views.
  useEffect(() => {
    if (!frameReady || session === null || realtimeRound !== null) return;
    frameRef.current?.sendState({
      state: session.projection.state,
      actions: session.projection.actions,
      revision: session.revision,
      status: session.status,
    });
  }, [frameReady, session, realtimeRound]);

  // ── Timer beat loop (playground timers) ────────────────────────────────────
  // The sandbox's real-time axis: while the live session reports unconsumed
  // timer effects, issue ONE beat per response — the server sleeps the
  // declared afterMs and feeds the tick back through the real reducer. The
  // loop is fully derived from `session`: every setSession (start, a click, a
  // beat response) re-evaluates it, so ticking continues until the rules stop
  // re-arming timers or the session completes/reset. Beats never set `busy` —
  // host controls stay clickable while the clock runs (a click racing a tick
  // surfaces the typed stale_revision the panel already renders).
  const timerBeats = useRef(new Set<string>());
  useEffect(() => {
    // RM-9: realtime rounds have NO server round-trips — the fixed-timestep
    // loop inside the frame is the only clock. (The turn path below is
    // byte-identical to pre-RM-9; this guard is its only new line.)
    if (realtimeRound !== null) return;
    if (session === null || session.status !== "active" || session.pendingTimers <= 0) return;
    const sessionId = session.playgroundSessionId;
    if (timerBeats.current.has(sessionId)) return;
    timerBeats.current.add(sessionId);
    runExperiencePlaygroundTimer({ playgroundSessionId: sessionId })
      .then((data) => {
        // Apply the beat response only for the SAME session and never below
        // the applied frontier: a beat whose tick stale-dropped under a click
        // returns the click's state (revision equal — harmless), a tick that
        // landed after it returns a newer revision (applied → loop continues).
        // The revision guard also prevents a late response from regressing
        // state after a faster human action. A different session id (reset +
        // restart) drops the response entirely.
        const current = sessionRef.current;
        if (
          current !== null &&
          current.playgroundSessionId === data.playgroundSessionId &&
          data.revision >= current.revision
        ) {
          setSession(data);
          // Grounding step 6: beat responses carry only this beat's
          // events/effects/console — stitch them onto the session log. A tick
          // is not a human turn, so `turns` is untouched. A stale-dropped tick
          // returns empty deltas, so nothing is double-counted.
          setSessionLog((prev) => ({
            events: [...prev.events, ...data.events],
            effects: [...prev.effects, ...data.effects],
            console: [...prev.console, ...data.console],
            turns: prev.turns,
          }));
        }
      })
      .catch((beatError: unknown) => {
        // A typed beat error is a rules fault the author must see (e.g. the
        // reducer rejected its own tick); the loop stops because the failed
        // slot was consumed server-side and `pendingTimers` drops to 0.
        setError(toPlaygroundError(beatError));
      })
      .finally(() => {
        timerBeats.current.delete(sessionId);
      });
  }, [session, realtimeRound]);

  // XU-3: auto-collapse the launch-setup accordion when a session becomes live
  // (derived from session state only; never persisted). The user may re-open it
  // anytime; reset (session → null) restores the expanded default on the next
  // transition.
  useEffect(() => {
    const active = session !== null;
    if (active !== prevSessionActive.current) {
      prevSessionActive.current = active;
      setSetupOpen(!active);
    }
  }, [session]);

  const hasVisual = visualSource !== null && visualSource.trim() !== "";

  // LOBBY-A: the raw settings JSON textarea — the single source of truth the
  // setup form renders and writes into. Rendered under the collapsed
  // "advanced" disclosure when the form is live; directly when it is not
  // (no declared fields / non-object JSON — the pre-LOBBY-A fallback).
  const settingsJsonTextarea = (
    <AutoTextarea
      mono
      className="mt-1.5 min-h-[34px]"
      value={settingsJson}
      onChange={(e) => {
        setSettingsTouched(true);
        setSettingsJson(e.target.value);
      }}
      placeholder="{}"
      minRows={1}
      maxRows={12}
      macroAutocomplete={false}
    />
  );

  // IR-90E: ordinary-language status for the novice-readable default view.
  const statusText = (() => {
    if (session === null) return "";
    if (busy !== null) return t("experience_playground_status_busy");
    // RM-9: a realtime round's lifecycle is the frame loop's, not the turn
    // envelope's — the claim (or its absence) is the honest status.
    if (realtimeRound !== null) {
      return roundClaim !== null
        ? t("experience_round_finished")
        : t("experience_playground_realtime_running");
    }
    if (session.status === "completed") return t("experience_playground_status_completed");
    if (session.stopReason === "awaiting_human") return t("experience_playground_status_your_turn");
    if (session.stopReason === "awaiting_model") return t("experience_playground_status_model");
    if (session.stopReason === "no_legal_action" || session.projection.actions.length === 0) return t("experience_playground_status_waiting");
    return t("experience_playground_status_default");
  })();

  // XU-3: one-line launch-setup summary for the collapsed accordion header.
  // Composed from the roster (label + friendly role) and the random-start flag.
  const setupSummary = [
    ...seats.map((seat) => {
      const name = seat.label.trim() !== "" ? seat.label.trim() : seat.id.trim() !== "" ? seat.id.trim() : "?";
      return `${name} (${t(CONTROLLER_LABEL_KEY[seat.controller])})`;
    }),
    t(randomStart ? "experience_playground_setup_summary_random_on" : "experience_playground_setup_summary_random_off"),
  ].join(" · ");

  /** XU-3: feed a typed error to the copilot. A live session uses the
   *  playground digest (mirrors the diagnostics send path); a failed START has
   *  no session, so it falls back to the run-test error digest (the fail-path
   *  shape). Only wired when the shell provides the callback. RM-13: a live
   *  REALTIME round sends the loop digest (the truthful error context — the
   *  loop errors + console ride the sample). */
  const handleAskCopilotAboutError = () => {
    if (onSendToCopilot === undefined || error === null) return;
    const digest =
      session !== null && realtimeRound !== null
        ? buildRealtimeLoopDigest({
            realtime: { tickMs: realtimeRound.tickMs, seed: realtimeRound.seed },
            diag: loopDiag,
            claim: roundClaim,
            definition,
            error,
          })
        : session !== null
          ? buildPlaygroundDigest({ session, definition, error })
          : buildRunTestErrorDigest(error);
    onSendToCopilot(digest);
  };

  /** XU-4: feed the absorbed tester's discover/simulate digest to the copilot
   *  (the retired tester's ER-14 precedence: discover result → simulate
   *  result). Only wired when the shell provides the callback. */
  const handleSendTesterToCopilot = () => {
    if (onSendToCopilot === undefined) return;
    if (testerResult !== null) {
      onSendToCopilot(buildRunTestDigest(testerResult));
    } else if (simResult !== null) {
      onSendToCopilot(buildSimulateDigest(simResult));
    }
  };

  /** Grounding step 6: the WHOLE-session log digest for the status-strip
   *  "send log" / "copy log" buttons. Turn sessions send the accumulated log
   *  (every event across start + advances + timer beats); a realtime round
   *  sends the loop digest — the frame loop is the round's authority, and the
   *  turn-session shape would lie (RM-13). */
  const buildSessionLogDigest = (live: ExperiencePlaygroundData) =>
    realtimeRound !== null
      ? buildRealtimeLoopDigest({
          realtime: { tickMs: realtimeRound.tickMs, seed: realtimeRound.seed },
          diag: loopDiag,
          claim: roundClaim,
          definition,
          error,
        })
      : buildPlaygroundLogDigest({
          session: live,
          sessionLog,
          definition,
          error,
          launchContext: logLaunchContext,
        });

  /** Grounding step 6: push the whole-session log into the copilot thread. */
  const handleSendLogToCopilot = () => {
    if (onSendToCopilot === undefined || session === null) return;
    onSendToCopilot(buildSessionLogDigest(session));
  };

  /** Grounding step 6: copy the log digest's FULL text to the clipboard with
   *  the honest result feedback (the TrackerConfig copy pattern). */
  const handleCopyLog = async () => {
    if (session === null) return;
    const result = await copyText(buildSessionLogDigest(session).fullText);
    if (result.ok) {
      toast.success(t("copied"));
    } else {
      toast.error(t("experience_playground_copy_log_failed"));
    }
  };

  return (
    <div data-testid="experience-playground" className="rounded-lg border border-border bg-s2 p-3">
      <div>
          {/* Play context: roster + capability grants + seed + settings + seat —
              collapsed into a summary accordion (XU-3). */}
          <div className="mb-3 rounded-md border border-border bg-bg p-3">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 text-left"
              onClick={() => setSetupOpen((v) => !v)}
              aria-expanded={setupOpen}
            >
              <span className={cn("inline-block shrink-0 text-t3 transition-transform", setupOpen && "rotate-90")}>
                {Ic.caret("r")}
              </span>
              <span className={cn(blockLabelCls, "shrink-0")}>{t("experience_playground_setup_title")}</span>
              {!setupOpen && (
                <span className="min-w-0 truncate font-ui text-[11px] text-t3" data-testid="playground-setup-summary">
                  {setupSummary}
                </span>
              )}
            </button>
            <PlaygroundSetupCheck
              declaredCapabilities={declaredCapabilities}
              participants={participants}
              grants={grants}
              onReset={handleResetSetup}
            />
            <AnimatedDisclosure open={setupOpen} className="mt-3 space-y-3">
            {/* Participants roster editor — see experience-playground-roster.tsx. */}
            <PlaygroundRoster
              seats={seats}
              grants={grants}
              editingIdIndex={editingIdIndex}
              setEditingIdIndex={setEditingIdIndex}
              setSeats={setSeats}
              setSeatsTouched={setSeatsTouched}
              updateSeat={updateSeat}
              updateSeatLabel={updateSeatLabel}
              updateSeatId={updateSeatId}
              providerOptions={providerOptions}
              loadingProfiles={loadingProfiles}
              ensureModels={ensureModels}
              modelOptionsFor={modelOptionsFor}
            />

          <div>
            <label className={lblCls}>{t("experience_playground_capabilities_title")}</label>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {CAPABILITIES.map((capability) => (
                <Checkbox
                  key={capability}
                  checked={grants.includes(capability)}
                  onChange={(checked) => toggleGrant(capability, checked)}
                  label={
                    <span className="flex items-center gap-1">
                      <span className="text-[13px]">{t(CAPABILITY_LABEL_KEY[capability])}</span>
                      <CustomTooltip content={capability}>
                        <span className="cursor-help text-[12px] text-t4">ⓘ</span>
                      </CustomTooltip>
                    </span>
                  }
                  className="font-ui text-[12px]"
                />
              ))}
            </div>
          </div>

          <PlaygroundStartOptions
            seed={seed}
            onSeedChange={setSeed}
            randomStart={randomStart}
            lastUsedSeed={lastUsedSeed}
            onRandomStartChange={handleRandomStartChange}
            humanSeatId={humanSeatId}
            onHumanSeatChange={setHumanSeatId}
            participants={participants}
          />
          <div className="mt-2">
            <label className={lblCls}>{t("experience_setup_settings_label")}</label>
            {/* SS-7B2: the shared localized auto-skip state — an untrusted
                import's automatic discovery is skipped, so this line replaces
                the discovery-driven form / no-fields UI (the advanced JSON
                disclosure below stays reachable for technical users). */}
            {autoDiscoverySkipped && (
              <p className="mt-1.5 font-ui text-[11px] leading-relaxed text-t3" data-testid="playground-auto-skip">
                {t(SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY)}
              </p>
            )}
            {/* LOBBY-A: the package's declared setup fields render as a real
                form (author defaults seeded into the JSON). The raw JSON
                textarea is ALWAYS under a collapsed "advanced" disclosure
                (verbatim: hide the JSON for technical users under an
                accordion) — never the default view, fields or not. */}
            {setupFormAvailable && (
              <div className="mt-1.5 flex flex-col gap-2.5" data-testid="playground-setup-form">
                {setupFields.map((field) => (
                  <SetupFieldRow
                    key={field.id}
                    field={field}
                    value={setupForm.values[field.id]}
                    error={fieldErrors[field.id]}
                    t={t}
                    onText={(v) => applySetupFieldValue(field, v)}
                    onNumber={(v) => applySetupFieldValue(field, v)}
                    onToggle={() => toggleSetupBoolean(field)}
                    onSelect={(v) => applySetupFieldValue(field, v)}
                  />
                ))}
              </div>
            )}
            {!autoDiscoverySkipped && setupFields.length === 0 && (
              <p className="mt-1.5 font-ui text-[11px] leading-relaxed text-t3" data-testid="playground-no-fields">
                {t("experience_playground_no_fields")}
              </p>
            )}
            {setupFields.length > 0 && settingsObject === null && (
              <p className="mt-1.5 font-ui text-[11px] leading-relaxed text-danger-text" role="alert">
                {t("experience_playground_settings_json_invalid")}
              </p>
            )}
            {/* The raw JSON is ALWAYS under the collapsed "advanced"
                disclosure — with or without declared fields (verbatim quote:
                "hide the JSON for technical users under an accordion");
                a non-technical user never faces a raw textarea by default. */}
            <div className="mt-1.5">
              <button
                type="button"
                className="flex cursor-pointer items-center gap-1.5 font-ui text-[11px] text-t3 transition-colors hover:text-t1"
                onClick={() => setSettingsJsonOpen((v) => !v)}
                aria-expanded={settingsJsonOpen}
                data-testid="playground-settings-advanced-toggle"
              >
                <span className={cn("inline-block shrink-0 transition-transform", settingsJsonOpen && "rotate-90")}>
                  {Ic.caret("r")}
                </span>
                {t("experience_playground_settings_advanced")}
              </button>
              <AnimatedDisclosure open={settingsJsonOpen}>
                {settingsJsonTextarea}
              </AnimatedDisclosure>
            </div>
          </div>
          <PlaygroundSetupResetButton onReset={handleResetSetup} testId="playground-setup-reset" />
            </AnimatedDisclosure>
          </div>

          {/* Session controls: the prominent primary play action (XU-3). */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
              disabled={busy !== null || code.trim() === ""}
              onClick={() => runExplicitAction(() => { void handleStart(); })}
            >
              {Ic.caret("r")}
              {t("experience_playground_start")}
            </button>
            {busy !== null && <span className="font-ui text-[12px] text-t3">{t("script_running")}</span>}
          </div>

          {/* Typed error panel — see experience-playground-error.tsx. */}
          {error !== null && (
            <PlaygroundErrorPanel
              error={error}
              errorTechOpen={errorTechOpen}
              setErrorTechOpen={setErrorTechOpen}
              onAskCopilot={onSendToCopilot === undefined ? undefined : handleAskCopilotAboutError}
            />
          )}

          {/* Live session — novice-readable default: visual-first, status,
              legal actions. Raw diagnostics behind collapsed disclosure. */}
          {session !== null && (
            <div className="mt-3 space-y-3">
              {/* Ordinary-language status + session controls (XU-3): restart/
                  reset live next to the active-session status strip. */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-s3" style={{ padding: 8 }}>
                <span className="font-ui text-[12px] text-t2">{statusText}</span>
                {realtimeRound !== null && (
                  <span
                    data-testid="playground-realtime-badge"
                    className="rounded bg-accent-dim px-1.5 py-0.5 font-ui text-[10px] text-accent-t"
                  >
                    {t("experience_playground_realtime_badge")}
                  </span>
                )}
                {busy !== null && <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {onSendToCopilot !== undefined && (
                    <button
                      type="button"
                      data-testid="playground-send-log"
                      className="h-8 cursor-pointer rounded-md border border-border bg-bg px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                      disabled={busy !== null}
                      onClick={handleSendLogToCopilot}
                    >
                      {t("experience_playground_send_log")}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="playground-copy-log"
                    className="h-8 cursor-pointer rounded-md border border-border bg-bg px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={() => { void handleCopyLog(); }}
                  >
                    {t("experience_playground_copy_log")}
                  </button>
                  <button
                    type="button"
                    className="h-8 cursor-pointer rounded-md border border-border bg-bg px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={() => runExplicitAction(handleRestart)}
                  >
                    {t("experience_playground_restart")}
                  </button>
                  <button
                    type="button"
                    className="h-8 cursor-pointer rounded-md border border-border bg-bg px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={handleReset}
                  >
                    {t("experience_playground_reset")}
                  </button>
                </div>
              </div>

              {/* LB-6 (EXPERIENCE_ENGINE_LOBBY_REPORT): the post-game strip — a
                  DISTINCT prominent completed-state surface next to the status
                  line. "Play again" restarts with the SAME settings/seats/roster
                  and a fresh seed (handleRestart); "Change settings" tears
                  the run down to the expanded setup state (handleReset). The
                  header restart/reset buttons stay (pre/post-game utility).
                  RM-9: turn-only — a realtime round's end surface is the
                  round-finished panel over the visual. */}
              {realtimeRound === null && session.status === "completed" && (
                <div
                  data-testid="playground-postgame-strip"
                  className="flex flex-wrap items-center gap-2 rounded-md border border-accent bg-accent-dim"
                  style={{ padding: 10 }}
                >
                  <span className={cn(blockLabelCls, "text-accent-t")}>
                    {t("experience_playground_postgame_title")}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                      disabled={busy !== null}
                      onClick={() => runExplicitAction(handleRestart)}
                    >
                      {t("experience_restart_play_again")}
                    </button>
                    <button
                      type="button"
                      className="h-8 cursor-pointer rounded-md border border-border bg-bg px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                      disabled={busy !== null}
                      onClick={handleReset}
                    >
                      {t("experience_restart_change_settings")}
                    </button>
                  </div>
                </div>
              )}

              {/* The REAL visual against the current playground state — primary view. */}
              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_playground_visual_label")}</div>
                {hasVisual ? (
                  <div className="relative mt-2 rounded-md border border-border bg-bg" style={{ padding: 8 }}>
                    <ExperienceFrame
                      key={session.playgroundSessionId}
                      ref={frameRef}
                      visualSource={visualSource}
                      sessionId={`playground-${session.playgroundSessionId}`}
                      initialRevision={session.revision}
                      onReady={() => setFrameReady(true)}
                      onAction={(action) => void handleFrameAction(action)}
                      onError={() => {}}
                      realtime={realtimeRound !== null ? { config: realtimeRound } : undefined}
                      onModelRequest={(req: ExperienceModelSeatRequest) => {
                        // RM-9: the seam resolves to the reply (posted into the
                        // round) or null (fail-closed — nothing enters the
                        // frame and the round simply lives without it).
                        void modelSeam(req).then((result) => {
                          if (result !== null && result !== undefined) {
                            frameRef.current?.sendModelResult(req.seatId, result, req.requestId);
                          }
                        });
                      }}
                      onRoundCommit={(claim: ExperienceRoundCommitClaim) => {
                        // RM-9: Try-it NEVER commits anywhere (the playground
                        // session is ephemeral process memory) — the claim only
                        // latches the terminal panel. First commit wins.
                        setRoundClaim((prev) => prev ?? claim);
                      }}
                      onLoopDiag={setLoopDiag}
                    />
                    {realtimeRound !== null && roundClaim !== null && !roundPanelDismissed && (
                      <ExperienceRoundFinishedPanel
                        claim={roundClaim}
                        onClose={() => setRoundPanelDismissed(true)}
                        testId="playground-round-finished"
                      />
                    )}
                  </div>
                ) : (
                  <>
                    <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_playground_no_visual")}</p>
                    {realtimeRound !== null && (
                      <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_playground_realtime_no_visual")}</p>
                    )}
                  </>
                )}
              </div>

              {/* Legal actions — prominent one-click buttons (the novice interaction).
                  RM-9: turn-only chrome — a realtime round is played inside the
                  visual (experience.actLocal), never through host turn buttons. */}
              {realtimeRound === null && (
              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_playground_turn_title")}</div>
                {session.projection.actions.length === 0 ? (
                  <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_tester_no_actions")}</p>
                ) : (
                  <>
                    <p className="mt-1 font-ui text-[11px] text-t3">{t("experience_playground_legal_hint")}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {session.projection.actions.map((action, i) => (
                        <button
                          key={i}
                          type="button"
                          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => void submitAction(action.type, action.participantId)}
                        >
                          <span className="rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-accent-t">{action.type}</span>
                          {action.label !== undefined && <span>{action.label}</span>}
                          {action.participantId !== undefined && <span className="font-mono text-[10px] text-t3">@{action.participantId}</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              )}
            </div>
          )}

          {/* Developer diagnostics disclosure — see experience-playground-diagnostics.tsx. */}
          <PlaygroundDiagnostics
            code={code}
            diagnosticsOpen={diagnosticsOpen}
            setDiagnosticsOpen={setDiagnosticsOpen}
            busy={busy}
            testerBusy={testerBusy}
            runExplicitAction={runExplicitAction}
            handleDiscover={handleDiscover}
            handleSimulate={handleSimulate}
            testerResult={testerResult}
            testerResultSeed={testerResultSeed}
            simResult={simResult}
            simResultSeed={simResultSeed}
            onSendToCopilot={onSendToCopilot}
            handleSendTesterToCopilot={handleSendTesterToCopilot}
            session={session}
            definition={definition}
            error={error}
            realtimeRound={realtimeRound}
            loopDiag={loopDiag}
            roundClaim={roundClaim}
            participants={participants}
            actionType={actionType}
            setActionType={setActionType}
            actionParticipantId={actionParticipantId}
            setActionParticipantId={setActionParticipantId}
            requestId={requestId}
            setRequestId={setRequestId}
            expectedRevision={expectedRevision}
            setExpectedRevision={setExpectedRevision}
            payloadJson={payloadJson}
            setPayloadJson={setPayloadJson}
            handleApplyAction={handleApplyAction}
          />
        </div>
      {scriptWarningFlow?.kind === "plain" && (
        <ImportedScriptWarningModal
          intent="test"
          onConfirm={confirmExplicitAction}
          onCancel={cancelExplicitAction}
        />
      )}
      {scriptWarningFlow?.kind === "findings" && (
        <FindingsWarningModal
          findings={scriptWarningFlow.findings}
          showHonestWarning={scriptWarningFlow.showHonestWarning}
          intent="test"
          onShowInCode={showExplicitFindingInCode}
          onConfirm={confirmExplicitAction}
          onCancel={cancelExplicitAction}
        />
      )}
    </div>
  );
}
