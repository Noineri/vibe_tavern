/**
 * Copilot test-feedback digest builders (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 5 / ER-14).
 *
 * The copilot backend renders `testFeedback` (POST body field on the copilot
 * stream endpoint) as a raw-JSON context section for the model — so the object
 * the frontend sends MUST be field-for-field compatible with one of the two
 * canonical digest shapes the model already sees from its OWN `run_test` /
 * `run_simulate` tools (defined in
 * `services/api/src/domain/interactive/copilot/experience-copilot-tools.ts`):
 *
 *   ExperienceCopilotRunTestDigest (create-only test):
 *     ok path:  { ok:true, status, revision, legalActionTypes[], stateSummary, consoleTail }
 *     fail path:{ ok:false, errorCode, errorKind?, errorMessage, consoleTail }
 *
 *   ExperienceCopilotRunSimulateDigest (bounded simulation):
 *     ok path:  { ok:true, stopReason, iterations, status, revision, consoleTail }
 *     fail path:{ ok:false, errorCode, errorKind?, errorMessage, consoleTail }
 *
 * The capping rules MUST match the backend EXACTLY (the model parses these two
 * sources uniformly): `consoleTail` keeps the last 20 entries, each formatted
 * `"level: args.join(' ')"`; `stateSummary` is `JSON.stringify(state)` capped at
 * 1500 chars with a trailing `\u2026` ellipsis when truncated.
 *
 * Pure — no React, no I/O, no store access. The two editor panels
 * (InteractiveTester, ExperiencePlayground) and the copilot shell compose these
 * builders with their `onSendToCopilot` callback so the user can push a test/
 * simulate/playground digest into the copilot thread as a user message (the
 * `text` field) carrying a structured `feedback` payload (the `testFeedback`
 * field, rendered as JSON context by the backend and surviving history
 * compaction).
 */
import type { ExperienceCopilotLaunchContext } from "@vibe-tavern/api-contracts";
import type {
  ExperiencePlaygroundData,
  ExperienceTestConsoleEntry,
  ExperienceTestRunData,
  ExperienceTestSimulateData,
} from "../api/types.js";
import type { LoopDiagSample } from "./experience-bridge.js";

/** The structured digest the model reads as context + its human-readable
 *  summary posted as the user message. */
export interface CopilotDigest {
  /** Human-readable summary posted as the user message. Plain data text (not
   *  localized prose) so the model reads it identically regardless of UI locale. */
  readonly text: string;
  /** Structured digest matching `ExperienceCopilotRunTestDigest` |
   *  `ExperienceCopilotRunSimulateDigest`, sent as `testFeedback` (rendered as
   *  JSON context by the backend). */
  readonly feedback: Record<string, unknown>;
}

/** Structural error input both `TesterErrorView` (InteractiveTester) and
 *  `PlaygroundErrorView` (ExperiencePlayground) satisfy. Both normalize from
 *  `ExperienceApiError` into the same `{message, code?, kind?, console}` shape;
 *  this structural type avoids importing the component-internal view types. */
export interface CopilotErrorInput {
  readonly message: string;
  readonly code?: string;
  readonly kind?: string;
  /** Captured VM console. */
  readonly console: ReadonlyArray<ExperienceTestConsoleEntry>;
}

/** Playground digest input. The playground session is a LIVE simulation, so its
 *  digest is shaped like the simulate digest (the closest backend match); an
 *  `error` flips it to the fail-path shape. Fields are picked defensively
 *  (optional chaining) so a partial envelope never throws. */
export interface CopilotPlaygroundDigestInput {
  readonly session: ExperiencePlaygroundData;
  readonly definition?: ExperienceTestRunData["definition"] | null;
  readonly error?: CopilotErrorInput | null;
}

// ─── Capping (MUST match the backend EXACTLY) ───────────────────────────────

/** Max entries retained in a digest's `consoleTail` (the model needs recent
 *  output, not the full trace). Mirrors `CONSOLE_TAIL_MAX` in
 *  experience-copilot-tools.ts. */
const CONSOLE_TAIL_MAX = 20;
/** Max chars of the projected state kept in `stateSummary` (avoids dumping the
 *  whole 256KB state into the model context). Mirrors `STATE_SUMMARY_MAX`. */
const STATE_SUMMARY_MAX = 1500;

/** Flatten the last {@link CONSOLE_TAIL_MAX} console entries to `level: args`
 *  strings. Structural typing on the entry shape avoids importing the sandbox
 *  type transitively. Mirrors `consoleTail` in experience-copilot-tools.ts. */
function consoleTail(entries: ReadonlyArray<ExperienceTestConsoleEntry>): string[] {
  return entries.slice(-CONSOLE_TAIL_MAX).map((e) => `${e.level}: ${e.args.join(" ")}`);
}

/** Compact JSON snapshot of an unknown projected state, capped to keep the
 *  model context bounded. Falls back to a placeholder for unserializable state.
 *  Mirrors `summarizeState` in experience-copilot-tools.ts (the default cap MUST
 *  match the backend exactly; the playground log channel passes its own larger
 *  cap — see `PLAYGROUND_LOG_STATE_MAX`). */
function summarizeState(state: unknown, max = STATE_SUMMARY_MAX): string {
  let s: string;
  try {
    s = JSON.stringify(state) ?? String(state);
  } catch {
    return "(unserializable state)";
  }
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

/** Standard footer appended to every digest's human-readable `text` so the
 *  model knows the structured payload is attached (it is NOT in the message
 *  body — it rides as the separate `testFeedback` context field). */
const ATTACHED_NOTE =
  "(The full structured digest is attached to this message as context.)";

// ─── Builders ───────────────────────────────────────────────────────────────

/** Per-seat legality lines for a digest's human-readable text (shared by the
 *  run-test digest and the playground log digest — one rendering of the
 *  seat/turn vocabulary the model reads). */
function seatLegalityLines(matrix: ExperienceTestRunData["seatLegality"], status: string): string[] {
  if (matrix.seats.length === 0) return [];
  return [
    `Turn: ${
      matrix.turnOwners.length > 0
        ? matrix.turnOwners.join(", ")
        : status === "completed"
          ? "— (completed)"
          : "—"
    }`,
    ...matrix.seats.map((seat) => {
      const list =
        seat.error !== undefined
          ? `actions() error: ${seat.error}`
          : seat.actionTypes.length > 0
            ? seat.actionTypes.join(", ")
            : "none";
      return `Seat "${seat.label}" (id "${seat.participantId}", ${seat.controller}): ${list}`;
    }),
  ];
}

/** A create-only test digest from a successful run. The feedback is the ok-path
 *  `ExperienceCopilotRunTestDigest` (`status`, `revision`, `legalActionTypes`,
 *  capped `stateSummary`, `consoleTail`) — plus `seatLegality` (per-seat matrix +
 *  turn owners; empty seats when the run carried no roster). */
export function buildRunTestDigest(result: ExperienceTestRunData): CopilotDigest {
  const seatLines = seatLegalityLines(result.seatLegality, result.status);
  const feedback: Record<string, unknown> = {
    ok: true,
    status: result.status,
    revision: result.revision,
    legalActionTypes: result.projection.actions.map((a) => a.type),
    stateSummary: summarizeState(result.projection.state),
    consoleTail: consoleTail(result.console),
    seatLegality: result.seatLegality,
  };
  const legalTypes = result.projection.actions.map((a) => a.type);
  const lines = [
    "## Test result (run_test)",
    `Definition: ${result.definition.manifest.name} (${result.definition.manifest.id}) \u00b7 apiVersion ${result.definition.apiVersion}`,
    `Status: ${result.status}`,
    `Revision: ${result.revision}`,
    `Legal action types: ${legalTypes.length > 0 ? legalTypes.join(", ") : "(none)"}`,
    ...seatLines,
    ATTACHED_NOTE,
  ];
  return { text: lines.join("\n"), feedback };
}

/** A create-only test failure digest. The feedback is the fail-path
 *  `ExperienceCopilotRunTestDigest` (`ok:false`, `errorCode`, `errorKind?`,
 *  `errorMessage`, `consoleTail`). The error code defaults to `"error"` when the
 *  source error carried none (the backend always has one from its typed result). */
export function buildRunTestErrorDigest(error: CopilotErrorInput): CopilotDigest {
  const feedback: Record<string, unknown> = {
    ok: false,
    errorCode: error.code ?? "error",
    ...(error.kind !== undefined ? { errorKind: error.kind } : {}),
    errorMessage: error.message,
    consoleTail: consoleTail(error.console),
  };
  const lines = [
    "## Test failed (run_test)",
    `Error: ${error.message}`,
    `Code: ${error.code ?? "(none)"}`,
    ...(error.kind !== undefined ? [`Kind: ${error.kind}`] : []),
    ATTACHED_NOTE,
  ];
  return { text: lines.join("\n"), feedback };
}

/** A bounded-simulation digest from a successful simulate. The feedback is the
 *  ok-path `ExperienceCopilotRunSimulateDigest` (`stopReason`, `iterations`,
 *  `status`, `revision`, `consoleTail`). */
export function buildSimulateDigest(simResult: ExperienceTestSimulateData): CopilotDigest {
  const feedback: Record<string, unknown> = {
    ok: true,
    stopReason: simResult.stopReason,
    iterations: simResult.iterations,
    status: simResult.status,
    revision: simResult.revision,
    consoleTail: consoleTail(simResult.console),
  };
  const lines = [
    "## Simulation result (run_simulate)",
    `Stop reason: ${simResult.stopReason}`,
    `Iterations: ${simResult.iterations}`,
    `Status: ${simResult.status}`,
    `Revision: ${simResult.revision}`,
    ATTACHED_NOTE,
  ];
  return { text: lines.join("\n"), feedback };
}

/** A live-playground diagnostics digest. The playground is a live simulation, so
 *  its digest is shaped like the simulate digest (the closest backend match):
 *  an absent `error` yields the ok path; an `error` flips it to the fail path.
 *  Fields are picked defensively so a partial envelope never throws. */
export function buildPlaygroundDigest(args: CopilotPlaygroundDigestInput): CopilotDigest {
  const { session, error } = args;
  // `iterations` is the closest available proxy for a live playground (it has
  // no bounded-iteration count); use the event count so the model has a signal.
  const iterations = session.events.length;

  const feedback: Record<string, unknown> = {
    ok: !error,
    stopReason: session.stopReason,
    iterations,
    status: session.status,
    revision: session.revision,
    consoleTail: consoleTail(session.console),
    ...(error
      ? {
          errorCode: error.code ?? "error",
          ...(error.kind !== undefined ? { errorKind: error.kind } : {}),
          errorMessage: error.message,
        }
      : {}),
  };

  const defName = args.definition?.manifest.name ?? "(unknown)";
  const defId = args.definition?.manifest.id ?? "(unknown)";
  const lines = [
    "## Playground diagnostics",
    `Definition: ${defName} (${defId})`,
    `Revision: ${session.revision}`,
    `Status: ${session.status}`,
    `Stop reason: ${session.stopReason}`,
    `Events: ${session.events.length}`,
    `Effects: ${session.effects.length}`,
    ...(error
      ? [`Error: ${error.message}`, `Code: ${error.code ?? "(none)"}`]
      : []),
    ATTACHED_NOTE,
  ];
  return { text: lines.join("\n"), feedback };
}

// ─── Playground full-session log digest (grounding step 6) ──────────────────

/** Caps for the playground LOG channel. Deliberately NOT the mirrored tool
 *  caps above (`CONSOLE_TAIL_MAX` / `STATE_SUMMARY_MAX` stay byte-identical to
 *  the backend tools so a UI-sent tool digest equals the tool's own): the log
 *  channel exists so the model can read the WHOLE session, so it keeps its own
 *  larger bounds (EXPERIENCE_COPILOT_GROUNDING_REPORT step 6 / D5.4). */
const PLAYGROUND_LOG_EVENTS_MAX = 200;
const PLAYGROUND_LOG_CONSOLE_MAX = 100;
const PLAYGROUND_LOG_STATE_MAX = 8000;

/** The client-side whole-session accumulator (component state in
 *  ExperiencePlayground): the server returns every event on START but only the
 *  CURRENT turn's events/effects/console on advance and timer beats (D5.3), so
 *  the full log is stitched client-side. `turns` counts applied HUMAN turns
 *  (advances); timer beats append their deltas without counting a turn. */
export interface PlaygroundSessionLog {
  readonly events: ReadonlyArray<ExperiencePlaygroundData["events"][number]>;
  readonly effects: ReadonlyArray<ExperiencePlaygroundData["effects"][number]>;
  readonly console: ReadonlyArray<ExperienceTestConsoleEntry>;
  readonly turns: number;
}

export interface CopilotPlaygroundLogDigestInput {
  readonly session: ExperiencePlaygroundData;
  readonly sessionLog: PlaygroundSessionLog;
  readonly definition?: ExperienceTestRunData["definition"] | null;
  readonly error?: CopilotErrorInput | null;
  /** How the session was launched (roster/grants/seed, captured at start so
   *  the log reflects the run, not the since-edited live config). Echoed with
   *  the same vocabulary the copilot's own tools use in their digest
   *  `launchContext`, so the model reads one shape across channels. */
  readonly launchContext?: ExperienceCopilotLaunchContext | null;
  /** Per-seat legality matrix, where the caller has one — the playground
   *  session envelope carries only the projected seat's actions. */
  readonly seatLegality?: ExperienceTestRunData["seatLegality"] | null;
}

/** The WHOLE-session playground log digest (grounding step 6): unlike the
 *  mirrored tool digests, this carries the full accumulated session — every
 *  event (last {@link PLAYGROUND_LOG_EVENTS_MAX} + total count), the effects,
 *  the console (last {@link PLAYGROUND_LOG_CONSOLE_MAX} + total count), the
 *  authoritative final state (capped at {@link PLAYGROUND_LOG_STATE_MAX} — the
 *  projected view may hide the very fields turn bugs hinge on), the projected
 *  seat's legal actions (+ the per-seat matrix where present), and the launch
 *  roster/grants/seed. An `error` flips it to the fail-path fields. */
export function buildPlaygroundLogDigest(args: CopilotPlaygroundLogDigestInput): CopilotDigest {
  const { session, sessionLog, error, launchContext, seatLegality } = args;
  const defName = args.definition?.manifest.name ?? "(unknown)";
  const defId = args.definition?.manifest.id ?? "(unknown)";

  const events = sessionLog.events.slice(-PLAYGROUND_LOG_EVENTS_MAX);
  const consoleLines = sessionLog.console
    .slice(-PLAYGROUND_LOG_CONSOLE_MAX)
    .map((e) => `${e.level}: ${e.args.join(" ")}`);
  const legalTypes = session.projection.actions.map((a) => a.type);

  const feedback: Record<string, unknown> = {
    ok: !error,
    definition: { id: defId, name: defName },
    status: session.status,
    revision: session.revision,
    stopReason: session.stopReason,
    turns: sessionLog.turns,
    legalActionTypes: legalTypes,
    ...(seatLegality !== null && seatLegality !== undefined ? { seatLegality } : {}),
    ...(launchContext !== null && launchContext !== undefined
      ? {
          launchContext: {
            seats: launchContext.participants.map((p) => ({ id: p.id, controller: p.controller })),
            grants: [...launchContext.capabilityGrants],
            ...(launchContext.seed !== undefined ? { seed: launchContext.seed } : {}),
          },
        }
      : {}),
    stateSummary: summarizeState(session.state, PLAYGROUND_LOG_STATE_MAX),
    effects: [...sessionLog.effects],
    events,
    eventsTotal: sessionLog.events.length,
    console: consoleLines,
    consoleTotal: sessionLog.console.length,
    ...(error
      ? {
          errorCode: error.code ?? "error",
          ...(error.kind !== undefined ? { errorKind: error.kind } : {}),
          errorMessage: error.message,
        }
      : {}),
  };

  const seatLines =
    seatLegality !== null && seatLegality !== undefined
      ? seatLegalityLines(seatLegality, session.status)
      : [];
  const lines = [
    "## Playground session log",
    `Definition: ${defName} (${defId})`,
    `Status: ${session.status} · Revision ${session.revision} · Stop reason: ${session.stopReason}`,
    `Turns: ${sessionLog.turns} · Events: ${sessionLog.events.length} · Effects: ${sessionLog.effects.length}`,
    `Legal action types: ${legalTypes.length > 0 ? legalTypes.join(", ") : "(none)"}`,
    ...seatLines,
    ...(launchContext !== null && launchContext !== undefined
      ? [
          `Seats: ${launchContext.participants.map((p) => `${p.id} (${p.controller})`).join(", ")} · Grants: ${
            launchContext.capabilityGrants.length > 0
              ? launchContext.capabilityGrants.join(", ")
              : "(none)"
          }${launchContext.seed !== undefined ? ` · Seed: ${launchContext.seed}` : ""}`,
        ]
      : []),
    "State: (attached in stateSummary)",
    `Effects: ${
      sessionLog.effects.length > 0
        ? sessionLog.effects.map((e) => `${e.kind}: ${JSON.stringify(e.request)}`).join(" | ")
        : "none"
    }`,
    `Events (${sessionLog.events.length} total, last ${events.length}): ${
      events.length > 0 ? events.map((e) => `${e.visibility}/${e.type}`).join(" | ") : "none"
    }`,
    `Console (${sessionLog.console.length} total, last ${consoleLines.length}): ${
      consoleLines.length > 0 ? consoleLines.join(" ⏎ ") : "silent"
    }`,
    ...(error ? [`Error: ${error.message}`, `Code: ${error.code ?? "(none)"}`] : []),
    ATTACHED_NOTE,
  ];
  return { text: lines.join("\n"), feedback };
}

// ─── Realtime digest (RM-13) ───────────────────────────────────────────────

/** Bounds for the realtime digest tails (the SDK sample is already bounded;
 *  these caps keep the MODEL context lean — tails, not transcripts). Raised
 *  12/6/12 → 100/50/100 by EXPERIENCE_COPILOT_GROUNDING_REPORT step 6: the
 *  realtime digest doubles as the sandbox LOG channel for realtime rounds, so
 *  the tails must carry a playable round, not a glimpse. */
const RT_EVENT_TAIL_MAX = 100;
const RT_ERROR_TAIL_MAX = 50;
const RT_CONSOLE_TAIL_MAX = 100;

/** Compact `kind: …` rendering of a round-log event for the model. */
function rtEventLine(event: unknown): string {
  if (typeof event === "object" && event !== null && "kind" in event) {
    const e = event as { kind: unknown };
    let s = String(e.kind);
    try {
      const rest = JSON.stringify(event);
      if (rest !== undefined && rest.length <= 400) s += `: ${rest}`;
    } catch { /* unserializable — kind only */ }
    return s;
  }
  return String(event);
}

/** Compact `kind: message` rendering of a loop error for the model. */
function rtErrorLine(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { kind?: unknown; message?: unknown };
    const kind = typeof e.kind === "string" ? e.kind : "error";
    const msg = typeof e.message === "string" ? e.message : JSON.stringify(err) ?? "";
    return `${kind}: ${msg}`;
  }
  return String(err);
}

export interface CopilotRealtimeDigestInput {
  /** The realtime loop config (tickMs + seed for the header). */
  readonly realtime: { readonly tickMs: number; readonly seed: number };
  /** The latest loop diagnostics sample (replace semantics; may be null when
   *  the loop never armed — itself a diagnostic: "nothing ever fired"). */
  readonly diag: LoopDiagSample | null;
  /** The finalized round claim, once the loop finished (optional). */
  readonly claim?: { readonly status: string } | null;
  readonly definition?: ExperienceTestRunData["definition"] | null;
  readonly error?: CopilotErrorInput | null;
}

/** A REALTIME playground digest (RM-13). The realtime round's authority lives
 *  inside the sandbox frame — the turn-session shape (stopReason/revision of
 *  the server sim) is a LIE for realtime rounds, so this builder reports the
 *  loop's own observability sample instead: liveness (event tail incl.
 *  round_started), the latest projection sample, loop errors, and the frame
 *  console. Matches `ExperienceCopilotRealtimeDigest` in the backend tools. */
export function buildRealtimeLoopDigest(args: CopilotRealtimeDigestInput): CopilotDigest {
  const { realtime, diag, claim, error } = args;
  const booted = diag !== null;
  const status = claim !== null && claim !== undefined ? claim.status : booted ? "running" : "not_booted";

  const eventTail = diag ? diag.events.slice(-RT_EVENT_TAIL_MAX).map(rtEventLine) : [];
  const errorTail = diag ? diag.errors.slice(-RT_ERROR_TAIL_MAX).map(rtErrorLine) : [];
  const consoleTail = diag
    ? diag.console.slice(-RT_CONSOLE_TAIL_MAX).map((c) => `${c.level}: ${c.text}`)
    : [];

  const feedback: Record<string, unknown> = {
    ok: !error,
    mode: "realtime",
    tickMs: realtime.tickMs,
    seed: realtime.seed,
    status,
    ...(diag?.view !== undefined ? { stateSummary: summarizeState(diag.view) } : {}),
    ...(eventTail.length > 0 ? { eventTail } : {}),
    ...(errorTail.length > 0 ? { errorTail } : {}),
    ...(consoleTail.length > 0 ? { consoleTail } : {}),
    ...(error
      ? {
          errorCode: error.code ?? "error",
          ...(error.kind !== undefined ? { errorKind: error.kind } : {}),
          errorMessage: error.message,
        }
      : {}),
  };

  const defName = args.definition?.manifest.name ?? "(unknown)";
  const defId = args.definition?.manifest.id ?? "(unknown)";
  const lines = [
    "## Playground diagnostics (realtime loop)",
    `Definition: ${defName} (${defId})`,
    `Mode: realtime · tick ${realtime.tickMs}ms · seed ${realtime.seed}`,
    `Loop status: ${status}`,
    diag?.view !== undefined ? "State sample: (attached in stateSummary)" : "State sample: none (loop never posted a view)",
    `Loop events (tail ${eventTail.length}): ${eventTail.length > 0 ? eventTail.join(" | ") : "none"}`,
    `Loop errors (tail ${errorTail.length}): ${errorTail.length > 0 ? errorTail.join(" | ") : "none"}`,
    `Frame console (tail ${consoleTail.length}): ${consoleTail.length > 0 ? consoleTail.join(" ⏎ ") : "silent"}`,
    ...(error ? [`Error: ${error.message}`, `Code: ${error.code ?? "(none)"}`] : []),
    ATTACHED_NOTE,
  ];
  return { text: lines.join("\n"), feedback };
}
