/**
 * Synchronous Interactive-experience kernel
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1 / IR-12).
 *
 * The pure validation + orchestration layer over {@link ./experience-sandbox.ts}.
 * The sandbox is the `node:vm` boundary; the kernel never trusts a script's
 * returned value merely because it came from the VM. Every method output is
 * JSON-round-trip-checked (reusing the IR-11 {@link jsonBoundsError} guard),
 * schema-validated, normalized, and mapped to a canonical domain envelope or a
 * typed failure. The kernel performs NO I/O.
 *
 * Method lifecycle — four mandatory methods plus two optional ones:
 *  - `create(context, settings)`  → initial authoritative state.             [mandatory]
 *  - `project(context, viewer)`   → projected state for one viewer.         [mandatory]
 *  - `actions(context, viewer)`   → legal action descriptors for one viewer. [mandatory]
 *  - `reduce(context, action)`    → next transition `{state, status, events, effects?}`. [mandatory]
 *  - `choose(context, {viewer, legal})` → one chosen action for a script seat. [optional]
 *  - `flavor(context, viewer)`    → cosmetic display data for one viewer.    [optional]
 *
 * The method-call `context` the kernel injects is `{ state?, participants?,
 * random?, chance?, helpers }`. `state` is present for project/actions/choose/
 * reduce/flavor (frozen), absent for create. `participants` and `random` appear
 * ONLY when the host grants those capabilities (and `random` only in create/
 * reduce); `chance` is an EPHEMERAL, non-recorded random source injected only
 * into `choose` and `flavor` — it lets a script pick a varied move or cosmetic
 * detail without consuming the deterministic cursor, so the journal of create+
 * reduce draws alone reproduces the stream on replay (Variant Б of the
 * choose-randomness design). `model`, `rp_context`, and `rp_attachment` are NOT
 * synchronous context APIs — a reducer requests them as durable effect data and
 * the host runs them out-of-band (Wave 4). `helpers` is the always-present,
 * frozen, optional pure-recipe namespace from {@link ./experience-helpers.ts}.
 *
 * Determinism: authoritative `state`, `settings`, `viewer`, and `action` are
 * deep-cloned via JSON round-trip and frozen before injection, so a method
 * cannot mutate host state and cannot observe shared references. The seeded
 * {@link DeterministicRandom} stream advances one cursor across a session, so
 * replaying the same seed + action sequence reproduces identical values; the
 * ephemeral `chance` is deliberately outside this stream (its draws are not
 * recorded, so two fresh sessions from one seed may differ in script-chosen
 * moves or cosmetic flavor — accepted trade-off for flexible, less-robotic AI).
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
import type {
  ExperienceAction,
  ExperienceActionDescriptor,
  ExperienceDeclaredCapability,
  ExperienceManifest,
  ExperienceParticipant,
  ExperienceSetupDefinition,
  ExperienceTransition,
  ExperienceViewer,
} from "@vibe-tavern/domain";
import { z } from "zod";
import {
  discoverExperience,
  EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
  runExperienceMethod,
  type ExperienceConsoleEntry,
  type ExperienceMethodName,
  type ExperienceSandboxErrorKind,
} from "./experience-sandbox.js";
import { experienceHelpers, shuffle } from "./experience-helpers.js";
import { validatePayloadSchemaDefinition, validatePayloadValue } from "./experience-payload-schema.js";

// ─── Deterministic random capability ─────────────────────────────────────────

/**
 * The seeded, host-owned RNG surface exposed as `context.random` when the
 * `deterministic_random` capability is granted. Every method draws from one
 * advancing cursor so a replayed seed + action sequence reproduces identical
 * values. Created once per session via {@link createDeterministicRandom}.
 */
export interface DeterministicRandom {
	float(): number;
	int(min: number, max: number): number;
	die(sides: number): number;
	pick<T>(items: readonly T[]): T;
	shuffle<T>(items: readonly T[]): T[];
	weightedPick<T extends { weight: number }>(items: readonly T[]): T;
}

/**
 * mulberry32 — a tiny deterministic PRNG (same algorithm as the prompt-script
 * VM's seeded helper). Exported so the lifecycle service can build a cursor-
 * counting wrapper on top of the SAME primitive (single source of truth for the
 * stream algorithm): the service pre-advances to a persisted cursor on resume
 * and counts subsequent draws so it can store the new cursor after each reduce.
 */
export function createMulberry32(seed: number): { next(): number } {
	let state = seed >>> 0;
	return {
		next(): number {
			state |= 0;
			state = (state + 0x6d2b79f5) | 0;
			let t = Math.imul(state ^ (state >>> 15), 1 | state);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		},
	};
}

/**
 * Build the {@link DeterministicRandom} surface over a uniform `[0, 1)` stream.
 * Shared by {@link createDeterministicRandom} (mulberry32, seeded) and
 * {@link createEphemeralRandom} (`Math.random`, non-recorded) so the surface
 * shape has one source of truth; the lifecycle service's cursor-counting wrapper
 * reuses the same shape too.
 */
function buildRandomSurface(next: () => number): DeterministicRandom {
	return {
		float: () => next(),
		int: (min: number, max: number): number => {
			if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
				throw new RangeError("random.int: min and max must be integers with min <= max");
			}
			return Math.floor(next() * (max - min + 1)) + min;
		},
		die: (sides: number): number => {
			if (!Number.isInteger(sides) || sides < 1) {
				throw new RangeError("random.die: sides must be a positive integer");
			}
			return Math.floor(next() * sides) + 1;
		},
		pick<T>(items: readonly T[]): T {
			if (!Array.isArray(items) || items.length === 0) {
				throw new RangeError("random.pick: a non-empty array is required");
			}
			return items[Math.floor(next() * items.length)];
		},
		shuffle<T>(items: readonly T[]): T[] {
			return shuffle(items, next);
		},
		weightedPick<T extends { weight: number }>(items: readonly T[]): T {
			if (!Array.isArray(items) || items.length === 0) {
				throw new RangeError("random.weightedPick: a non-empty array is required");
			}
			const total = items.reduce((sum, it) => sum + (Number(it.weight) || 0), 0);
			let roll = next() * total;
			for (const it of items) {
				roll -= Number(it.weight) || 0;
				if (roll <= 0) return it;
			}
			return items[items.length - 1];
		},
	};
}

/**
 * A stateful {@link DeterministicRandom} seeded once per session. The cursor
 * (count of draws consumed) is persisted alongside the seed (IR-21); resume
 * fast-forwards the stream to that cursor, and recalculation replay reproduces
 * it from the seed. Both paths use {@link createMulberry32}.
 */
export function createDeterministicRandom(seed: number): DeterministicRandom {
	return buildRandomSurface(createMulberry32(seed).next);
}

/**
 * The same shape as {@link DeterministicRandom}, but backed by `Math.random` —
 * non-recorded, non-reproducible. Injected as `context.chance` into `choose`
 * and `flavor` so a script can make a varied move or cosmetic detail without
 * disturbing the deterministic cursor (Variant Б).
 */
export type EphemeralRandom = DeterministicRandom;

/** Create an ephemeral `chance` surface (Math.random-backed, not recorded). */
export function createEphemeralRandom(): EphemeralRandom {
	return buildRandomSurface(Math.random);
}

// ─── Granted capabilities (the synchronous context surface) ──────────────────

/**
 * The capabilities the host injects into the method-call context. Only
 * `participants` and `deterministic_random` are synchronous VM APIs; `model`,
 * `rp_context`, and `rp_attachment` are durable effect requests, not context
 * methods. Absent fields mean the capability is not granted — the method never
 * sees them.
 */
export interface ExperienceCapabilityContext {
	readonly participants?: readonly ExperienceParticipant[];
	readonly random?: DeterministicRandom;
	/** Ephemeral (non-recorded) randomness — injected into `choose`/`flavor` only. */
	readonly chance?: EphemeralRandom;
}

// ─── Typed failures ──────────────────────────────────────────────────────────

export type ExperienceKernelErrorKind =
	| ExperienceSandboxErrorKind
	| "invalid_definition"
	| "invalid_state"
	| "invalid_view"
	| "invalid_actions"
	| "invalid_transition"
	| "illegal_action"
	| "async_return";

export interface ExperienceKernelError {
	readonly ok: false;
	readonly kind: ExperienceKernelErrorKind;
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

/** The validated discovery output: a clean definition plus its source hash. */
export interface ExperienceDefinition {
	readonly apiVersion: number;
	readonly manifest: ExperienceManifest;
	readonly declaredCapabilities: ExperienceDeclaredCapability[];
	/** Whether the optional `choose` method is present (script-controlled seats). */
	readonly hasChoose: boolean;
	/** Whether the optional `flavor` method is present (display-time cosmetic). */
	readonly hasFlavor: boolean;
	/** Optional package-authored setup-field descriptor, normalized by
	 *  `experienceDefinitionSchema` (IR-70F). Absent when the package declares none. */
	readonly setup?: ExperienceSetupDefinition;
}

export interface ExperienceDiscoveryResult {
	readonly ok: true;
	readonly definition: ExperienceDefinition;
	readonly sourceHash: string;
	readonly console: ExperienceConsoleEntry[];
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover and validate one experience definition from source. Runs the body
 * once under the timeout, confirms exactly one registration with all four
 * mandatory methods present (sandbox), then schema-validates the static
 * apiVersion/manifest/capabilities fields. Returns the canonical definition plus
 * the SHA-256 source hash used for snapshot isolation.
 */
export function discoverExperienceDefinition(
	code: string,
	scriptName: string,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceDiscoveryResult | ExperienceKernelError {
	const discovery = discoverExperience(code, scriptName, timeoutMs);
	if (!discovery.ok) {
		return kernelError(discovery.kind, discovery.message, discovery.console);
	}
	const parsed = experienceDefinitionSchema.safeParse({
		apiVersion: discovery.apiVersion,
		manifest: discovery.manifest,
		// The script registers `capabilities`; the canonical/schema field is
		// `declaredCapabilities` — this rename is the kernel's normalization.
		declaredCapabilities: discovery.capabilities,
		setup: discovery.setup,
	});
	if (!parsed.success) {
		return kernelError("invalid_definition", describeZodError(parsed.error), discovery.console);
	}
	return {
		ok: true,
		definition: {
			apiVersion: parsed.data.apiVersion,
			manifest: parsed.data.manifest,
			declaredCapabilities: parsed.data.declaredCapabilities,
			hasChoose: discovery.hasChoose,
			hasFlavor: discovery.hasFlavor,
			...(parsed.data.setup !== undefined ? { setup: parsed.data.setup } : {}),
		},
		sourceHash: discovery.sourceHash,
		console: discovery.console,
	};
}

// ─── create ──────────────────────────────────────────────────────────────────

/**
 * Run `create(context, settings)` and return the validated initial authoritative
 * state. There is no prior `state` in the method context (create is initial).
 * `settings` is bounded-JSON-validated, then frozen before injection.
 */
export function runCreate(
	code: string,
	scriptName: string,
	settings: unknown,
	caps: ExperienceCapabilityContext,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceRunResult<unknown> {
	const settingsError = jsonBoundsError(settings, {
		maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
		maxBytes: INTERACTIVE_SCHEMA_MAX_PAYLOAD_BYTES,
	});
	if (settingsError !== null) {
		return kernelError("invalid_state", `settings ${settingsError}`, []);
	}
	return runAndValidate(
		code,
		scriptName,
		"create",
		undefined,
		caps,
		cloneFrozen(settings),
		(raw, console) => validateState(raw, console),
		timeoutMs,
	);
}

// ─── project ─────────────────────────────────────────────────────────────────

/**
 * Run `project(context, viewer)` and return the validated projected state for
 * one viewer. Hidden information is enforced by the author's per-viewer
 * projection; the kernel guarantees the host did not leak authoritative state
 * (the method receives only the frozen projected-state computation context).
 */
export function runProject(
	code: string,
	scriptName: string,
	state: unknown,
	viewer: ExperienceViewer,
	caps: ExperienceCapabilityContext,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceRunResult<unknown> {
	const viewerError = validateViewer(viewer);
	if (viewerError !== null) return viewerError;
	const stateError = validateStateInput(state);
	if (stateError !== null) return stateError;
	return runAndValidate(
		code,
		scriptName,
		"project",
		state,
		caps,
		cloneFrozen(viewer),
		(raw, console) => validateState(raw, console),
		timeoutMs,
	);
}

// ─── actions ─────────────────────────────────────────────────────────────────

/**
 * Run `actions(context, viewer)` and return the validated legal action
 * descriptors for one viewer. The descriptor array is bounded and each
 * descriptor is schema-validated (type/payloadSchema bounds).
 */
export function runActions(
	code: string,
	scriptName: string,
	state: unknown,
	viewer: ExperienceViewer,
	caps: ExperienceCapabilityContext,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceRunResult<ExperienceActionDescriptor[]> {
	const viewerError = validateViewer(viewer);
	if (viewerError !== null) return viewerError;
	const stateError = validateStateInput(state);
	if (stateError !== null) return stateError;
	return runAndValidate(
		code,
		scriptName,
		"actions",
		state,
		caps,
		cloneFrozen(viewer),
		(raw, console) => validateActions(raw, console),
		timeoutMs,
	);
}

// ─── reduce ──────────────────────────────────────────────────────────────────

/**
 * Run `reduce(context, action)` and return the validated transition. The
 * transition's `status` is schema-narrowed to `active`/`completed` (never
 * `interrupted`, which is host-only); state/events/effects are bounded.
 */
export function runReduce(
	code: string,
	scriptName: string,
	state: unknown,
	action: ExperienceAction,
	caps: ExperienceCapabilityContext,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceRunResult<ExperienceTransition> {
	const actionParsed = experienceActionSchema.safeParse(action);
	if (!actionParsed.success) {
		return kernelError("illegal_action", describeZodError(actionParsed.error), []);
	}
	const stateError = validateStateInput(state);
	if (stateError !== null) return stateError;
	return runAndValidate(
		code,
		scriptName,
		"reduce",
		state,
		caps,
		cloneFrozen(actionParsed.data),
		(raw, console) => validateTransition(raw, console),
		timeoutMs,
	);
}

// ─── choose / flavor (optional methods, Wave 3 contract revision) ────────

/** A script-chosen move intent: `choose` returns this; the host fills bookkeeping. */
export interface ExperienceChosenIntent {
	readonly type: string;
	readonly participantId?: string;
	readonly payload?: unknown;
}

/**
 * Run the OPTIONAL `choose(context, { viewer, legal })` method for a script-
 * controlled seat and return its chosen move as a normalized intent. The script
 * receives the legal-action list (the host computed it via {@link runActions})
 * and returns one move; `context.chance` (ephemeral) is available for a varied
 * pick. The returned `type` must match a legal descriptor; the participant id
 * defaults to the viewer's seat. Bookkeeping (`requestId`/`expectedRevision`) is
 * filled by the host — the script never manages it.
 */
export function runChoose(
	code: string,
	scriptName: string,
	state: unknown,
	viewer: ExperienceViewer,
	legal: readonly ExperienceActionDescriptor[],
	caps: ExperienceCapabilityContext,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceRunResult<ExperienceChosenIntent> {
	const viewerError = validateViewer(viewer);
	if (viewerError !== null) return viewerError;
	const stateError = validateStateInput(state);
	if (stateError !== null) return stateError;
	return runAndValidate(
		code,
		scriptName,
		"choose",
		state,
		caps,
		cloneFrozen({ viewer, legal }),
		(raw, console) => validateChosenIntent(raw, viewer, legal, console),
		timeoutMs,
	);
}

/**
 * Run the OPTIONAL `flavor(context, viewer)` display-time method and return its
 * bounded-JSON cosmetic data (or `undefined` if the script returned nothing).
 * `context.chance` (ephemeral) is available for varied cosmetic output. Flavor
 * never affects authoritative state and never consumes the deterministic cursor.
 */
export function runFlavor(
	code: string,
	scriptName: string,
	state: unknown,
	viewer: ExperienceViewer,
	caps: ExperienceCapabilityContext,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceRunResult<unknown> {
	const viewerError = validateViewer(viewer);
	if (viewerError !== null) return viewerError;
	const stateError = validateStateInput(state);
	if (stateError !== null) return stateError;
	return runAndValidate(
		code,
		scriptName,
		"flavor",
		state,
		caps,
		cloneFrozen(viewer),
		(raw, console) => validateFlavor(raw, console),
		timeoutMs,
	);
}

function validateChosenIntent(
	raw: unknown,
	viewer: ExperienceViewer,
	legal: readonly ExperienceActionDescriptor[],
	console: ExperienceConsoleEntry[],
): ExperienceRunResult<ExperienceChosenIntent> {
	if (raw === null || typeof raw !== "object") {
		return kernelError("illegal_action", "choose must return an action object", console);
	}
	const obj = raw as { type?: unknown; participantId?: unknown; payload?: unknown };
	if (typeof obj.type !== "string") {
		return kernelError("illegal_action", "chosen action has no string `type`", console);
	}
	const participantId =
		typeof obj.participantId === "string" ? obj.participantId : viewer.participantId;
	const match = legal.find(
		(d) => d.type === obj.type && (d.participantId === undefined || d.participantId === participantId),
	);
	if (match === undefined) {
		return kernelError(
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
			return kernelError("illegal_action", `payload ${payloadError}`, console);
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
	if (err !== null) return kernelError("invalid_state", `flavor ${err}`, console);
	return { ok: true, value: raw, console };
}

// ─── Legal-action validation ─────────────────────────────────────────────────

/** Render the current legal set for the illegal_action message: deduped
 *  `type` entries in order (each with `for participant "id"` when its
 *  descriptor carries one), capped at 10 + `…+N more`. An empty set says so
 *  explicitly — a seat that "cannot ever act" is almost always a seat-mapping
 *  or turn-ownership bug, and this is the one line the author sees. */
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
 * Validate that a submitted {@link ExperienceAction} matches a descriptor in the
 * `legal` set the host computed via {@link runActions} for the current viewer.
 * The reducer remains the final semantic authority (it may still reject the
 * move in-context); this host pre-check rejects actions the package never
 * offered to this seat. Payloads are bounded-JSON-checked; structural
 * `payloadSchema`/`allowsText` enforcement is refined in later waves.
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
		return kernelError(
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
			return kernelError("illegal_action", `payload ${payloadError}`, []);
		}
	}
	if (candidate.payloadSchema !== undefined) {
		if (action.payload === undefined) {
			return kernelError(
				"illegal_action",
				`action "${action.type}" requires a payload (its payloadSchema is declared)`,
				[],
			);
		}
		const schemaResult = validatePayloadValue(action.payload, candidate.payloadSchema, "payload");
		if (!schemaResult.ok) {
			return kernelError("illegal_action", schemaResult.message, []);
		}
	}
	return { ok: true };
}

// ─── Shared execution + validation core ──────────────────────────────────────

/**
 * Build the method-call context, execute one method under the timeout, reject
 * async returns, then validate the raw output with `validate`. Centralizes the
 * sandbox→kernel failure mapping and the async/JSON posture for all four methods.
	 */
function runAndValidate<T>(
	code: string,
	scriptName: string,
	method: ExperienceMethodName,
	state: unknown,
	caps: ExperienceCapabilityContext,
	input: unknown,
	validate: (raw: unknown, console: ExperienceConsoleEntry[]) => ExperienceRunResult<T>,
	timeoutMs: number,
): ExperienceRunResult<T> {
	const methodContext = buildMethodContext(state, caps);
	const result = runExperienceMethod(
		code,
		scriptName,
		method,
		{ hostContext: methodContext, input },
		timeoutMs,
	);
	if (!result.ok) {
		return kernelError(result.kind, result.message, result.console);
	}
	if (isThenable(result.output)) {
		return kernelError(
			"async_return",
			`method "${method}" returned a Promise; async methods are not allowed`,
			result.console,
		);
	}
	return validate(result.output, result.console);
}

function buildMethodContext(
	state: unknown,
	caps: ExperienceCapabilityContext,
): unknown {
	const ctx: Record<string, unknown> = { helpers: experienceHelpers };
	if (state !== undefined) ctx.state = cloneFrozen(state);
	if (caps.participants !== undefined) ctx.participants = cloneFrozen(caps.participants);
	if (caps.random !== undefined) ctx.random = buildVmRandom(caps.random);
	if (caps.chance !== undefined) ctx.chance = buildVmRandom(caps.chance);
	return Object.freeze(ctx);
}

function buildVmRandom(rng: DeterministicRandom): DeterministicRandom {
	return Object.freeze({
		float: () => rng.float(),
		int: (min: number, max: number) => rng.int(min, max),
		die: (sides: number) => rng.die(sides),
		pick: <T>(items: readonly T[]) => rng.pick(items),
		shuffle: <T>(items: readonly T[]) => rng.shuffle(items),
		weightedPick: <T extends { weight: number }>(items: readonly T[]) => rng.weightedPick(items),
	});
}

// ─── Output validators ───────────────────────────────────────────────────────

function validateState(
	raw: unknown,
	console: ExperienceConsoleEntry[],
): ExperienceRunResult<unknown> {
	const err = jsonBoundsError(raw, {
		maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
		maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
	});
	if (err !== null) return kernelError("invalid_state", `state ${err}`, console);
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
		return kernelError("invalid_actions", describeZodError(parsed.error), console);
	}
	// Strict vocabulary check on declared payloadSchemas — fail loudly at
	// descriptor time rather than silently ignoring keywords the kernel cannot
	// honor (payloadSchema enforcement, fix step 1a).
	for (const descriptor of parsed.data) {
		if (descriptor.payloadSchema !== undefined) {
			const schemaCheck = validatePayloadSchemaDefinition(descriptor.payloadSchema);
			if (!schemaCheck.ok) {
				return kernelError("invalid_actions", schemaCheck.message, console);
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
		return kernelError("invalid_transition", describeZodError(parsed.error), console);
	}
	const data = parsed.data;
	// `status` is "active" | "completed" (schema-narrowed); both are members of
	// the canonical session-status union, so no cast is needed. Effects are mapped
	// explicitly because the wire schema's `request` (a bounded `z.unknown()`)
	// infers optional, while the canonical envelope requires it; constructing each
	// element yields a present-keyed `ExperienceEffectRequest`.
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

// ─── Input validators ────────────────────────────────────────────────────────

function validateViewer(viewer: ExperienceViewer): ExperienceKernelError | null {
	const parsed = experienceViewerSchema.safeParse(viewer);
	if (!parsed.success) {
		return kernelError("invalid_view", describeZodError(parsed.error), []);
	}
	return null;
}

function validateStateInput(state: unknown): ExperienceKernelError | null {
	const err = jsonBoundsError(state, {
		maxDepth: INTERACTIVE_SCHEMA_MAX_DEPTH,
		maxBytes: INTERACTIVE_SCHEMA_MAX_STATE_BYTES,
	});
	if (err !== null) return kernelError("invalid_state", `state ${err}`, []);
	return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Deep-clone via JSON round-trip then deeply freeze. Enforces that the value is
 * JSON-safe (the round-trip enforcement), isolates the VM from host references,
 * and prevents the method from mutating authoritative inputs (strict-mode throw).
 */
function cloneFrozen<T>(value: T): T {
	let jsonSafe: unknown;
	try {
		jsonSafe = JSON.parse(JSON.stringify(value));
	} catch {
		// Inputs reaching here should already be JSON-safe (validated upstream);
		// a failure means the host passed a non-JSON value, which the caller
		// surfaces as a state/input error before this point in practice.
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

function kernelError(
	kind: ExperienceKernelErrorKind,
	message: string,
	console: ExperienceConsoleEntry[],
): ExperienceKernelError {
	return { ok: false, kind, message, console };
}
