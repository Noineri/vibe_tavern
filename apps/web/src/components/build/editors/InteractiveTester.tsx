/**
 * InteractiveTester — the stateless unsaved-source rules tester
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-81D).
 *
 * Mounted by the ExperienceEditor directly below the rules CodeEditor and fed
 * the CURRENT UNSAVED rules buffer via the `code` prop (the editor owns the
 * buffer; this panel never edits it). It drives that source through the
 * IR-81B stateless backend tester (POST /api/experience/test/run|simulate via
 * the two client functions in api/experience-api.ts) and renders the result as
 * a READ-ONLY diagnostic — the interactive counterpart of the ScriptTester
 * (prompt/dice) panel, whose result/error/console layout it mirrors:
 *
 *  - Discover & create: the validated definition (manifest, declared
 *    capabilities, setup descriptor, choose/flavor presence), the projected
 *    view for the viewer, and the legal actions at the created state — or the
 *    typed discovery error (vm_error carrying the kernel kind: syntax /
 *    missing_method / no_registration / multi_registration / timeout / …).
 *  - One-action reduce: one author-supplied action intention (type, requestId,
 *    expectedRevision, optional participant + payload) is appended to the
 *    already-applied list and replayed from create (the tester is stateless —
 *    each request is a full in-memory replay). The response carries the next
 *    authoritative state, events, requested effects (reported, never
 *    executed), the captured console, and the host revision. Typed failures
 *    render their code + payload: illegal_action, stale_revision +
 *    currentRevision, capability_denied + granted/needs, vm_error + kind.
 *  - Auto-advance (minimal): the bounded simulate call walks script-controlled
 *    seats via the real `choose` and reports its typed stop reason. The full
 *    human-seat play loop is IR-84's job, not this panel's.
 *
 * Read-only invariant: every input and result lives in local component state.
 * This panel imports NO store and never writes one — running it leaves the
 * rules draft, the visual draft, and every persistent store byte-identical —
 * and it never forwards an action to any chat/session.
 */
import { useState } from "react";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTROLLER,
  type ExperienceCapability,
  type ExperienceController,
} from "@vibe-tavern/domain";
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
  runExperienceTest,
  simulateExperienceTest,
} from "../../../api/experience-api.js";
import type {
  ExperienceActionRequest,
  ExperienceParticipant,
  ExperienceTestConsoleEntry,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
} from "../../../api/types.js";

// ─── Local types + constants ────────────────────────────────────────────────

/** One editable roster row (local state only — never a store). */
interface TesterSeat {
  id: string;
  label: string;
  controller: ExperienceController;
}

/** The typed-error view model this panel renders. Normalized from the client
 *  {@link ExperienceApiError} (which preserves the backend's structured
 *  `details`: code, kernel kind, currentRevision, granted/needs, console). */
interface TesterErrorView {
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

function toTesterError(error: unknown): TesterErrorView {
  if (error instanceof ExperienceApiError) {
    const details = error.details ?? {};
    const view: TesterErrorView = {
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
 *  never sends malformed JSON to the tester. */
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

interface InteractiveTesterProps {
  /** The CURRENT UNSAVED rules buffer (owned by the ExperienceEditor). */
  code: string;
}

export function InteractiveTester({ code }: InteractiveTesterProps) {
  const { t } = useT();

  const [open, setOpen] = useState(false);

  // Test context (local only).
  const [seats, setSeats] = useState<TesterSeat[]>([
    { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
  ]);
  const [grants, setGrants] = useState<readonly ExperienceCapability[]>([]);
  const [seed, setSeed] = useState("");
  const [settingsJson, setSettingsJson] = useState("");

  // One-action reduce form. requestId/expectedRevision are author-editable
  // (prefilled from the last run) so idempotent replays and stale-revision
  // conflicts are directly exercisable.
  const [appliedActions, setAppliedActions] = useState<readonly ExperienceActionRequest[]>([]);
  const [actionType, setActionType] = useState("");
  const [actionParticipantId, setActionParticipantId] = useState("");
  const [requestId, setRequestId] = useState("test-req-1");
  const [expectedRevision, setExpectedRevision] = useState("0");
  const [payloadJson, setPayloadJson] = useState("");

  // Results (local only).
  const [result, setResult] = useState<ExperienceTestRunData | null>(null);
  const [simResult, setSimResult] = useState<ExperienceTestSimulateData | null>(null);
  const [error, setError] = useState<TesterErrorView | null>(null);
  const [busy, setBusy] = useState<"run" | "simulate" | null>(null);

  const participants: ExperienceParticipant[] = seats
    .filter((seat) => seat.id.trim() !== "")
    .map((seat) => ({
      id: seat.id.trim(),
      label: seat.label.trim() === "" ? seat.id.trim() : seat.label.trim(),
      controller: seat.controller,
    }));

  const updateSeat = (index: number, patch: Partial<TesterSeat>) => {
    setSeats((prev) => prev.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)));
  };

  const toggleGrant = (capability: ExperienceCapability, checked: boolean) => {
    setGrants((prev) => (checked ? [...prev, capability] : prev.filter((c) => c !== capability)));
  };

  /** Shared run path: parse the context, call the tester, store the outcome.
   *  Returns the data on success so the caller can chain form bookkeeping. */
  const runWith = async (actions: readonly ExperienceActionRequest[]): Promise<ExperienceTestRunData | null> => {
    const settings = parseOptionalJson(settingsJson);
    if (!settings.ok) {
      setError({ message: t("experience_tester_settings_invalid"), console: [] });
      return null;
    }
    setBusy("run");
    setError(null);
    try {
      const data = await runExperienceTest({
        rulesCode: code,
        settings: settings.present ? settings.value : {},
        participants,
        capabilityGrants: [...grants],
        ...(seed.trim() !== "" ? { seed: seed.trim() } : {}),
        actions: [...actions],
      });
      setResult(data);
      return data;
    } catch (runError) {
      setError(toTesterError(runError));
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** Discover-only run: validate + create + project + legal actions, no
   *  actions replayed. Resets the one-action form (the run restarts). */
  const handleDiscover = async () => {
    const data = await runWith([]);
    if (data !== null) {
      setAppliedActions([]);
      setRequestId("test-req-1");
      setExpectedRevision(String(data.revision));
    }
  };

  /** One-action reduce: append the author's intention to the applied list and
   *  replay the full sequence (the tester is stateless per request). On
   *  success the form advances to the next requestId + the live revision; on
   *  a typed failure nothing is appended. */
  const handleApplyAction = async () => {
    const type = actionType.trim();
    if (type === "") return;
    const payload = parseOptionalJson(payloadJson);
    if (!payload.ok) {
      setError({ message: t("experience_tester_action_payload_invalid"), console: [] });
      return;
    }
    const revision = Number.parseInt(expectedRevision, 10);
    if (!Number.isInteger(revision) || revision < 0 || String(revision) !== expectedRevision.trim()) {
      setError({ message: t("experience_tester_action_revision_invalid"), console: [] });
      return;
    }
    const action: ExperienceActionRequest = {
      type,
      requestId: requestId.trim() !== "" ? requestId.trim() : `test-req-${appliedActions.length + 1}`,
      expectedRevision: revision,
      ...(actionParticipantId !== "" ? { participantId: actionParticipantId } : {}),
      ...(payload.present ? { payload: payload.value } : {}),
    };
    const data = await runWith([...appliedActions, action]);
    if (data !== null) {
      setAppliedActions([...appliedActions, action]);
      setRequestId(`test-req-${appliedActions.length + 2}`);
      setExpectedRevision(String(data.revision));
      setActionType("");
      setPayloadJson("");
    }
  };

  /** Bounded auto-advance of script-controlled seats (minimal IR-84 preview). */
  const handleSimulate = async () => {
    const settings = parseOptionalJson(settingsJson);
    if (!settings.ok) {
      setError({ message: t("experience_tester_settings_invalid"), console: [] });
      return;
    }
    setBusy("simulate");
    setError(null);
    try {
      const data = await simulateExperienceTest({
        rulesCode: code,
        settings: settings.present ? settings.value : {},
        participants,
        capabilityGrants: [...grants],
        ...(seed.trim() !== "" ? { seed: seed.trim() } : {}),
      });
      setSimResult(data);
    } catch (simError) {
      setError(toTesterError(simError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-block text-t3 transition-transform" style={{ transform: open ? "rotate(90deg)" : "none" }}>▶</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></span>
        <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {t("experience_tester_title")}
        </span>
        <CustomTooltip content={t("experience_tester_hint")}>
          <span className="cursor-help text-[11px] text-t4">ⓘ</span>
        </CustomTooltip>
      </button>

      {open && (
        <div className="mt-3">
          {/* Test context: roster + capability grants + seed + settings */}
          <div className="mb-3">
            <label className={lblCls}>{t("experience_setup_participants_label")}</label>
            {seats.map((seat, index) => (
              <div key={index} className="mb-1.5 mt-1.5 flex items-center gap-2">
                <input
                  className={cn(inputCls, "w-24 shrink-0")}
                  value={seat.id}
                  placeholder={t("experience_tester_seat_id_placeholder")}
                  onChange={(e) => updateSeat(index, { id: e.target.value })}
                />
                <input
                  className={cn(inputCls, "min-w-0 flex-1")}
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

          <div className="mb-3 grid gap-2 sm:grid-cols-2">
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

          {/* Run controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
              disabled={busy !== null || code.trim() === ""}
              onClick={() => void handleDiscover()}
            >
              {t("experience_tester_run")}
            </button>
            <button
              type="button"
              className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
              disabled={busy !== null || code.trim() === ""}
              onClick={() => void handleSimulate()}
            >
              {t("experience_tester_simulate")}
            </button>
            {busy !== null && <span className="font-ui text-[12px] text-t3">{t("script_running")}</span>}
          </div>

          {/* One-action reduce */}
          <div className="mt-3 rounded-md border border-border bg-bg" style={{ padding: 10 }}>
            <div className={blockLabelCls}>{t("experience_tester_action_title")}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className={cn(inputCls, "w-40")}
                value={actionType}
                placeholder={t("experience_tester_action_type_placeholder")}
                onChange={(e) => setActionType(e.target.value)}
              />
              <div className="w-44">
                <DropdownSelect
                  value={actionParticipantId}
                  options={participants.map((p) => ({ id: p.id, label: p.label }))}
                  searchable={false}
                  placeholder={t("experience_tester_action_participant_default")}
                  defaultOption={t("experience_tester_action_participant_default")}
                  onChange={setActionParticipantId}
                />
              </div>
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

          {/* Typed error (run or simulate) */}
          {error !== null && (
            <div className="mt-3 rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase text-danger-text">{t("experience_tester_error_title")}</span>
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

          {/* Run result */}
          {result !== null && (
            <div className="mt-3 space-y-2">
              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_tester_definition")}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-ui text-[12px] text-t1">
                  <span className="font-semibold">{result.definition.manifest.name}</span>
                  <span className="font-mono text-[11px] text-t3">({result.definition.manifest.id})</span>
                  <span className="text-[11px] text-t3">· apiVersion {result.definition.apiVersion}</span>
                  {result.definition.hasChoose && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">choose ✓</span>}
                  {result.definition.hasFlavor && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">flavor ✓</span>}
                  {result.definition.setup !== undefined && (
                    <span className="rounded bg-s3 px-1.5 py-0.5 font-ui text-[10px] text-t2">
                      {t("experience_tester_setup_fields")}: {result.definition.setup.fields.length}
                    </span>
                  )}
                </div>
                <div className="mt-1 font-ui text-[11px] text-t3">
                  {result.definition.declaredCapabilities.length > 0
                    ? result.definition.declaredCapabilities.map((c) => c.capability).join(", ")
                    : t("experience_assign_no_capabilities")}
                </div>
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
                <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{result.revision}</span></span>
                <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{result.status}</span></span>
              </div>

              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_tester_projection")}</div>
                <JsonBlock value={result.projection.state} />
              </div>

              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_tester_final_state")}</div>
                <JsonBlock value={result.finalState} />
              </div>

              <div className={blockCls} style={{ padding: 10 }}>
                <div className={blockLabelCls}>{t("experience_tester_legal_actions")}</div>
                {result.projection.actions.length === 0 ? (
                  <p className="mt-1 font-ui text-[11px] italic text-t3">{t("experience_tester_no_actions")}</p>
                ) : (
                  <div className="mt-1 space-y-1">
                    {result.projection.actions.map((action, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-accent-dim px-1.5 py-0.5 font-mono text-[10px] text-accent-t">{action.type}</span>
                        {action.label !== undefined && <span className="font-ui text-[11px] text-t2">{action.label}</span>}
                        {action.participantId !== undefined && <span className="font-mono text-[10px] text-t3">@{action.participantId}</span>}
                        {action.allowsText === true && <span className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t3">text</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {result.events.length > 0 && (
                <div className={blockCls} style={{ padding: 10 }}>
                  <div className={blockLabelCls}>{t("experience_tester_events")}</div>
                  <div className="mt-1 space-y-1">
                    {result.events.map((event, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", event.visibility === "public" ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>{event.visibility}</span>
                        <span className="font-mono text-[11px] text-t2">{event.type}</span>
                        {event.detail !== undefined && <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(event.detail)}</pre>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.effects.length > 0 && (
                <div className={blockCls} style={{ padding: 10 }}>
                  <div className={blockLabelCls}>{t("experience_tester_effects")}</div>
                  <div className="mt-1 space-y-1">
                    {result.effects.map((effect, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="shrink-0 rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning-text">{effect.kind}</span>
                        <pre className="flex-1 whitespace-pre-wrap font-mono text-[10px] text-t3">{JSON.stringify(effect.request)}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.steps.length > 0 && (
                <div className={blockCls} style={{ padding: 10 }}>
                  <div className={blockLabelCls}>{t("experience_tester_steps")}</div>
                  <div className="mt-1 space-y-1">
                    {result.steps.map((step, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-t2">
                        <span className="text-t3">{step.requestId}</span>
                        <span className="rounded bg-accent-dim px-1.5 py-0.5 text-[10px] text-accent-t">{step.actionType}</span>
                        <span>→ rev {step.revision} · {step.status}</span>
                        {step.replayed && <span className="rounded bg-warning-dim px-1.5 py-0.5 text-[10px] uppercase text-warning-text">{t("experience_tester_replayed")}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <ConsoleBlock entries={result.console} label={t("script_test_console")} />
            </div>
          )}

          {/* Simulate result (minimal: typed stop reason + bounds) */}
          {simResult !== null && (
            <div className={cn(blockCls, "mt-3")} style={{ padding: 10 }}>
              <div className={blockLabelCls}>{t("experience_tester_simulate")}</div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
                <span>{t("experience_tester_sim_stop_reason")}: <span className="font-mono text-t2">{simResult.stopReason}</span></span>
                <span>{t("experience_tester_sim_iterations")}: <span className="font-mono text-t2">{simResult.iterations}</span></span>
                <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{simResult.revision}</span></span>
                <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{simResult.status}</span></span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
