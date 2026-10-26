/**
 * Copilot test-feedback digest builders (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 5 / ER-14; uncapped per owner decision 2026-10-18, AS-8e7c).
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
 * There are NO caps (owner decision 2026-10-18, AS-8e7c): the tool and UI
 * digests agree field-for-field, but the UI-sent `feedback` attaches the
 * WHOLE session — `consoleTail` carries EVERY console entry formatted
 * `"level: args.join(' ')"`, `stateSummary` is the FULL `JSON.stringify(state)`
 * (with an `(unserializable state)` fallback), and the playground-log /
 * realtime feedbacks carry EVERY event, effect, and error line plus their
 * totals (`eventsTotal`, `consoleTotal`).
 *
 * The chat-message `text` stays small enough for the stream request's
 * 50 000-char cap
 * (`packages/api-contracts/src/schemas/experience-copilot-schema.ts`) by showing
 * COUNTS instead of lines (`Events: 250 (attached)`); the `fullText` sibling
 * on the log digests carries the same header lines plus every event, effect,
 * and console line for the «Copy log» clipboard path, which must lose nothing.
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
   *  localized prose) so the model reads it identically regardless of UI locale.
   *  For the log digests this shows COUNTS instead of lines (see
   *  {@link CopilotLogDigest.fullText} for the copy-paste text). */
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
/** A digest that ALSO carries the full copy-paste text: the same header lines
 *  as {@link CopilotDigest.text} plus every event, effect, and console line
 *  (the pre-AS-8e7c line formats, uncapped). The chat-message `text` shows
 *  counts only so a long session never pushes the message past the stream
 *  request's 50 000-char cap; `fullText` feeds the «Copy log» clipboard path
 *  so the copy loses nothing. Never sent to the model. */
export interface CopilotLogDigest extends CopilotDigest {
  /** Full copy text: headers + every line. */
  readonly fullText: string;
}

export interface CopilotPlaygroundDigestInput {
  readonly session: ExperiencePlaygroundData;
  readonly definition?: ExperienceTestRunData["definition"] | null;
  readonly error?: CopilotErrorInput | null;
}

// ─── No caps (owner decision 2026-10-18, AS-8e7c) ────────────────────────────
// These builders formerly mirrored the backend `CONSOLE_TAIL_MAX` /
// `STATE_SUMMARY_MAX` bounds; the UI-sent digests now attach the WHOLE session,
// so every entry and the full state JSON ride the feedback. Field names stay
// identical so the model parses them uniformly with the tools' own digests.

/** Flatten EVERY console entry to `level: args` strings. Structural typing on
 *  the entry shape avoids importing the sandbox type transitively. Mirrors
 *  `consoleTail` in experience-copilot-tools.ts, minus the backend's cap. */
function consoleTail(entries: ReadonlyArray<ExperienceTestConsoleEntry>): string[] {
  return entries.map((e) => `${e.level}: ${e.args.join(" ")}`);
}

/** Full JSON snapshot of an unknown projected state. Falls back to a
 *  placeholder for unserializable state. Mirrors `summarizeState` in
 *  experience-copilot-tools.ts, minus the backend's cap. */
function serializeState(state: unknown): string {
  try {
    return JSON.stringify(state) ?? String(state);
  } catch {
    return "(unserializable state)";
  }
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
 *  full `stateSummary`, full `consoleTail`) — plus `seatLegality` (per-seat
 *  matrix + turn owners; empty seats when the run carried no roster). */
export function buildRunTestDigest(result: ExperienceTestRunData): CopilotDigest {
  const seatLines = seatLegalityLines(result.seatLegality, result.status);
  const feedback: Record<string, unknown> = {
    ok: true,
    status: result.status,
    revision: result.revision,
    legalActionTypes: result.projection.actions.map((a) => a.type),
    stateSummary: serializeState(result.projection.state),
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

// The playground LOG channel carries the WHOLE session in `feedback` (no caps
// — owner decision 2026-10-18, AS-8e7c); the chat-message `text` shows counts
// only, and `fullText` carries every line for the «Copy log» clipboard path.

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
 *  mirrored tool digests, this carries the full accumulated session — EVERY
 *  event (+ total count), the effects, EVERY console line (+ total count), the
 *  authoritative final state in full (the projected view may hide the very
 *  fields turn bugs hinge on), the projected seat's legal actions (+ the
 *  per-seat matrix where present), and the launch roster/grants/seed.
 *  An `error` flips it to the fail-path fields. The chat-message `text` shows
 *  counts only; `fullText` carries every line for the «Copy log» path. */
export function buildPlaygroundLogDigest(args: CopilotPlaygroundLogDigestInput): CopilotLogDigest {
  const { session, sessionLog, error, launchContext, seatLegality } = args;
  const defName = args.definition?.manifest.name ?? "(unknown)";
  const defId = args.definition?.manifest.id ?? "(unknown)";

  const events = [...sessionLog.events];
  const consoleLines = sessionLog.console.map((e) => `${e.level}: ${e.args.join(" ")}`);
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
    stateSummary: serializeState(session.state),
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
  const errorLines = error ? [`Error: ${error.message}`, `Code: ${error.code ?? "(none)"}`] : [];
  const headerLines = [
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
  ];
  // Chat message: counts only, so a long session never pushes the message
  // past the stream request's 50 000-char cap.
  const text = [
    ...headerLines,
    "State: (attached in stateSummary)",
    `Effects: ${sessionLog.effects.length} (attached)`,
    `Events: ${sessionLog.events.length} (attached)`,
    `Console: ${sessionLog.console.length} lines (attached)`,
    ...errorLines,
    ATTACHED_NOTE,
  ].join("\n");
  // Clipboard copy: the same headers plus EVERY line (the old line formats,
  // no caps) — the copy must lose nothing.
  const fullText = [
    ...headerLines,
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
    ...errorLines,
    ATTACHED_NOTE,
  ].join("\n");
  return { text, fullText, feedback };
}

// ─── Realtime digest (RM-13) ───────────────────────────────────────────────
// No caps (owner decision 2026-10-18, AS-8e7c): the realtime digest doubles as
// the sandbox LOG channel for realtime rounds, so the feedback carries EVERY
// loop event, error, and frame-console line; the chat-message `text` shows
// counts only, and `fullText` carries every line for the «Copy log» path.

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
 *  loop's own observability sample instead: liveness (every event incl.
 *  round_started), the latest projection sample, loop errors, and the frame
 *  console. Matches `ExperienceCopilotRealtimeDigest` in the backend tools
 *  field-for-field, minus the backend's caps. The chat-message `text` shows
 *  counts only; `fullText` carries every line for the «Copy log» path. */
export function buildRealtimeLoopDigest(args: CopilotRealtimeDigestInput): CopilotLogDigest {
  const { realtime, diag, claim, error } = args;
  const booted = diag !== null;
  const status = claim !== null && claim !== undefined ? claim.status : booted ? "running" : "not_booted";

  const eventLines = diag ? diag.events.map(rtEventLine) : [];
  const errorLines = diag ? diag.errors.map(rtErrorLine) : [];
  const frameConsoleLines = diag
    ? diag.console.map((c) => `${c.level}: ${c.text}`)
    : [];

  const feedback: Record<string, unknown> = {
    ok: !error,
    mode: "realtime",
    tickMs: realtime.tickMs,
    seed: realtime.seed,
    status,
    ...(diag?.view !== undefined ? { stateSummary: serializeState(diag.view) } : {}),
    ...(eventLines.length > 0 ? { eventTail: eventLines } : {}),
    ...(errorLines.length > 0 ? { errorTail: errorLines } : {}),
    ...(frameConsoleLines.length > 0 ? { consoleTail: frameConsoleLines } : {}),
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
  const errorTextLines = error ? [`Error: ${error.message}`, `Code: ${error.code ?? "(none)"}`] : [];
  const headerLines = [
    "## Playground diagnostics (realtime loop)",
    `Definition: ${defName} (${defId})`,
    `Mode: realtime · tick ${realtime.tickMs}ms · seed ${realtime.seed}`,
    `Loop status: ${status}`,
    diag?.view !== undefined ? "State sample: (attached in stateSummary)" : "State sample: none (loop never posted a view)",
  ];
  // Chat message: counts only, so a long round never pushes the message past
  // the stream request's 50 000-char cap.
  const text = [
    ...headerLines,
    `Loop events: ${eventLines.length} (attached)`,
    `Loop errors: ${errorLines.length} (attached)`,
    `Frame console: ${frameConsoleLines.length} lines (attached)`,
    ...errorTextLines,
    ATTACHED_NOTE,
  ].join("\n");
  // Clipboard copy: the same headers plus EVERY line — the copy must lose
  // nothing.
  const fullText = [
    ...headerLines,
    `Loop events (${eventLines.length} total): ${eventLines.length > 0 ? eventLines.join(" | ") : "none"}`,
    `Loop errors (${errorLines.length} total): ${errorLines.length > 0 ? errorLines.join(" | ") : "none"}`,
    `Frame console (${frameConsoleLines.length} total): ${frameConsoleLines.length > 0 ? frameConsoleLines.join(" ⏎ ") : "silent"}`,
    ...errorTextLines,
    ATTACHED_NOTE,
  ].join("\n");
  return { text, fullText, feedback };
}
