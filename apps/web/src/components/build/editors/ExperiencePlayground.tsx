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
import { Toggle } from "../../shared/Toggle.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { inputCls, monoCls, lblCls } from "../fields/field-styles.js";
import { cn } from "../../../lib/cn.js";
import { parseOptionalJsonDiagnosed } from "../../../lib/json-parse-diagnostic.js";
import { useT } from "../../../i18n/context.js";
import {
  ExperienceApiError,
  advanceExperiencePlayground,
  runExperienceTest,
  simulateExperienceTest,
  startExperiencePlayground,
} from "../../../api/experience-api.js";
import { fetchProviderProfileModels, listProviderProfiles } from "../../../api/provider-api.js";
import type { ProviderProfileRecord } from "../../../api/types.js";
import type {
  ExperienceParticipant,
  ExperiencePlaygroundAdvanceRequest,
  ExperiencePlaygroundData,
  ExperienceSeatLegalityMatrix,
  ExperienceTestConsoleEntry,
  ExperienceTestDefinition,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
} from "../../../api/types.js";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
} from "../../experience/ExperienceFrame.js";
import {
  deriveSetupValuesFromSettings,
  mergeAbsentSetupDefaults,
  SetupFieldRow,
  validateSetupFields,
  type SetupField,
} from "../../experience/setup-fields.js";
import {
  buildPlaygroundDigest,
  buildRunTestDigest,
  buildRunTestErrorDigest,
  buildSimulateDigest,
  type CopilotDigest,
} from "../../../lib/experience-copilot-digest.js";
import {
  loadPlaygroundConfig,
  savePlaygroundConfig,
} from "../../../lib/playground-config-persistence.js";

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
  /** Pinned provider profile for a model seat (IR-90E). */
  providerProfileId?: string;
  /** Pinned model id for a model seat (IR-90E). */
  modelId?: string;
  /** True while the id is auto-managed (tracks the label): becomes false the
   *  moment the user edits the id by hand. Local-only — never persisted, so a
   *  restored seat keeps its stored id verbatim (renames do not regenerate it). */
  idAuto?: boolean;
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

/** Friendly (non-technical) role labels for the roster card dropdown. The
 *  technical controller values map 1:1 (human/model/script) — only the label
 *  changes; the domain value sent to Start is untouched. */
const CONTROLLER_LABEL_KEY = {
  [EXPERIENCE_CONTROLLER.human]: "experience_playground_role_human",
  [EXPERIENCE_CONTROLLER.script]: "experience_playground_role_script",
  [EXPERIENCE_CONTROLLER.model]: "experience_playground_role_model",
} as const;

const CAPABILITIES = [
  EXPERIENCE_CAPABILITY.participants,
  EXPERIENCE_CAPABILITY.deterministicRandom,
  EXPERIENCE_CAPABILITY.model,
  EXPERIENCE_CAPABILITY.rpContext,
  EXPERIENCE_CAPABILITY.rpAttachment,
] as const;

/** Friendly (non-technical) capability labels for the grant checkboxes (XU-3).
 *  The technical capability id (the wire string) stays reachable via the ⓘ
 *  tooltip next to each label — non-technical authors never see raw ids inline.
 *  The existing `experience_cap_*` keys remain in place for the other surfaces
 *  (InteractiveTester, ExperienceAssignment); these are playground-only. */
const CAPABILITY_LABEL_KEY = {
  [EXPERIENCE_CAPABILITY.participants]: "experience_cap_friendly_participants",
  [EXPERIENCE_CAPABILITY.deterministicRandom]: "experience_cap_friendly_deterministic_random",
  [EXPERIENCE_CAPABILITY.model]: "experience_cap_friendly_model",
  [EXPERIENCE_CAPABILITY.rpContext]: "experience_cap_friendly_rp_context",
  [EXPERIENCE_CAPABILITY.rpAttachment]: "experience_cap_friendly_rp_attachment",
} as const;

/** LOBBY-A (EXPERIENCE_ENGINE_LOBBY_REPORT fix step 1): the setup-field discovery debounce. The unsaved rules buffer changes per keystroke; the pre-LOBBY-A auto-derive fired a compile per keystroke while the roster was untouched. The debounce coalesces that churn AND is what makes it affordable to keep discovering (for the declared setup fields) even after the roster is user-owned. */
const DISCOVERY_DEBOUNCE_MS = 400;

// ─── Normalization helpers (no `as any`; the wire details record is unknown) ──

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** LOBBY-A: narrow a parsed JSON value to a plain settings object. Null for
 *  arrays/scalars/null — the setup form is unavailable for those and the raw
 *  JSON path applies. Runtime-checked narrowing (not a suppressed cast). */
function asSettingsObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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


// ─── Small render helpers ────────────────────────────────────────────────────

const blockCls = "rounded-md border border-border bg-bg";
const blockLabelCls = "text-[11px] font-semibold uppercase tracking-[0.06em] text-t3";

/** Slugify a participant name into a stable seat id: lowercase, latin
 *  alphanumerics + dashes only, "seat" fallback for an empty name. */
function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base === "" ? "seat" : base;
}

/** Dedupe a candidate id against an already-taken set with -2/-3 suffixes. */
function uniqueIdFor(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** First letter for the participant's avatar circle (label → id → "?"). */
function seatInitial(seat: PlaygroundSeat): string {
  const source = seat.label.trim() !== "" ? seat.label.trim() : seat.id.trim();
  return source === "" ? "?" : source.charAt(0).toUpperCase();
}

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

/** The per-seat legality matrix (EXPERIENCE_TURN_LEGALITY_DIAGNOSTICS_REPORT
 *  step 3): one compact row per roster seat — its legal action types (or the
 *  actions() error) — with the current turn owners highlighted. Absorbed from
 *  the retired InteractiveTester (XU-4); renders only when the run carried a
 *  roster AND the server supplied the matrix (older builds omit it). */
function SeatLegalityBlock({ matrix, completed }: { matrix: ExperienceSeatLegalityMatrix; completed: boolean }) {
  if (matrix.seats.length === 0) return null;
  const { t } = useT();
  return (
    <div className={blockCls} style={{ padding: 10 }}>
      <div className={blockLabelCls}>{t("experience_tester_seat_legality")}</div>
      <div className="mt-1 space-y-1">
        {matrix.seats.map((seat) => {
          const owner = matrix.turnOwners.includes(seat.participantId);
          return (
            <div key={seat.participantId} className="flex flex-wrap items-center gap-2">
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]", owner ? "bg-accent-dim text-accent-t" : "bg-s3 text-t3")}>
                {seat.label} · {seat.controller}
              </span>
              {seat.error !== undefined ? (
                <span className="font-mono text-[10px] text-danger-text">actions() error: {seat.error}</span>
              ) : seat.actionTypes.length === 0 ? (
                <span className="font-ui text-[11px] italic text-t3">{t("experience_tester_no_actions")}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {seat.actionTypes.map((type) => (
                    <span key={type} className="rounded bg-s3 px-1.5 py-0.5 font-mono text-[10px] text-t2">{type}</span>
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 font-ui text-[11px] text-t3">
        {t("experience_tester_turn")}:{" "}
        <span className="font-mono text-t2">
          {matrix.turnOwners.length > 0 ? matrix.turnOwners.join(", ") : completed ? "— (completed)" : "—"}
        </span>
      </div>
    </div>
  );
}

/** XU-4: the retired InteractiveTester's create-only discover result, rendered
 *  verbatim in information content (definition summary, projection, legal
 *  actions, seat legality, events/effects/steps/console). Reuses this file's
 *  `JsonBlock`/`ConsoleBlock`. */
function TestRunResultBlock({ result }: { result: ExperienceTestRunData }) {
  const { t } = useT();
  return (
    <div className="mt-2 space-y-2">
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

      {result.seatLegality !== undefined && (
        <SeatLegalityBlock matrix={result.seatLegality} completed={result.status === "completed"} />
      )}

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
  );
}

/** XU-4: the retired InteractiveTester's bounded-simulation result. The typed
 *  stop reason + bounds summary, followed by the accumulated events/effects/
 *  steps/console (the simulate envelope carries them all). */
function TestSimulateResultBlock({ result }: { result: ExperienceTestSimulateData }) {
  const { t } = useT();
  return (
    <div className="mt-2 space-y-2">
      <div className={blockCls} style={{ padding: 10 }}>
        <div className={blockLabelCls}>{t("experience_tester_simulate")}</div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
          <span>{t("experience_tester_sim_stop_reason")}: <span className="font-mono text-t2">{result.stopReason}</span></span>
          <span>{t("experience_tester_sim_iterations")}: <span className="font-mono text-t2">{result.iterations}</span></span>
          <span>{t("experience_tester_revision")}: <span className="font-mono text-t2">{result.revision}</span></span>
          <span>{t("experience_tester_status")}: <span className="font-mono text-t2">{result.status}</span></span>
        </div>
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
  );
}

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
  /** ER-14: when provided (by the copilot shell), a "Send diagnostics to
   *  assistant" button appears INSIDE the Developer-diagnostics disclosure and
   *  posts the live session digest into the copilot thread. Undefined outside
   *  the shell (standalone playground use → no button). */
  onSendToCopilot?: (digest: CopilotDigest) => void;
}

export function ExperiencePlayground({ code, visualSource, scriptId, onSendToCopilot }: ExperiencePlaygroundProps) {
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
   *  (technical users; verbatim: «жсон для технических пользователей под
   *  аккордеон прятать»). Local only — never persisted. */
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
  const [appliedCount, setAppliedCount] = useState(0);
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
  const [testerBusy, setTesterBusy] = useState<"run" | "simulate" | null>(null);

  // IR-90E: provider/model loading for model seats (mirrors ExperienceSetupModal).
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfileRecord[] | null>(null);
  const [modelsByProfile, setModelsByProfile] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [loadingProfiles, setLoadingProfiles] = useState<Set<string>>(new Set());
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

  // Isolated frame wiring. The bridge captures its callbacks at creation, so
  // the frame-facing handlers delegate through refs (the IR-73B seam pattern);
  // the frame is keyed by playgroundSessionId so every session gets a fresh
  // bridge + document.
  const frameRef = useRef<ExperienceFrameHandle>(null);
  const [frameReady, setFrameReady] = useState(false);
  const sessionRef = useRef<ExperiencePlaygroundData | null>(null);
  sessionRef.current = session;
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

  // IR-90E: load provider profiles when the panel opens and a model seat exists.
  const hasModelSeat = seats.some((s) => s.controller === EXPERIENCE_CONTROLLER.model);
  useEffect(() => {
    if (!hasModelSeat || providerProfiles !== null) return;
    let cancelled = false;
    listProviderProfiles()
      .then((profiles) => { if (!cancelled) setProviderProfiles(profiles); })
      .catch(() => { if (!cancelled) setProviderProfiles([]); });
    return () => { cancelled = true; };
  }, [hasModelSeat, providerProfiles]);

  function ensureModels(profileId: string): void {
    if (profileId === "" || modelsByProfile[profileId] !== undefined || loadingProfiles.has(profileId)) return;
    setLoadingProfiles((prev) => new Set(prev).add(profileId));
    fetchProviderProfileModels(profileId)
      .then((res) => { setModelsByProfile((prev) => ({ ...prev, [profileId]: res.models.map((m) => ({ id: m.id, label: m.label || m.id })) })); })
      .catch(() => { setModelsByProfile((prev) => ({ ...prev, [profileId]: [] })); })
      .finally(() => { setLoadingProfiles((prev) => { const n = new Set(prev); n.delete(profileId); return n; }); });
  }

  function modelOptionsFor(profileId: string): Array<{ id: string; label: string }> {
    const fetched = modelsByProfile[profileId] ?? [];
    const options = fetched.map((m) => ({ id: m.id, label: m.label }));
    const profile = (providerProfiles ?? []).find((p) => p.id === profileId);
    if (profile?.defaultModel && !options.some((o) => o.id === profile.defaultModel)) {
      options.push({ id: profile.defaultModel, label: profile.defaultModel });
    }
    return options;
  }

  const providerOptions = (providerProfiles ?? []).map((p) => ({ id: p.id, label: p.name || p.id }));

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

  // IR-90E: auto-derive an ordinary setup (roster + grants) from the discovered
  // definition when the panel opens and the user hasn't manually configured
  // seats. Uses the REAL runExperienceTest discovery (not brittle text parsing)
  // — discovery failure (broken rules) explicitly restores the safe default
  // single human seat plus empty grants.
  // LOBBY-A: the discovery is (a) DEBOUNCED — the unsaved rules buffer changes
  // per keystroke, and the pre-LOBBY-A effect fired a compile on each one —
  // and (b) no longer skipped for a user-owned roster: it ALWAYS captures the
  // declared setup fields (the launch form) so a RESTORED config (seatsTouched)
  // gets the form too. Only the roster/grant derivation stays gated on the
  // untouched flag.
  useEffect(() => {
    if (code.trim() === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setDeriving(true);
      runExperienceTest({ rulesCode: code, actions: [] })
        .then((data) => {
          if (cancelled) return;
          const fields = data.definition.setup?.fields ?? [];
          setSetupFields(fields);
          seedDefaultsIntoSettings(fields);
          if (seatsTouched) return; // roster/grants are the user's explicit choice
          const declared = data.definition.declaredCapabilities.map((c) => c.capability);
          const hasParticipants = declared.includes(EXPERIENCE_CAPABILITY.participants);
          const hasModel = declared.includes(EXPERIENCE_CAPABILITY.model);
          // Derive grants from the declared capabilities.
          const derivedGrants = declared.filter((c): c is ExperienceCapability =>
            CAPABILITIES.includes(c as ExperienceCapability));
          setGrants(derivedGrants);
          // Derive seats: a human seat is always present; add a model seat when
          // both participants + model are declared.
          if (hasParticipants && hasModel) {
            setSeats([
              { id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human },
              { id: "ai", label: "AI", controller: EXPERIENCE_CONTROLLER.model },
            ]);
          }
        })
        .catch(() => {
          if (cancelled) return;
          // Discovery failed (broken rules): no setup fields (the JSON textarea
          // fallback applies) and the safe default single human seat plus empty
          // grants — but never clobber a user-owned roster.
          setSetupFields([]);
          if (seatsTouched) return;
          setSeats([{ id: "you", label: "You", controller: EXPERIENCE_CONTROLLER.human }]);
          setGrants([]);
        })
      .finally(() => { if (!cancelled) setDeriving(false); });
    }, DISCOVERY_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, seatsTouched]);

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

  /** XU-4: on-demand create-only discover over the STATELESS tester (the
   *  retired InteractiveTester's run path). Reuses the CURRENT roster/grants/
   *  settings/manual-seed so the diagnostics reflect the same context a start
   *  would use; the manual seed (not the random-start launch seed) keeps the
   *  result reproducible, matching the tester. */
  const handleDiscover = async () => {
    const settings = buildLaunchSettings();
    if (!settings.ok) {
      setError({ message: settings.message, console: [] });
      return;
    }
    setTesterBusy("run");
    setError(null);
    try {
      const data = await runExperienceTest({
        rulesCode: code,
        settings: settings.value,
        participants,
        capabilityGrants: [...grants],
        ...(seed.trim() !== "" ? { seed: seed.trim() } : {}),
        actions: [],
      });
      setTesterResult(data);
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
    try {
      const data = await simulateExperienceTest({
        rulesCode: code,
        settings: settings.value,
        participants,
        capabilityGrants: [...grants],
        ...(seed.trim() !== "" ? { seed: seed.trim() } : {}),
      });
      setSimResult(data);
    } catch (simError) {
      setError(toPlaygroundError(simError));
    } finally {
      setTesterBusy(null);
    }
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
  useEffect(() => {
    if (!frameReady || session === null) return;
    frameRef.current?.sendState({
      state: session.projection.state,
      actions: session.projection.actions,
      revision: session.revision,
      status: session.status,
    });
  }, [frameReady, session]);

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
      className={cn(monoCls, "mt-1.5 min-h-[34px]")}
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
   *  shape). Only wired when the shell provides the callback. */
  const handleAskCopilotAboutError = () => {
    if (onSendToCopilot === undefined || error === null) return;
    const digest = session !== null
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
            <AnimatedDisclosure open={setupOpen} className="mt-3 space-y-3">
            <div>
              <label className={lblCls}>{t("experience_setup_participants_label")}</label>
            {seats.map((seat, index) => (
              <div key={index} className="mb-2 rounded-xl border border-border bg-surface p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-dim font-ui text-sm font-semibold text-accent-t"
                  >
                    {seatInitial(seat)}
                  </div>
                  <input
                    className={cn(inputCls, "min-w-[7rem] flex-1")}
                    value={seat.label}
                    placeholder={t("experience_setup_participant_name_placeholder")}
                    aria-label={t("experience_playground_participant_name")}
                    onChange={(e) => updateSeatLabel(index, e.target.value)}
                  />
                  <div className="w-48 shrink-0">
                    <DropdownSelect
                      value={seat.controller}
                      options={CONTROLLERS.map((controller) => ({ id: controller, label: t(CONTROLLER_LABEL_KEY[controller]) }))}
                      searchable={false}
                      onChange={(value) => {
                        const controller = CONTROLLERS.find((c) => c === value);
                        if (controller !== undefined) {
                          if (controller !== EXPERIENCE_CONTROLLER.model) {
                            updateSeat(index, { controller, providerProfileId: undefined, modelId: undefined });
                          } else {
                            updateSeat(index, { controller });
                          }
                        }
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    aria-label={t("experience_setup_remove_participant")}
                    className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s3 hover:text-t1"
                    onClick={() => { setSeatsTouched(true); setSeats((prev) => prev.filter((_, i) => i !== index)); }}
                  >
                    <Ic.del />
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-10">
                  {editingIdIndex === index ? (
                    <input
                      autoFocus
                      className={cn(inputCls, "w-32")}
                      value={seat.id}
                      aria-label={t("experience_playground_participant_id")}
                      onChange={(e) => updateSeatId(index, e.target.value)}
                      onBlur={() => setEditingIdIndex(null)}
                      onKeyDown={(e) => { if (e.key === "Enter") setEditingIdIndex(null); }}
                    />
                  ) : (
                    <span className="font-mono text-[11px] text-t3">
                      {t("experience_playground_participant_id")}: <span className="text-t2" data-testid="playground-seat-id">{seat.id === "" ? "—" : seat.id}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t("experience_playground_participant_id_edit")}
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s3 hover:text-t1"
                    onClick={() => setEditingIdIndex(editingIdIndex === index ? null : index)}
                  >
                    <Ic.edit />
                  </button>
                </div>
                {seat.controller === EXPERIENCE_CONTROLLER.model && grants.includes(EXPERIENCE_CAPABILITY.model) && (
                  <div className="mt-1.5 flex flex-col gap-1.5 pl-10 sm:flex-row">
                    <div className="flex-1">
                      <DropdownSelect
                        value={seat.providerProfileId ?? ""}
                        options={providerOptions}
                        placeholder={t("experience_setup_provider_placeholder")}
                        onChange={(value) => {
                          updateSeat(index, { providerProfileId: value, modelId: undefined });
                          ensureModels(value);
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <DropdownSelect
                        value={seat.modelId ?? ""}
                        options={seat.providerProfileId ? modelOptionsFor(seat.providerProfileId) : []}
                        placeholder={loadingProfiles.has(seat.providerProfileId ?? "") ? t("experience_setup_loading_models") : t("experience_setup_model_placeholder")}
                        disabled={seat.providerProfileId === undefined}
                        onChange={(value) => updateSeat(index, { modelId: value })}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="mt-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={() => {
                setSeatsTouched(true);
                setSeats((prev) => {
                  const taken = new Set(prev.map((s) => s.id));
                  return [...prev, { id: uniqueIdFor("seat", taken), label: "", controller: EXPERIENCE_CONTROLLER.human, idAuto: true }];
                });
              }}
            >
              <Ic.plus /> {t("experience_setup_add_participant")}
            </button>
          </div>

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

          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <label className={lblCls}>{t("experience_playground_seed_label")}</label>
              <input
                className={cn(inputCls, "mt-1.5 h-[34px]", randomStart && "opacity-60")}
                value={randomStart ? lastUsedSeed : seed}
                placeholder={t(randomStart ? "experience_playground_seed_random_on" : "experience_tester_seed_placeholder")}
                disabled={randomStart}
                onChange={(e) => setSeed(e.target.value)}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <Toggle
                  checked={randomStart}
                  onChange={handleRandomStartChange}
                  aria-label={t("experience_playground_random_start")}
                />
                <span className="font-ui text-[12px] text-t2">{t("experience_playground_random_start")}</span>
              </div>
            </div>
            <div>
              <label className={lblCls}>{t("experience_playground_human_seat_label")}</label>
              <div className="mt-1.5">
                <DropdownSelect
                  value={humanSeatId}
                  options={participants.map((p) => ({ id: p.id, label: `${p.label} (${t(CONTROLLER_LABEL_KEY[p.controller])})` }))}
                  searchable={false}
                  placeholder={t("experience_playground_human_seat_auto")}
                  defaultOption={t("experience_playground_human_seat_auto")}
                  onChange={setHumanSeatId}
                  className="h-[34px]"
                />
              </div>
            </div>
            <div>
              <label className={lblCls}>{t("experience_setup_settings_label")}</label>
              {/* LOBBY-A: the package's declared setup fields render as a real
                  form (author defaults seeded into the JSON). The raw JSON
                  textarea is ALWAYS under a collapsed "advanced" disclosure
                  (verbatim: «жсон для технических пользователей под аккордеон
                  прятать») — never the default view, fields or not. */}
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
              {setupFields.length > 0 && settingsObject === null && (
                <p className="mt-1.5 font-ui text-[11px] leading-relaxed text-danger-text" role="alert">
                  {t("experience_playground_settings_json_invalid")}
                </p>
              )}
              {/* The raw JSON is ALWAYS under the collapsed "advanced"
                  disclosure — with or without declared fields (verbatim quote:
                  «жсон для технических пользователей под аккордеон прятать»);
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
          </div>
            </AnimatedDisclosure>
          </div>

          {/* Session controls: the prominent primary play action (XU-3). */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
              disabled={busy !== null || code.trim() === ""}
              onClick={() => void handleStart()}
            >
              {Ic.caret("r")}
              {t("experience_playground_start")}
            </button>
            {busy !== null && <span className="font-ui text-[12px] text-t3">{t("script_running")}</span>}
          </div>

          {/* Typed error (start or advance) — human first, tech under a
              disclosure, and a copilot escape hatch (XU-3). */}
          {error !== null && (
            <div className="mt-3 rounded-md border border-danger bg-danger-dim" style={{ padding: 10 }}>
              <div className="flex items-start gap-2">
                <span aria-hidden className="mt-0.5 shrink-0 text-danger-text"><Ic.alert /></span>
                <p className="font-ui text-[13px] leading-snug text-danger-text">{error.message}</p>
              </div>
              {onSendToCopilot !== undefined && (
                <button
                  type="button"
                  data-testid="playground-error-ask-copilot"
                  className="mt-2 flex h-8 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                  onClick={handleAskCopilotAboutError}
                >
                  <Ic.sparkles />
                  {t("experience_playground_error_ask_copilot")}
                </button>
              )}
              <div className="mt-2">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 text-left"
                  onClick={() => setErrorTechOpen((v) => !v)}
                  aria-expanded={errorTechOpen}
                >
                  <span className={cn("inline-block shrink-0 text-danger-text transition-transform", errorTechOpen && "rotate-90")}>
                    {Ic.caret("r")}
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-danger-text">{t("experience_playground_error_tech_details")}</span>
                </button>
                <AnimatedDisclosure open={errorTechOpen}>
                  <div className="mt-1.5 space-y-1.5">
                    {error.code !== undefined && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-semibold uppercase text-danger-text">{t("experience_playground_error_title")}</span>
                        <span className="rounded bg-danger/20 px-1.5 py-0.5 font-mono text-[10px] uppercase text-danger-text">{error.code}</span>
                      </div>
                    )}
                    <div className="space-y-0.5 font-ui text-[11px] text-t2">
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
                </AnimatedDisclosure>
              </div>
            </div>
          )}

          {/* Live session — novice-readable default: visual-first, status,
              legal actions. Raw diagnostics behind collapsed disclosure. */}
          {session !== null && (
            <div className="mt-3 space-y-3">
              {/* Ordinary-language status + session controls (XU-3): restart/
                  reset live next to the active-session status strip. */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-s3" style={{ padding: 8 }}>
                <span className="font-ui text-[12px] text-t2">{statusText}</span>
                {busy !== null && <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    className="h-8 cursor-pointer rounded-md border border-border bg-bg px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                    disabled={busy !== null}
                    onClick={handleRestart}
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

              {/* The REAL visual against the current playground state — primary view. */}
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

              {/* Legal actions — prominent one-click buttons (the novice interaction). */}
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
            </div>
          )}

          {/* Developer diagnostics — collapsed by default. Raw state, revision,
              request id, expected revision, payload JSON, events, effects, and
              console remain reachable after explicit disclosure. XU-4: also the
              absorbed tester (validate rules / auto-play / single action). */}
          <div className={cn(blockCls, "mt-3 p-3")}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 text-left"
                  onClick={() => setDiagnosticsOpen((v) => !v)}
                >
                  <span className="inline-block text-t3 transition-transform" style={{ transform: diagnosticsOpen ? "rotate(90deg)" : "none" }}>▶</span>
                  <span className={blockLabelCls}>{t("experience_playground_diagnostics")}</span>
                  <CustomTooltip content={t("experience_playground_diagnostics_hint")}>
                    <span className="cursor-help text-[11px] text-t4">ⓘ</span>
                  </CustomTooltip>
                </button>
                {diagnosticsOpen && (
                  <div className="mt-2 space-y-2">
                    {/* XU-4: absorbed tester — validate rules (create-only
                        discover) and auto-play script seats (bounded simulate).
                        Both run against the STATELESS tester and stay available
                        before/without a live session. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="playground-discover"
                        className="h-8 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                        disabled={testerBusy !== null || busy !== null || code.trim() === ""}
                        onClick={() => void handleDiscover()}
                      >
                        {t("experience_tester_run")}
                      </button>
                      <button
                        type="button"
                        data-testid="playground-simulate"
                        className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                        disabled={testerBusy !== null || busy !== null || code.trim() === ""}
                        onClick={() => void handleSimulate()}
                      >
                        {t("experience_tester_simulate")}
                      </button>
                      {testerBusy !== null && <span className="font-ui text-[12px] text-t3">{t("script_running")}</span>}
                    </div>

                    {testerResult !== null && <TestRunResultBlock result={testerResult} />}
                    {simResult !== null && <TestSimulateResultBlock result={simResult} />}

                    {/* ER-14 (absorbed): send the latest tester digest (discover
                        result → simulate result) to the copilot. */}
                    {onSendToCopilot !== undefined && (testerResult !== null || simResult !== null) && (
                      <button
                        type="button"
                        data-testid="playground-tester-send-to-copilot"
                        className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                        disabled={testerBusy !== null}
                        onClick={handleSendTesterToCopilot}
                      >
                        {t("experience_tester_send_to_copilot")}
                      </button>
                    )}

                    {/* Live-session diagnostics (send + definition + info +
                        custom action + raw state) — only while a session is live. */}
                    {session !== null && (
                      <>
                    {/* ER-14: send the live session diagnostics to the copilot
                        thread. Shown only when the shell wires the callback AND
                        a session is live. Lives INSIDE the Developer-diagnostics
                        disclosure per the user's intent. */}
                    {onSendToCopilot !== undefined && (
                      <button
                        type="button"
                        data-testid="playground-send-to-copilot"
                        className="h-8 cursor-pointer rounded-md border border-border bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                        disabled={busy !== null}
                        onClick={() => onSendToCopilot(buildPlaygroundDigest({ session, definition, error }))}
                      >
                        {t("experience_playground_send_diagnostics")}
                      </button>
                    )}

                    {definition !== null && (
                      <div>
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

                    {/* Custom action form (type/participant/payload/requestId/expectedRevision) */}
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={cn(inputCls, "w-40")}
                        value={actionType}
                        placeholder={t("experience_tester_action_type_placeholder")}
                        onChange={(e) => setActionType(e.target.value)}
                      />
                      <div className="w-44 shrink-0">
                        <DropdownSelect
                          value={actionParticipantId}
                          options={participants.map((p) => ({ id: p.id, label: `${p.label} (${t(CONTROLLER_LABEL_KEY[p.controller])})` }))}
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
                    <div>
                      <AutoTextarea
                        className={monoCls}
                        value={payloadJson}
                        onChange={(e) => setPayloadJson(e.target.value)}
                        placeholder={t("experience_tester_action_payload_label")}
                        minRows={1}
                        maxRows={12}
                        macroAutocomplete={false}
                      />
                    </div>

                    <div>
                      <div className={blockLabelCls}>{t("experience_tester_projection")}</div>
                      <JsonBlock value={session.projection.state} />
                    </div>

                    <div>
                      <div className={blockLabelCls}>{t("experience_tester_final_state")}</div>
                      <JsonBlock value={session.state} />
                    </div>

                    {session.events.length > 0 && (
                      <div>
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
                      <div>
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
                      </>
                    )}
                  </div>
                )}
              </div>
        </div>
    </div>
  );
}
