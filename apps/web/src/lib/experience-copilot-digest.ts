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
 *  Mirrors `summarizeState` in experience-copilot-tools.ts. */
function summarizeState(state: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(state) ?? String(state);
  } catch {
    return "(unserializable state)";
  }
  return s.length > STATE_SUMMARY_MAX ? `${s.slice(0, STATE_SUMMARY_MAX)}\u2026` : s;
}

/** Standard footer appended to every digest's human-readable `text` so the
 *  model knows the structured payload is attached (it is NOT in the message
 *  body — it rides as the separate `testFeedback` context field). */
const ATTACHED_NOTE =
  "(The full structured digest is attached to this message as context.)";

// ─── Builders ───────────────────────────────────────────────────────────────

/** A create-only test digest from a successful run. The feedback is the ok-path
 *  `ExperienceCopilotRunTestDigest` (`status`, `revision`, `legalActionTypes`,
 *  capped `stateSummary`, `consoleTail`) — plus `seatLegality` when the run
 *  carried a roster (per-seat matrix + turn owners). */
export function buildRunTestDigest(result: ExperienceTestRunData): CopilotDigest {
  const matrix = result.seatLegality;
  const seatLines =
    matrix !== undefined && matrix.seats.length > 0
      ? [
          `Turn: ${
            matrix.turnOwners.length > 0
              ? matrix.turnOwners.join(", ")
              : result.status === "completed"
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
        ]
      : [];
  const feedback: Record<string, unknown> = {
    ok: true,
    status: result.status,
    revision: result.revision,
    legalActionTypes: result.projection.actions.map((a) => a.type),
    stateSummary: summarizeState(result.projection.state),
    consoleTail: consoleTail(result.console),
    ...(matrix !== undefined ? { seatLegality: matrix } : {}),
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

// ─── Realtime digest (RM-13) ───────────────────────────────────────────────

/** Bounds for the realtime digest tails (the SDK sample is already bounded;
 *  these caps keep the MODEL context lean — tails, not transcripts). */
const RT_EVENT_TAIL_MAX = 12;
const RT_ERROR_TAIL_MAX = 6;
const RT_CONSOLE_TAIL_MAX = 12;

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
