/**
 * ExperiencePlayground — the interactive play-loop authoring surface
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-84B).
 *
 * Mounted by the ExperienceEditor as a peer of the IR-81D InteractiveTester
 * and fed BOTH unsaved buffers via props: the CURRENT UNSAVED rules buffer
 * (`code`) and the CURRENT UNSAVED visual source (`visualSource`, null when no
 * visual is selected). This is the interactive counterpart of the tester: the
 * tester is a one-shot discover + single-reduce diagnostic over the stateless
 * IR-81B backend; this panel is the turn-by-turn PLAY loop over the IR-84A
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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  type ExperienceCapability,
  type ExperienceController,
} from "@vibe-tavern/domain";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import { Ic } from "../../shared/icons.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { inputCls, monoCls, lblCls } from "../fields/field-styles.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import {
  ExperienceApiError,
  advanceExperiencePlayground,
  startExperiencePlayground,
} from "../../../api/experience-api.js";
import type {
  ExperienceParticipant,
  ExperiencePlaygroundAdvanceRequest,
  ExperiencePlaygroundData,
  ExperienceTestConsoleEntry,
  ExperienceTestDefinition,
} from "../../../api/types.js";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
} from "../../experience/ExperienceFrame.js";

// ─── Local types + constants ────────────────────────────────────────────────
//
// The roster/grants/error-normalization helpers below deliberately MIRROR the
// IR-81D InteractiveTester's module-private ones (same structural reason the
// IR-84A driver reimplements the tester's helpers locally: the two surfaces
// are independent panels with independent evolution, and the shared-primitive
// chrome they compose is the actual sharing boundary).

/** One editable roster row (local state only — never a store). */
interface PlaygroundSeat {
  id: string;
  label: string;
  controller: ExperienceController;
}

/** The typed-error view model this panel renders. Normalized from the client
 *  {@link ExperienceApiError} (which preserves the backend's structured
 *  `details`: code, kernel kind, currentRevision, granted/needs, console). */
interface PlaygroundErrorView {
  message: string;
  status?: number;
  code?: string;
  kind?: string;
  currentRevision?: number;
  participantId?: string;
  granted?: string[];
  needs?: string[];
  console: ExperienceTestConsoleEntry[];
}

type AdvanceOutcome =
  | { readonly ok: true; readonly data: ExperiencePlaygroundData }
  | { readonly ok: false; readonly error: PlaygroundErrorView };

const CONTROLLERS = [
  EXPERIENCE_CONTROLLER.human,
  EXPERIENCE_CONTROLLER.script,
  EXPERIENCE_CONTROLLER.model,
] as const;

const CONTROLLER_LABEL_KEY = {
  [EXPERIENCE_CONTROLLER.human]: "experience_setup_controller_human",
  [EXPERIENCE_CONTROLLER.script]: "experience_setup_controller_script",
  [EXPERIENCE_CONTROLLER.model]: "experience_setup_controller_model",
} as const;

const CAPABILITIES = [
  EXPERIENCE_CAPABILITY.participants,
  EXPERIENCE_CAPABILITY.deterministicRandom,
  EXPERIENCE_CAPABILITY.model,
  EXPERIENCE_CAPABILITY.rpContext,
  EXPERIENCE_CAPABILITY.rpAttachment,
] as const;

const CAPABILITY_LABEL_KEY = {
  [EXPERIENCE_CAPABILITY.participants]: "experience_cap_participants",
  [EXPERIENCE_CAPABILITY.deterministicRandom]: "experience_cap_deterministic_random",
  [EXPERIENCE_CAPABILITY.model]: "experience_cap_model",
  [EXPERIENCE_CAPABILITY.rpContext]: "experience_cap_rp_context",
  [EXPERIENCE_CAPABILITY.rpAttachment]: "experience_cap_rp_attachment",
} as const;

// ─── Normalization helpers (no `as any`; the wire details record is unknown) ──

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asConsole(value: unknown): ExperienceTestConsoleEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ExperienceTestConsoleEntry[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    entries.push({
      level: record.level === "warn" || record.level === "error" ? record.level : "log",
      args: asStringList(record.args) ?? [],
    });
  }
  return entries;
}

function toPlaygroundError(error: unknown): PlaygroundErrorView {
  if (error instanceof ExperienceApiError) {
    const details = error.details ?? {};
    const view: PlaygroundErrorView = {
      message: error.message,
      status: error.status,
      console: asConsole(details.console),
    };
    if (error.code !== undefined) view.code = error.code;
    if (typeof details.kind === "string") view.kind = details.kind;
    if (typeof details.currentRevision === "number") view.currentRevision = details.currentRevision;
    if (typeof details.participantId === "string") view.participantId = details.participantId;
    const granted = asStringList(details.granted);
    if (granted !== undefined) view.granted = granted;
    const needs = asStringList(details.needs);
    if (needs !== undefined) view.needs = needs;
    return view;
  }
  return { message: error instanceof Error ? error.message : String(error), console: [] };
}

/** Parse an optional JSON field. Blank input is "absent" (omitted from the
 *  request); non-blank invalid JSON is a local authoring error — the panel
 *  never sends malformed JSON to the playground. */
function parseOptionalJson(raw: string): { ok: true; present: boolean; value?: unknown } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, present: false };
  try {
    return { ok: true, present: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

// ─── Small render helpers ────────────────────────────────────────────────────

const blockCls = "rounded-md border border-border bg-bg";
const blockLabelCls = "text-[11px] font-semibold uppercase tracking-[0.06em] text-t3";

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-t2">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ConsoleBlock({ entries, label }: { entries: readonly ExperienceTestConsoleEntry[]; label: string }) {
  if (entries.length === 0) return null;
  return (
    <div className={cn(blockCls, "mt-2")} style={{ padding: 10 }}>
      <div className={blockLabelCls}>{label}</div>
      <div className="mt-1 space-y-0.5">
        {entries.map((entry, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", entry.level === "error" ? "bg-danger-dim text-danger-text" : entry.level === "warn" ? "bg-s3 text-t2" : "bg-s3 text-t3")}>{entry.level}</span>
            <pre className="flex-1 whitespace-pre-wrap font-mono text-[12px] text-t2">{entry.args.join(" ")}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ExperiencePlaygroundProps {
  /** The CURRENT UNSAVED rules buffer (owned by the ExperienceEditor). */
  code: string;
  /** The CURRENT UNSAVED visual source, or null when no visual is selected.
   *  Rendered read-only inside the isolated frame; never edited here. */
  visualSource: string | null;
}

export function ExperiencePlayground({ code, visualSource }: ExperiencePlaygroundProps) {
  const { t } = useT();

  const [open, setOpen] = useState(false);

  // Play context (local only).
  const [seats, setSeats] = useState<PlaygroundSeat[]>([
    { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
  ]);
  const [grants, setGrants] = useState<readonly ExperienceCapability[]>([]);
  const [seed, setSeed] = useState("");
  const [settingsJson, setSettingsJson] = useState("");
  /** The seat the author drives; "" = the driver default (first human seat). */
  const [humanSeatId, setHumanSeatId] = useState("");

  // Session + turn form (local only). requestId/expectedRevision are
  // author-editable (prefilled from the last envelope) so idempotent replays
  // and stale-revision conflicts are directly exercisable.
  const [session, setSession] = useState<ExperiencePlaygroundData | null>(null);
  const [definition, setDefinition] = useState<ExperienceTestDefinition | null>(null);
  const [error, setError] = useState<PlaygroundErrorView | null>(null);
  const [busy, setBusy] = useState<"start" | "advance" | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [actionType, setActionType] = useState("");
  const [payloadJson, setPayloadJson] = useState("");
  const [requestId, setRequestId] = useState("pg-req-1");
  const [expectedRevision, setExpectedRevision] = useState("0");

  // Isolated frame wiring. The bridge captures its callbacks at creation, so
  // the frame-facing handlers delegate through refs (the IR-73B seam pattern);
  // the frame is keyed by playgroundSessionId so every session gets a fresh
  // bridge + document.
  const frameRef = useRef<ExperienceFrameHandle>(null);
  const [frameReady, setFrameReady] = useState(false);
  const sessionRef = useRef<ExperiencePlaygroundData | null>(null);
  sessionRef.current = session;

  const participants: ExperienceParticipant[] = seats
    .filter((seat) => seat.id.trim() !== "")
    .map((seat) => ({
      id: seat.id.trim(),
      label: seat.label.trim() === "" ? seat.id.trim() : seat.label.trim(),
      controller: seat.controller,
    }));
  const humanSeats = participants.filter((p) => p.controller === EXPERIENCE_CONTROLLER.human);

  const updateSeat = (index: number, patch: Partial<PlaygroundSeat>) => {
    setSeats((prev) => prev.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)));
  };

  const toggleGrant = (capability: ExperienceCapability, checked: boolean) => {
    setGrants((prev) => (checked ? [...prev, capability] : prev.filter((c) => c !== capability)));
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

  /** Start a fresh ephemeral session from the CURRENT UNSAVED buffers. */
  const handleStart = async () => {
    const settings = parseOptionalJson(settingsJson);
    if (!settings.ok) {
      setError({ message: t("experience_tester_settings_invalid"), console: [] });
      return;
    }
    setBusy("start");
    setError(null);
    setFrameReady(false);
    try {
      const data = await startExperiencePlayground({
        rulesCode: code,
        settings: settings.present ? settings.value : {},
        participants,
        capabilityGrants: [...grants],
        ...(seed.trim() !== "" ? { seed: seed.trim() } : {}),
        ...(humanSeatId !== "" ? { humanSeatId } : {}),
      });
      setSession(data);
      setDefinition(data.definition ?? null);
      setAppliedCount(0);
      setRequestId("pg-req-1");
      setExpectedRevision(String(data.revision));
    } catch (startError) {
      setSession(null);
      setDefinition(null);
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
    }
  };

  /** Custom-action form submit (payload validated locally first). */
  const handleApplyAction = async () => {
    const type = actionType.trim();
    if (type === "") return;
    const payload = parseOptionalJson(payloadJson);
    if (!payload.ok) {
      setError({ message: t("experience_tester_action_payload_invalid"), console: [] });
      return;
    }
    await submitAction(type, undefined, payload);
  };

  /** Stable frame-action handler (IR-73B seam): the visual's intention carries
   *  the SDK-filled requestId/expectedRevision and advances the SAME
   *  playground session. Success acks the bridge (sendResult clears the
   *  duplicate-click lock; the session effect below pushes the new view);
   *  failure maps the typed playground error to a bridge code keyed to the
   *  visual requestId so the lock always clears. */
  const handleFrameAction = useCallback(
    async (action: ExperienceActionDto) => {
      const outcome = await advanceWith(action);
      if (outcome.ok) {
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
    [advanceWith],
  );

  // Push the latest turn's projection into the isolated frame whenever the
  // session advances or the frame completes its handshake. State goes TO the
  // frame through the bridge only — never to the host DOM.
  useEffect(() => {
    if (!frameReady || session === null) return;
    frameRef.current?.sendState({
      state: session.projection.state,
      actions: session.projection.actions,
      revision: session.revision,
      status: session.status,
    });
  }, [frameReady, session]);

  const hasVisual = visualSource !== null && visualSource.trim() !== "";

  return (
    <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-block text-t3 transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.dice /></span>
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {t("experience_playground_title")}
        </span>
        <CustomTooltip content={t("experience_playground_hint")}>
          <span className="cursor-help text-[11px] text-t4">ⓘ</span>
        </CustomTooltip>
      </button>

      {open && (
        <div className="mt-3">
          {/* Play context: roster + capability grants + seed + settings + seat */}
          <div className="mb-3">
            <label className={lblCls}>{t("experience_setup_participants_label")}</label>
            {seats.map((seat, index) => (
              <div key={index} className="mb-1.5 mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  className={cn(inputCls, "min-w-0 w-24 shrink-0")}
                  value={seat.id}
                  placeholder={t("experience_tester_seat_id_placeholder")}
                  onChange={(e) => updateSeat(index, { id: e.target.value })}
                />
                <input
                  className={cn(inputCls, "min-w-[7rem] flex-1")}
                  value={seat.label}
                  placeholder={t("experience_setup_participant_name_placeholder")}
                  onChange={(e) => updateSeat(index, { label: e.target.value })}
                />
                <div className="w-28 shrink-0">
                  <DropdownSelect
                    value={seat.controller}
                    options={CONTROLLERS.map((controller) => ({ id: controller, label: t(CONTROLLER_LABEL_KEY[controller]) }))}
                    searchable={false}
                    onChange={(value) => {
                      const controller = CONTROLLERS.find((c) => c === value);
                      if (controller !== undefined) updateSeat(index, { controller });
                    }}
                  />
                </div>
                <button
                  type="button"
                  aria-label={t("experience_setup_remove_participant")}
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s3 hover:text-t1"
                  onClick={() => setSeats((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Ic.del />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="mt-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={() => setSeats((prev) => [...prev, { id: "", label: "", controller: EXPERIENCE_CONTROLLER.human }])}
            >
              <Ic.plus /> {t("experience_setup_add_participant")}
            </button>
          </div>

          <div className="mb-3">
            <label className={lblCls}>{t("experience_tester_capabilities_label")}</label>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {CAPABILITIES.map((capability) => (
                <Checkbox
                  key={capability}
                  checked={grants.includes(capability)}
                  onChange={(checked) => toggleGrant(capability, checked)}
                  label={t(CAPABILITY_LABEL_KEY[capability])}
                  className="font-ui text-[12px]"
                />
              ))}
            </div>
          </div>

          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <div>
              <label className={lblCls}>{t("experience_tester_seed_label")}</label>
              <input
                className={cn(inputCls, "mt-1.5")}
                value={seed}
                placeholder={t("experience_tester_seed_placeholder")}
                onChange={(e) => setSeed(e.target.value)}
              />
            </div>
            <div>
              <label className={lblCls}>{t("experience_playground_human_seat_label")}</label>
              <div className="mt-1.5">
                <DropdownSelect
                  value={humanSeatId}
                  options={humanSeats.map((p) => ({ id: p.id, label: p.label }))}
                  searchable={false}
                  placeholder={t("experience_playground_human_seat_auto")}
                  defaultOption={t("experience_playground_human_seat_auto")}
                  onChange={setHumanSeatId}
                />
              </div>
            </div>
            <div>
              <label className={lblCls}>{t("experience_setup_settings_label")}</label>
              <AutoTextarea
                className={cn(monoCls, "mt-1.5")}
                value={settingsJson}
                onChange={(e) => setSettingsJson(e.target.value)}
                placeholder="{}"
                minRows={1}
                maxRows={4}
                macroAutocomplete={false}
              />
            </div>
          </div>

          {/* Session controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
              disabled={busy !== null || code.trim() === ""}
              onClick={() => void handleStart()}
            >
              {t("experience_playground_start")}
            </button>
            {session !== null && (
              <button
                type="button"
                className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                disabled={busy !== null}
                onClick={handleReset}
              >
                {t("experience_playground_reset")}
              </button>
            )}
            {busy !== null && <span className="font-ui text-[12px] text-t3">{t("script_running")}</span>}
          </div>

          {/* Typed error (start or advance) */}
          {error !== null && (
            <div className="mt-3 rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase text-danger-text">{t("experience_playground_error_title")}</span>
                {error.code !== undefined && (
                  <span className="rounded bg-danger/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-danger-text">{error.code}</span>
                )}
              </div>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{error.message}</pre>
              <div className="mt-1 space-y-0.5 font-ui text-[11px] text-t2">
                {error.kind !== undefined && (
                  <div><span className="text-t3">{t("experience_tester_error_kind")}: </span><span className="font-mono">{error.kind}</span></div>
                )}
                {error.currentRevision !== undefined && (
                  <div><span className="text-t3">{t("experience_tester_error_current_revision")}: </span><span className="font-mono">{error.currentRevision}</span></div>
                )}
                {error.granted !== undefined && (
                  <div><span className="text-t3">{t("experience_tester_error_granted")}: </span><span className="font-mono">{error.granted.join(", ")}</span></div>
                )}
                {error.needs !== undefined && (
                  <div><span className="text-t3">{t("experience_tester_error_needs")}: </span><span className="font-mono">{error.needs.join(", ")}</span></div>
                )}
              </div>
              <ConsoleBlock entries={error.console} label={t("script_test_console")} />
            </div>
          )}

          {/* Live session */}
          {session !== null && (
            <div className="mt-3 space-y-2">
              {definition !== null && (
                <div className={blockCls} style={{ padding: 10 }}>
                  <div className={blockLabelCls}>{t("experience_tester_definition")}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-ui text-[12px] text-t1">
                    <span className="font-semibold">{definition.manifest.name}</span>
                    <span className="font-mono text-[11px] text-t3">({definition.manifest.id})</span>
                    <span className="text-[11px] text-t3">· apiVersion {definition.apiVersion}</span>
                    {definition.hasChoose && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">choose ✓</span>}
                    {definition.hasFlavor && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">flavor ✓</span>}
                  </div>
                  <div className="mt-1 font-ui text-[11px] text-t3">
                    {definition.declaredCapabilities.length > 0
                      ? definition.declaredCapabilities.map((c) => c.capability).join(", ")
                      : t("experience_assign_no_capabilities")}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
                <span>{t("experience_playground_session_label")}: <span className="font-mono text-t2">{session.playgroundSessionId.slice(0, 8)}</span></span>
                <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{session.revision}</span></span>
                <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{session.status}</span></span>
                <span>{t("experience_tester_sim_stop_reason")}: <span className="font-mono text-t2">{session.stopReason}</span></span>
              </div>

              {/* Model-seat boundary: informational stub, never an error — the
                  driver never invokes a provider in the playground. */}
              {session.stopReason === "awaiting_model" && (
                <div className="rounded-md border border-border bg-s3" style={{ padding: 10 }}>
                  <span className="font-ui text-[12px] text-t2">{t("experience_playground_model_stub")}</span>
                </div>
              )}

              {/* Take a turn: legal actions as one-click buttons + the custom
                  action form (type/payload/requestId/expectedRevision). */}
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
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className={cn(inputCls, "w-40")}
                    value={actionType}
                    placeholder={t("experience_tester_action_type_placeholder")}
                    onChange={(e) => setActionType(e.target.value)}
                  />
                  <input
                    className={cn(inputCls, "w-32")}
                    value={requestId}
                    aria-label={t("experience_tester_action_request_id")}
                    onChange={(e) => setRequestId(e.target.value)}
                  />
                  <input
                    className={cn(inputCls, "w-24")}
                    value={expectedRevision}
                    aria-label={t("experience_tester_action_expected_revision")}
                    onChange={(e) => setExpectedRevision(e.target.value)}
                  />
                  <button
                    type="button"
                    className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                    disabled={busy !== null || actionType.trim() === ""}
                    onClick={() => void handleApplyAction()}
                  >
                    {t("experience_tester_action_apply")}
                  </button>
                </div>
                <div className="mt-2">
                  <AutoTextarea
                    className={monoCls}
                    value={payloadJson}
                    onChange={(e) => setPayloadJson(e.target.value)}
                    placeholder={t("experience_tester_action_payload_label")}
                    minRows={1}
                    maxRows={4}
                    macroAutocomplete={false}
                  />
                </div>
              </div>

              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_tester_projection")}</div>
                <JsonBlock value={session.projection.state} />
              </div>

              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_tester_final_state")}</div>
                <JsonBlock value={session.state} />
              </div>

              {session.events.length > 0 && (
                <div className={blockCls} style={{ padding: 10 }}>
                  <div className={blockLabelCls}>{t("experience_tester_events")}</div>
                  <div className="mt-1 space-y-1">
                    {session.events.map((event, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", event.visibility === "public" ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>{event.visibility}</span>
                        <span className="font-mono text-[11px] text-t2">{event.type}</span>
                        {event.detail !== undefined && <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(event.detail)}</pre>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {session.effects.length > 0 && (
                <div className={blockCls} style={{ padding: 10 }}>
                  <div className={blockLabelCls}>{t("experience_tester_effects")}</div>
                  <div className="mt-1 space-y-1">
                    {session.effects.map((effect, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="shrink-0 rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning-text">{effect.kind}</span>
                        <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(effect.request)}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <ConsoleBlock entries={session.console} label={t("script_test_console")} />

              {/* The REAL visual against the current playground state, inside
                  the isolated frame (opaque origin; bridge-posted state). Keyed
                  by session id so every session gets a fresh bridge + document;
                  unmounting on reset tears the frame down completely. */}
              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_playground_visual_label")}</div>
                {hasVisual ? (
                  <div className="mt-2 rounded-md border border-border bg-bg" style={{ padding: 8 }}>
                    <ExperienceFrame
                      key={session.playgroundSessionId}
                      ref={frameRef}
                      visualSource={visualSource}
                      sessionId={`playground-${session.playgroundSessionId}`}
                      initialRevision={session.revision}
                      onReady={() => setFrameReady(true)}
                      onAction={(action) => void handleFrameAction(action)}
                      onError={() => {}}
                    />
                  </div>
                ) : (
                  <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_playground_no_visual")}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
