/**
 * Experience kernel — FRAME PORT (REALTIME_EXPERIENCE_MODE_PLAN, RM-3).
 *
 * The execution surface of the server kernel
 * (`services/api/src/domain/interactive/experience-kernel.ts`) ported to the
 * browser: discover/create/project/actions/reduce/update/choose/flavor with the
 * SAME input freezing, the SAME bounded-JSON validation, the SAME transition
 * normalization, and the SAME error taxonomy — so a realtime round that ticks
 * frame-side produces byte-identical state transitions to the server's
 * round-commit replay (RM-8) re-running the same log from the session seed.
 *
 * TRUST POSTURE — what this module is and is NOT. It is NOT a security
 * boundary: there is no `node:vm` here. Author code executes via the `Function`
 * constructor directly inside the isolated experience iframe, and the iframe
 * (`sandbox="allow-scripts"`, opaque origin, network-closed CSP) IS the sandbox.
 * The port's job is VALIDATION PARITY: freezing host inputs, bounding outputs,
 * schema-validating transitions, and surfacing typed failures — identical rules
 * to the server kernel. The frame's CSP must allow the Function constructor
 * (`script-src 'unsafe-eval'`); that grants the author nothing they do not
 * already have, because the visual source is arbitrary inline script in the
 * same frame by design.
 *
 * DIVERGENCES from the server sandbox (each is a documented contract, not an
 * oversight):
 *  - **No CPU timeout.** A browser cannot interrupt synchronous code. A hanging
 *    method freezes the round, not the app (the loop host detects the missed
 *    ticks at the frame boundary and declares the round lost). The `timeoutMs`
 *    parameter is therefore absent from every API below.
 *  - **No source hash.** Snapshot isolation (`sourceHash`) is a server-side
 *    concern; the frame receives source the host already pinned, so discovery
 *    returns the definition without re-deriving a hash.
 *  - **Frame globals are visible.** The server allowlists VM globals; inside
 *    the frame the author code shares the frame's real globals with its own
 *    visual. Rules methods that touch DOM or other frame APIs will diverge from
 *    the server replay (which has no DOM) and fail round-commit verification —
 *    the authoring contract (RM-11 assets) forbids DOM access in rules methods.
 *  - **Sloppy top-level globals persist across calls** in one frame session
 *    (the server runs each call in a fresh VM). Packages that rely on cross-call
 *    globals diverge from replay and fail commit verification the same way.
 *
 * PARITY SOURCES (single-source-of-truth imports, never duplicated): the
 * transition/action/viewer/definition schemas and JSON bounds come from
 * `@vibe-tavern/api-contracts` (the same zod schemas the server kernel parses
 * with); the deterministic PRNG, the frozen `helpers` namespace, and the
 * payload-schema DSL come from `@vibe-tavern/domain` (relocated there by RM-3
 * precisely so both realms share bit-identical code). What IS mirrored here are
 * the thin validation wrappers and the execution core — their equivalence is
 * pinned by the mirrored-fixture tests beside this module, and any residual
 * drift is caught structurally: a stricter port kills the round early, a looser
 * port is rejected by the RM-8 replay hash check. Either way it can never
 * corrupt committed state.
 */

import {
  experienceActionDescriptorSchema,
  experienceActionSchema,
  experienceDefinitionSchema,
  experienceTransitionSchema,
  experienceViewerSchema,
  INTERACTIVE_SCHEMA_MAX_ACTIONS,
  INTERACTIVE_SCHEMA_MAX_DEPTH,
  INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES,
  jsonBoundsError,
} from "@vibe-tavern/api-contracts";
import {
  experienceHelpers,
  validatePayloadSchemaDefinition,
  validatePayloadValue,
  type DeterministicRandom,
  type EphemeralRandom,
  type ExperienceAction,
  type ExperienceActionDescriptor,
  type ExperienceDeclaredCapability,
  type ExperienceManifest,
  type ExperienceParticipant,
  type ExperienceSetupDefinition,
  type ExperienceTransition,
  type ExperienceViewer,
} from "@vibe-tavern/domain";
import { z } from "zod";

// Re-exports for frame hosts (the loop host builds the seeded cursor from the
// round seed through the SAME domain primitive the server replay uses).
export { createDeterministicRandom, createEphemeralRandom } from "@vibe-tavern/domain";
export type {
  DeterministicRandom,
  EphemeralRandom,
  ExperienceAction,
  ExperienceActionDescriptor,
  ExperienceDeclaredCapability,
  ExperienceManifest,
  ExperienceParticipant,
  ExperienceSetupDefinition,
  ExperienceTransition,
  ExperienceViewer,
} from "@vibe-tavern/domain";

// ─── Console capture (mirrors the sandbox's capturing console) ───────────────

export interface ExperienceConsoleEntry {
  level: "log" | "warn" | "error";
  args: string[];
}

function makeCapturingConsole(buffer: ExperienceConsoleEntry[]): {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  return {
    log: (...args: unknown[]) => {
      buffer.push({ level: "log", args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => {
      buffer.push({ level: "warn", args: stringifyArgs(args) });
    },
    error: (...args: unknown[]) => {
      buffer.push({ level: "error", args: stringifyArgs(args) });
    },
  };
}

function stringifyArgs(args: readonly unknown[]): string[] {
  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
}

// ─── Method vocabulary (mirrors the sandbox constants) ───────────────────────

/** The four mandatory rules methods every experience must define. */
export const EXPERIENCE_FRAME_MANDATORY_METHODS = [
  "create",
  "project",
  "actions",
  "reduce",
] as const;

/** The optional methods (`update` = realtime fixed-timestep tick, RM-2). */
export const EXPERIENCE_FRAME_OPTIONAL_METHODS = ["choose", "flavor", "update"] as const;

export type ExperienceFrameMethodName =
  | (typeof EXPERIENCE_FRAME_MANDATORY_METHODS)[number]
  | (typeof EXPERIENCE_FRAME_OPTIONAL_METHODS)[number];

// ─── Typed failures ──────────────────────────────────────────────────────────

/**
 * The sandbox failure kinds minus `timeout` (impossible to detect here — a
 * browser cannot interrupt synchronous author code; see the header).
 */
export type ExperienceFrameExecutionErrorKind =
  | "syntax"
  | "runtime"
  | "no_registration"
  | "multi_registration"
  | "missing_method";

export type ExperienceFrameErrorKind =
  | ExperienceFrameExecutionErrorKind
  | "invalid_definition"
  | "invalid_state"
  | "invalid_view"
  | "invalid_actions"
  | "invalid_transition"
  | "illegal_action"
  | "async_return";

export interface ExperienceKernelError {
  readonly ok: false;
  readonly kind: ExperienceFrameErrorKind;
  readonly message: string;
  readonly console: ExperienceConsoleEntry[];
}

// ─── Result envelopes ────────────────────────────────────────────────────────

export interface ExperienceRunSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly console: ExperienceConsoleEntry[];
}

export type ExperienceRunResult<T> = ExperienceRunSuccess<T> | ExperienceKernelError;

/** The validated discovery output (no `sourceHash` — the host owns pinning). */
export interface ExperienceDefinition {
  readonly apiVersion: number;
  readonly manifest: ExperienceManifest;
  readonly declaredCapabilities: ExperienceDeclaredCapability[];
  /** Whether the optional `choose` method is present (script-controlled seats). */
  readonly hasChoose: boolean;
  /** Whether the optional `flavor` method is present (display-time cosmetic). */
  readonly hasFlavor: boolean;
  /** Whether the optional `update` method is present (realtime ticks). */
  readonly hasUpdate: boolean;
  /** Optional package-authored setup-field descriptor (IR-70F). */
  readonly setup?: ExperienceSetupDefinition;
}

export interface ExperienceDiscoveryResult {
  readonly ok: true;
  readonly definition: ExperienceDefinition;
  readonly console: ExperienceConsoleEntry[];
}

// ─── Granted capabilities (mirrors the kernel's synchronous context surface) ─

/**
 * The capabilities the frame host injects into the method-call context. Only
 * `participants` and `deterministic_random` are synchronous context APIs;
 * `chance` is the ephemeral source injected into `choose`/`flavor` only.
 */
export interface ExperienceCapabilityContext {
  readonly participants?: readonly ExperienceParticipant[];
  readonly random?: DeterministicRandom;
  /** Ephemeral (non-recorded) randomness — injected into `choose`/`flavor` only. */
  readonly chance?: EphemeralRandom;
}

/** A script-chosen move intent (mirrors the kernel's `choose` output). */
export interface ExperienceChosenIntent {
  readonly type: string;
  readonly participantId?: string;
  readonly payload?: unknown;
}

// ─── Execution core (the Function-constructor analogue of the node:vm sandbox) ─
/**
 * Execute author code with the given sandbox names as FUNCTION PARAMETERS (the
 * closest browser analogue of `runInNewContext` globals): the body sees the
 * parameters, the capturing `console` shadow, and the frame's real globals —
 * nothing more is (or can be) allowlisted here; see the header's trust posture.
 */
function executeAuthorCode(
  code: string,
  sandbox: Record<string, unknown>,
): { ok: true; console: ExperienceConsoleEntry[] } | ExperienceKernelError {
  const consoleBuffer: ExperienceConsoleEntry[] = [];
  const sandboxVars: Record<string, unknown> = { ...sandbox, console: makeCapturingConsole(consoleBuffer) };
  const names = Object.keys(sandboxVars);
  let fn: Function;
  try {
    fn = new Function(...names, code);
  } catch (err: unknown) {
    return frameError(classifyAuthorError(err), extractMessage(err), consoleBuffer);
  }
  try {
    fn(...Object.values(sandboxVars));
  } catch (err: unknown) {
    return frameError(classifyAuthorError(err), extractMessage(err), consoleBuffer);
  }
  return { ok: true, console: consoleBuffer };
}

function classifyAuthorError(err: unknown): "syntax" | "runtime" {
  if (err !== null && typeof err === "object") {
    if ((err as { name?: unknown }).name === "SyntaxError") return "syntax";
  }
  return "runtime";
}

function extractMessage(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

/** The raw registration object an author passes to register (all `unknown`). */
interface RawExperienceRegistration {
  apiVersion: unknown;
  manifest: unknown;
  capabilities: unknown;
  create: unknown;
  project: unknown;
  actions: unknown;
  reduce: unknown;
  choose?: unknown;
  flavor?: unknown;
  update?: unknown;
  setup?: unknown;
}

interface ExperienceRegistrationChannel {
  register(def: RawExperienceRegistration): void;
}

function makeRegistrationChannel(): {
  context: { experience: ExperienceRegistrationChannel };
  registrations: RawExperienceRegistration[];
} {
  const registrations: RawExperienceRegistration[] = [];
  return {
    context: {
      experience: {
        register: (def: RawExperienceRegistration): void => {
          registrations.push(def);
        },
      },
    },
    registrations,
  };
}

/** Confirm exactly one registration with all four mandatory methods present. */
function validateSingleRegistration(
  registrations: readonly RawExperienceRegistration[],
  consoleBuffer: ExperienceConsoleEntry[],
): { ok: true; def: RawExperienceRegistration } | ExperienceKernelError {
  const count = registrations.length;
  if (count === 0) {
    return frameError("no_registration", "context.experience.register was not called", consoleBuffer);
  }
  if (count > 1) {
    return frameError(
      "multi_registration",
      `context.experience.register was called ${count} times; exactly one definition is allowed`,
      consoleBuffer,
    );
  }
  const def = registrations[0] as Partial<RawExperienceRegistration> | undefined;
  for (const method of EXPERIENCE_FRAME_MANDATORY_METHODS) {
    if (def === undefined || typeof def[method] !== "function") {
      return frameError(
        "missing_method",
        `mandatory method "${method}" is missing or not a function`,
        consoleBuffer,
      );
    }
  }
  return { ok: true, def: def as RawExperienceRegistration };
}

/** The raw discovery fields, unvalidated (mirrors the sandbox's output minus hash). */
interface RawFrameDiscovery {
  readonly apiVersion: unknown;
  readonly manifest: unknown;
  readonly capabilities: unknown;
  readonly hasChoose: boolean;
  readonly hasFlavor: boolean;
  readonly hasUpdate: boolean;
  readonly setup: unknown;
  readonly console: ExperienceConsoleEntry[];
}

/**
 * Run an experience script's body once in discovery mode (the frame analogue of
 * the sandbox's `discoverExperience` minus the source hash). The body must
 * register exactly one definition with the four mandatory methods; optional
 * methods and static fields are surfaced raw for schema validation above.
 */
function discoverExperienceRaw(
  code: string,
): { ok: true; discovery: RawFrameDiscovery } | ExperienceKernelError {
  const channel = makeRegistrationChannel();
  const run = executeAuthorCode(code, { context: channel.context });
  if (!run.ok) return run;
  const validated = validateSingleRegistration(channel.registrations, run.console);
  if (!validated.ok) return validated;
  const def = validated.def;
  return {
    ok: true,
    discovery: {
      apiVersion: def.apiVersion,
      manifest: def.manifest,
      capabilities: def.capabilities,
      hasChoose: def.choose !== undefined && typeof def.choose === "function",
      hasFlavor: def.flavor !== undefined && typeof def.flavor === "function",
      hasUpdate: def.update !== undefined && typeof def.update === "function",
      setup: def.setup,
      console: run.console,
    },
  };
}

/**
 * Run the script body and invoke one method `fn(hostContext, input)` inside the
 * SAME Function execution (the body re-registers; the orchestration snippet then
 * locates the registration and calls the method, capturing its return or typed
 * failure). The snippet MIRRORS the server sandbox's, with one mechanical
 * difference the platform forces: writes go through a `__frame` holder passed
 * by REFERENCE, because `node:vm` globals (`__output = …`) are visible on the
 * sandbox object afterward while Function PARAMETERS are local bindings whose
 * reassignment never writes back. The checks and messages are byte-identical.
 */
function runExperienceMethod(
  code: string,
  method: ExperienceFrameMethodName,
  args: { hostContext: unknown; input: unknown },
): { ok: true; output: unknown; console: ExperienceConsoleEntry[] } | ExperienceKernelError {
  const channel = makeRegistrationChannel();
  // The writeback holder (see the doc comment above): mutated through the
  // reference, so the host observes the outcome after the call returns.
  const holder: { output: unknown; errorKind: ExperienceFrameExecutionErrorKind | null; error: string | null } = {
    output: null,
    errorKind: null,
    error: null,
  };
  const sandbox: Record<string, unknown> = {
    context: channel.context,
    __registered: channel.registrations,
    __method: String(method),
    __hostContext: args.hostContext,
    __input: args.input,
    __frame: holder,
  };
  const orchestration = [
    ";(function () {",
    "  var reg = __registered;",
    "  if (reg.length === 0) { __frame.errorKind = 'no_registration'; __frame.error = 'context.experience.register was not called'; return; }",
    "  if (reg.length > 1) { __frame.errorKind = 'multi_registration'; __frame.error = 'context.experience.register was called ' + reg.length + ' times'; return; }",
    "  var def = reg[0];",
    "  var fn = def ? def[__method] : null;",
    "  if (typeof fn !== 'function') { __frame.errorKind = 'missing_method'; __frame.error = 'method \"' + __method + '\" is missing or not a function'; return; }",
    "  try {",
    "    __frame.output = fn(__hostContext, __input);",
    "    __frame.errorKind = null;",
    "  } catch (e) {",
    "    __frame.errorKind = 'runtime';",
    "    __frame.error = (e && e.message) ? String(e.message) : String(e);",
    "  }",
    "})();",
  ].join("\n");
  const run = executeAuthorCode(code + "\n" + orchestration, sandbox);
  if (!run.ok) return run;
  if (holder.errorKind !== null) {
    return frameError(holder.errorKind, String(holder.error ?? ""), run.console);
  }
  return { ok: true, output: holder.output, console: run.console };
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover and validate one experience definition from source (mirrors the
 * kernel's `discoverExperienceDefinition` minus the source hash): one
 * registration, four mandatory methods, static fields schema-validated through
 * the SAME `experienceDefinitionSchema` the server uses (manifest `mode`/`tickMs`
 * included — RM-1).
 */
export function discoverExperienceDefinition(
  code: string,
): ExperienceDiscoveryResult | ExperienceKernelError {
  const discovery = discoverExperienceRaw(code);
  if (!discovery.ok) return discovery;
  const raw = discovery.discovery;
  const parsed = experienceDefinitionSchema.safeParse({
    apiVersion: raw.apiVersion,
    manifest: raw.manifest,
    // The script registers `capabilities`; the canonical/schema field is
    // `declaredCapabilities` — this rename is the kernel's normalization.
    declaredCapabilities: raw.capabilities,
    setup: raw.setup,
  });
  if (!parsed.success) {
    return frameError("invalid_definition", describeZodError(parsed.error), raw.console);
  }
  return {
    ok: true,
    definition: {
      apiVersion: parsed.data.apiVersion,
      manifest: parsed.data.manifest,
      declaredCapabilities: parsed.data.declaredCapabilities,
      hasChoose: raw.hasChoose,
      hasFlavor: raw.hasFlavor,
      hasUpdate: raw.hasUpdate,
      ...(parsed.data.setup !== undefined ? { setup: parsed.data.setup } : {}),
    },
    console: raw.console,
  };
}

// ─── Method-call context (mirrors the kernel's buildMethodContext) ──────────

/**
 * Build the method-call context: `{ state?, participants?, random?, chance?,
 * helpers }`, deep-cloned via JSON round-trip and frozen so a method cannot
 * mutate host state or observe shared references. `random`/`chance` are frozen
 * wrappers over the host cursors; `update` gets `random` but never `chance`
 * (the caller decides the caps shape — the loop host mirrors the kernel's rule).
 */
function buildMethodContext(state: unknown, caps: ExperienceCapabilityContext): unknown {
  const ctx: Record<string, unknown> = { helpers: experienceHelpers };
  if (state !== undefined) ctx.state = cloneFrozen(state);
  if (caps.participants !== undefined) ctx.participants = cloneFrozen(caps.participants);
  if (caps.random !== undefined) ctx.random = buildFrozenRandom(caps.random);
  if (caps.chance !== undefined) ctx.chance = buildFrozenRandom(caps.chance);
  return Object.freeze(ctx);
}

function buildFrozenRandom(rng: DeterministicRandom): DeterministicRandom {
  return Object.freeze({
    float: () => rng.float(),
    int: (min: number, max: number) => rng.int(min, max),
    die: (sides: number) => rng.die(sides),
    pick: <T>(items: readonly T[]) => rng.pick(items),
    shuffle: <T>(items: readonly T[]) => rng.shuffle(items),
    weightedPick: <T extends { weight: number }>(items: readonly T[]) => rng.weightedPick(items),
  });
}

// ─── Shared execution + validation core (mirrors runAndValidate) ────────────

function runAndValidate<T>(
  code: string,
  method: ExperienceFrameMethodName,
  state: unknown,
  caps: ExperienceCapabilityContext,
  input: unknown,
  validate: (raw: unknown, console: ExperienceConsoleEntry[]) => ExperienceRunResult<T>,
): ExperienceRunResult<T> {
  const methodContext = buildMethodContext(state, caps);
  const result = runExperienceMethod(code, method, { hostContext: methodContext, input });
  if (!result.ok) {
    return frameError(result.kind, result.message, result.console);
  }
  if (isThenable(result.output)) {
    return frameError(
      "async_return",
      `method "${method}" returned a Promise; async methods are not allowed`,
      result.console,
    );
  }
  return validate(result.output, result.console);
}

// ─── create ──────────────────────────────────────────────────────────────────

/**
 * Run `create(context, settings)` and return the validated initial state. No
 * prior `state` in the context; `settings` is bounded then frozen before
 * injection.
 */
export function runCreate(
  code: string,
  settings: unknown,
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<unknown> {
  const settingsError = jsonBoundsError(settings, {
    maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
    maxBytes: INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES,
  });
  if (settingsError !== null) {
    return frameError("invalid_state", `settings ${settingsError}`, []);
  }
  return runAndValidate(code, "create", undefined, caps, cloneFrozen(settings), (raw, console) =>
    validateState(raw, console),
  );
}

// ─── project ─────────────────────────────────────────────────────────────────

/** Run `project(context, viewer)` — the per-viewer projected state. */
export function runProject(
  code: string,
  state: unknown,
  viewer: ExperienceViewer,
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<unknown> {
  const viewerError = validateViewer(viewer);
  if (viewerError !== null) return viewerError;
  const stateError = validateStateInput(state);
  if (stateError !== null) return stateError;
  return runAndValidate(code, "project", state, caps, cloneFrozen(viewer), (raw, console) =>
    validateState(raw, console),
  );
}

// ─── actions ─────────────────────────────────────────────────────────────────

/** Run `actions(context, viewer)` — the bounded, schema-validated legal set. */
export function runActions(
  code: string,
  state: unknown,
  viewer: ExperienceViewer,
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<ExperienceActionDescriptor[]> {
  const viewerError = validateViewer(viewer);
  if (viewerError !== null) return viewerError;
  const stateError = validateStateInput(state);
  if (stateError !== null) return stateError;
  return runAndValidate(code, "actions", state, caps, cloneFrozen(viewer), (raw, console) =>
    validateActions(raw, console),
  );
}

// ─── reduce ──────────────────────────────────────────────────────────────────

/**
 * Run `reduce(context, action)` — the validated transition (`status` narrowed
 * to `active`/`completed`; state/events/effects bounded).
 */
export function runReduce(
  code: string,
  state: unknown,
  action: ExperienceAction,
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<ExperienceTransition> {
  const actionParsed = experienceActionSchema.safeParse(action);
  if (!actionParsed.success) {
    return frameError("illegal_action", describeZodError(actionParsed.error), []);
  }
  const stateError = validateStateInput(state);
  if (stateError !== null) return stateError;
  return runAndValidate(code, "reduce", state, caps, cloneFrozen(actionParsed.data), (raw, console) =>
    validateTransition(raw, console),
  );
}

// ─── update (optional realtime tick) ───────────────────────────────────────

/**
 * Run the OPTIONAL `update(context, dt)` realtime tick — same rules as the
 * kernel's `runUpdate`: `dtMs` a positive integer (the manifest `tickMs`; the
 * 16..1000 authoring bound is owned by the contracts schema), reduce-shaped
 * caps, the same transition validation. A tick draws from the deterministic
 * cursor and must never receive `chance` — replay bit-parity (RM-8).
 */
export function runUpdate(
  code: string,
  state: unknown,
  dtMs: number,
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<ExperienceTransition> {
  if (!Number.isInteger(dtMs) || dtMs <= 0) {
    return frameError(
      "invalid_state",
      `dtMs must be a positive integer (the manifest tickMs); got ${String(dtMs)}`,
      [],
    );
  }
  const stateError = validateStateInput(state);
  if (stateError !== null) return stateError;
  return runAndValidate(code, "update", state, caps, dtMs, (raw, console) =>
    validateTransition(raw, console),
  );
}

// ─── choose / flavor (optional methods) ──────────────────────────────────────

/**
 * Run the OPTIONAL `choose(context, { viewer, legal })` — a script seat's move,
 * normalized to an intent whose `type` must be in the legal set. `chance` is
 * available to the script; `random` only when granted.
 */
export function runChoose(
  code: string,
  state: unknown,
  viewer: ExperienceViewer,
  legal: readonly ExperienceActionDescriptor[],
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<ExperienceChosenIntent> {
  const viewerError = validateViewer(viewer);
  if (viewerError !== null) return viewerError;
  const stateError = validateStateInput(state);
  if (stateError !== null) return stateError;
  return runAndValidate(code, "choose", state, caps, cloneFrozen({ viewer, legal }), (raw, console) =>
    validateChosenIntent(raw, viewer, legal, console),
  );
}

/**
 * Run the OPTIONAL `flavor(context, viewer)` — bounded cosmetic data (or
 * `undefined`); never affects state, never consumes the deterministic cursor.
 */
export function runFlavor(
  code: string,
  state: unknown,
  viewer: ExperienceViewer,
  caps: ExperienceCapabilityContext,
): ExperienceRunResult<unknown> {
  const viewerError = validateViewer(viewer);
  if (viewerError !== null) return viewerError;
  const stateError = validateStateInput(state);
  if (stateError !== null) return stateError;
  return runAndValidate(code, "flavor", state, caps, cloneFrozen(viewer), (raw, console) =>
    validateFlavor(raw, console),
  );
}

// ─── Chosen-intent validation (mirrors the kernel) ──────────────────────────

function validateChosenIntent(
  raw: unknown,
  viewer: ExperienceViewer,
  legal: readonly ExperienceActionDescriptor[],
  console: ExperienceConsoleEntry[],
): ExperienceRunResult<ExperienceChosenIntent> {
  if (raw === null || typeof raw !== "object") {
    return frameError("illegal_action", "choose must return an action object", console);
  }
  const obj = raw as { type?: unknown; participantId?: unknown; payload?: unknown };
  if (typeof obj.type !== "string") {
    return frameError("illegal_action", "chosen action has no string `type`", console);
  }
  const participantId =
    typeof obj.participantId === "string" ? obj.participantId : viewer.participantId;
  const match = legal.find(
    (d) => d.type === obj.type && (d.participantId === undefined || d.participantId === participantId),
  );
  if (match === undefined) {
    return frameError(
      "illegal_action",
      `choose returned "${obj.type}" which is not legal for this viewer`,
      console,
    );
  }
  if (obj.payload !== undefined) {
    const payloadError = jsonBoundsError(obj.payload, {
      maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
      maxBytes: INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES,
    });
    if (payloadError !== null) {
      return frameError("illegal_action", `payload ${payloadError}`, console);
    }
  }
  const intent: ExperienceChosenIntent = {
    type: obj.type,
    ...(participantId !== undefined ? { participantId } : {}),
    ...(obj.payload !== undefined ? { payload: obj.payload } : {}),
  };
  return { ok: true, value: intent, console };
}

function validateFlavor(
  raw: unknown,
  console: ExperienceConsoleEntry[],
): ExperienceRunResult<unknown> {
  if (raw === undefined) return { ok: true, value: undefined, console };
  const err = jsonBoundsError(raw, {
    maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
    maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  });
  if (err !== null) return frameError("invalid_state", `flavor ${err}`, console);
  return { ok: true, value: raw, console };
}

// ─── Legal-action validation (mirrors the kernel's pre-check) ────────────────

/** Render the current legal set for the illegal_action message (kernel copy). */
function formatLegalTypes(legal: readonly ExperienceActionDescriptor[]): string {
  if (legal.length === 0) return "none — check seat mapping / turn ownership";
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const d of legal) {
    const entry = d.participantId !== undefined ? `${d.type} for participant "${d.participantId}"` : d.type;
    if (seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  const cap = 10;
  const listed = entries.slice(0, cap);
  const rest = entries.length - listed.length;
  return rest > 0 ? `${listed.join(", ")} …+${rest} more` : listed.join(", ");
}

/**
 * Validate that a submitted action matches a descriptor in the legal set (the
 * frame-side pre-check the loop host runs before `reduce`; the reducer remains
 * the final semantic authority).
 */
export function validateSubmittedAction(
  action: ExperienceAction,
  legal: readonly ExperienceActionDescriptor[],
): { ok: true } | ExperienceKernelError {
  const candidate = legal.find(
    (d) =>
      d.type === action.type &&
      (d.participantId === undefined || d.participantId === action.participantId),
  );
  if (candidate === undefined) {
    const seat = action.participantId !== undefined ? ` for participant "${action.participantId}"` : "";
    return frameError(
      "illegal_action",
      `action "${action.type}" is not legal${seat} (legal now: ${formatLegalTypes(legal)})`,
      [],
    );
  }
  if (action.payload !== undefined) {
    const payloadError = jsonBoundsError(action.payload, {
      maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
      maxBytes: INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES,
    });
    if (payloadError !== null) {
      return frameError("illegal_action", `payload ${payloadError}`, []);
    }
  }
  if (candidate.payloadSchema !== undefined) {
    if (action.payload === undefined) {
      return frameError(
        "illegal_action",
        `action "${action.type}" requires a payload (its payloadSchema is declared)`,
        [],
      );
    }
    const schemaResult = validatePayloadValue(action.payload, candidate.payloadSchema, "payload");
    if (!schemaResult.ok) {
      return frameError("illegal_action", schemaResult.message, []);
    }
  }
  return { ok: true };
}

// ─── Output validators (mirrors the kernel's) ────────────────────────────────

function validateState(
  raw: unknown,
  console: ExperienceConsoleEntry[],
): ExperienceRunResult<unknown> {
  const err = jsonBoundsError(raw, {
    maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
    maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  });
  if (err !== null) return frameError("invalid_state", `state ${err}`, console);
  return { ok: true, value: raw, console };
}

function validateActions(
  raw: unknown,
  console: ExperienceConsoleEntry[],
): ExperienceRunResult<ExperienceActionDescriptor[]> {
  const parsed = z
    .array(experienceActionDescriptorSchema)
    .max(INTERACTIVE_SCHEMA_MAX_ACTIONS)
    .safeParse(raw);
  if (!parsed.success) {
    return frameError("invalid_actions", describeZodError(parsed.error), console);
  }
  // Strict vocabulary check on declared payloadSchemas (same rationale as the
  // kernel: fail loudly at descriptor time, never silently ignore keywords).
  for (const descriptor of parsed.data) {
    if (descriptor.payloadSchema !== undefined) {
      const schemaCheck = validatePayloadSchemaDefinition(descriptor.payloadSchema);
      if (!schemaCheck.ok) {
        return frameError("invalid_actions", schemaCheck.message, console);
      }
    }
  }
  return { ok: true, value: parsed.data as ExperienceActionDescriptor[], console };
}

function validateTransition(
  raw: unknown,
  console: ExperienceConsoleEntry[],
): ExperienceRunResult<ExperienceTransition> {
  const parsed = experienceTransitionSchema.safeParse(raw);
  if (!parsed.success) {
    return frameError("invalid_transition", describeZodError(parsed.error), console);
  }
  const data = parsed.data;
  // `status` is "active" | "completed" (schema-narrowed); effects are mapped
  // explicitly to present-keyed canonical envelopes (same as the kernel).
  const transition: ExperienceTransition = {
    state: data.state,
    status: data.status,
    events: data.events.map((event) => ({
      visibility: event.visibility,
      type: event.type,
      ...(event.detail !== undefined ? { detail: event.detail } : {}),
    })),
    ...(data.effects !== undefined
      ? { effects: data.effects.map((effect) => ({ kind: effect.kind, request: effect.request })) }
      : {}),
    ...(data.message !== undefined ? { message: data.message } : {}),
  };
  return { ok: true, value: transition, console };
}

// ─── Input validators (mirrors the kernel's) ─────────────────────────────────

function validateViewer(viewer: ExperienceViewer): ExperienceKernelError | null {
  const parsed = experienceViewerSchema.safeParse(viewer);
  if (!parsed.success) {
    return frameError("invalid_view", describeZodError(parsed.error), []);
  }
  return null;
}

function validateStateInput(state: unknown): ExperienceKernelError | null {
  const err = jsonBoundsError(state, {
    maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
    maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
  });
  if (err !== null) return frameError("invalid_state", `state ${err}`, []);
  return null;
}

// ─── Helpers (mirrors the kernel's) ─────────────────────────────────────────

/**
 * Deep-clone via JSON round-trip then deeply freeze (same semantics as the
 * kernel's `cloneFrozen`): JSON-safety enforcement, host-reference isolation,
 * and mutation prevention (sloppy-mode silent no-op, strict-mode throw).
 */
function cloneFrozen<T>(value: T): T {
  let jsonSafe: unknown;
  try {
    jsonSafe = JSON.parse(JSON.stringify(value));
  } catch {
    jsonSafe = value;
  }
  return deepFreeze(jsonSafe) as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

function frameError(
  kind: ExperienceFrameErrorKind,
  message: string,
  console: ExperienceConsoleEntry[],
): ExperienceKernelError {
  return { ok: false, kind, message, console };
}
