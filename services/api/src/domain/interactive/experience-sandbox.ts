/**
 * Dedicated Interactive-experience VM (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 1 / IR-12).
 *
 * A SEPARATE `node:vm` sandbox from the prompt-script VM (`script-sandbox.ts`)
 * and the Dice-script VM (`dice-script-sandbox.ts`). Each of the three script
 * kinds owns an isolated runtime; an interactive experience runs here and ONLY
 * here — it can never reach prompt assembly, Dice rolls, provider execution,
 * the EventBus, or the other VMs' globals.
 *
 * The experience contract has two phases, both synchronous and both bounded by a
 * CPU timeout:
 *
 *  - **Discovery.** The script body runs once with `context.experience.register`
 *    available. It must publish exactly one definition whose four mandatory
 *    methods (`create`, `project`, `actions`, `reduce`) are functions; the two
 *    optional methods (`choose`, `flavor`) may also be present. Discovery
 *    returns the registration's static fields (apiVersion/manifest/capabilities),
 *    the source hash, captured console, and which optional methods are present
 *    (`hasChoose`/`hasFlavor`); it confirms mandatory-method presence but does
 *    NOT schema-validate (that is the kernel's job, reusing the IR-11 bounded
 *    schemas). Method closures never leave the process — the kernel re-executes
 *    them under the timeout envelope instead of calling stale refs.
 *
 *  - **Method execution.** The body runs again (re-registering its single
 *    definition), and an appended orchestration snippet invokes one mandatory
 *    method `fn(hostContext, input)` inside the SAME `runInNewContext` call so
 *    the timeout covers user-authored logic. The raw return value is surfaced
 *    for the kernel to validate (bounded JSON, transition/transition shape).
 *
 * The sandbox exposes NO network/filesystem/process, NO `Promise`, NO raw host
 * effects, NO uncontrolled randomness, and NO channels into prompt assembly or
 * Dice. Only the `Math`/`JSON`/`Date`/etc. standard globals (the same allowlist
 * posture as the Dice VM), a capturing `console`, and the `experience` channel
 * are available. Deterministic given a deterministic host context (state +
 * participants + the seeded `random` stream the kernel injects).
 *
 * Trust posture (per plan): `node:vm` is treated honestly as trusted-code
 * runtime isolation, not secure confinement. The CPU timeout bounds user logic;
 * the real security boundary for untrusted visuals is the Wave 6 iframe. Rules
 * trust is explicit and revision-specific (source-hash snapshot).
 */

import { runInNewContext } from "node:vm";

/** Default timeout for a single experience VM execution (discovery or method), in ms. */
export const EXPERIENCE_VM_DEFAULT_TIMEOUT_MS = 5000;

/** The four mandatory rules methods every experience must define. */
export const EXPERIENCE_MANDATORY_METHODS = [
	"create",
	"project",
	"actions",
	"reduce",
] as const;

/**
 * The two optional methods. `choose` drives a script-controlled seat's turn
 * (returns one of the legal actions); `flavor` produces cosmetic display data
 * at projection time. Both receive an EPHEMERAL `context.chance` (non-recorded
 * randomness) rather than the deterministic cursor — see the kernel doc.
 */
export const EXPERIENCE_OPTIONAL_METHODS = ["choose", "flavor"] as const;

export type ExperienceMandatoryMethod = (typeof EXPERIENCE_MANDATORY_METHODS)[number];
export type ExperienceOptionalMethod = (typeof EXPERIENCE_OPTIONAL_METHODS)[number];
export type ExperienceMethodName = ExperienceMandatoryMethod | ExperienceOptionalMethod;

// ─── Typed failures ──────────────────────────────────────────────────────────

export type ExperienceSandboxErrorKind =
	| "timeout"
	| "syntax"
	| "runtime"
	| "no_registration"
	| "multi_registration"
	| "missing_method";

export interface ExperienceConsoleEntry {
	level: "log" | "warn" | "error";
	args: string[];
}

export interface ExperienceSandboxFailure {
	readonly ok: false;
	readonly kind: ExperienceSandboxErrorKind;
	readonly message: string;
	readonly console: ExperienceConsoleEntry[];
}

// ─── Raw registration (straight from the VM, unvalidated) ────────────────────

/**
 * The raw object an experience script passes to `context.experience.register`.
 * Every field is `unknown`; the kernel validates and narrows it. The four
 * methods are VM-created closures that must NOT leave the process, so discovery
 * confirms their presence but does not return them.
 */
export interface RawExperienceRegistration {
	apiVersion: unknown;
	manifest: unknown;
	capabilities: unknown;
	create: unknown;
	project: unknown;
	actions: unknown;
	reduce: unknown;
	/** Optional script-chooser (drives a script-controlled seat's turn). */
	choose?: unknown;
	/** Optional display-time cosmetic projection (may use ephemeral chance). */
	flavor?: unknown;
	/** Optional package-authored setup-field descriptor (IR-70F); the kernel
	 *  schema-validates it as `experienceSetupDefinitionSchema`. */
	setup?: unknown;
}

// ─── Discovery output ────────────────────────────────────────────────────────

export interface ExperienceDiscoverySuccess {
	readonly ok: true;
	/** Raw apiVersion (the kernel schema-validates it as a positive integer). */
	readonly apiVersion: unknown;
	/** Raw manifest (the kernel schema-validates id/name). */
	readonly manifest: unknown;
	/** Raw declared capabilities (the kernel schema-validates the array). */
	readonly capabilities: unknown;
	/** Whether the optional `choose` method is present as a function. */
	readonly hasChoose: boolean;
	/** Whether the optional `flavor` method is present as a function. */
	readonly hasFlavor: boolean;
	/** Raw optional setup descriptor (the kernel schema-validates it, IR-70F). */
	readonly setup: unknown;
	/** SHA-256 of the source body — the snapshot-isolation hash for the session. */
	readonly sourceHash: string;
	/** Captured console output from the discovery execution. */
	readonly console: ExperienceConsoleEntry[];
}

export type ExperienceDiscoveryResult =
	| ExperienceDiscoverySuccess
	| ExperienceSandboxFailure;

// ─── Method execution ────────────────────────────────────────────────────────

export interface ExperienceMethodArgs {
	/**
	 * The method's first argument — the host context the kernel builds:
	 * `{ state?, participants?, random?, helpers }`. The kernel freezes
	 * authoritative inputs before injection so a method cannot mutate them.
	 */
	hostContext: unknown;
	/**
	 * The method's second argument — `settings` (create), `viewer`
	 * (project/actions), or `action` (reduce).
	 */
	input: unknown;
}

export interface ExperienceMethodSuccess {
	readonly ok: true;
	/** Raw method return value; the kernel validates shape + JSON bounds. */
	readonly output: unknown;
	readonly console: ExperienceConsoleEntry[];
}

export type ExperienceMethodResult =
	| ExperienceMethodSuccess
	| ExperienceSandboxFailure;

// ─── Standard globals allowlist (matches the Dice VM's posture) ──────────────

/**
 * Standard JS globals an experience script may use. Deliberately excludes
 * `setTimeout`/`setInterval`, `fetch`, `Promise`, `require`, `process`,
 * `globalThis`, `import`, `eval`, `Function`, `WebAssembly`, and `Reflect` —
 * the same confinement posture as the prompt and Dice VMs, applied to an
 * experience-only API surface. No `Promise` means an `async` method is rejected
 * at the boundary (its return value is not JSON-safe).
 */
function buildStandardGlobals(console: ExperienceCapturingConsole): Record<string, unknown> {
	return {
		Math,
		JSON,
		Date,
		parseInt,
		parseFloat,
		isNaN,
		isFinite,
		Array,
		Object,
		String,
		Number,
		Boolean,
		RegExp,
		Map,
		Set,
		Error,
		console,
	};
}

interface ExperienceCapturingConsole {
	log: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Run an experience script's body once in discovery mode, collecting the single
 * definition it must register via `context.experience.register(...)`. Validates
 * exactly one registration and mandatory-method presence; returns the static
 * registration fields plus the source hash and captured console. Full schema
 * validation of the manifest/capabilities is the kernel's job.
 *
 * Deterministic for identical source.
 */
export function discoverExperience(
	code: string,
	scriptName: string,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceDiscoveryResult {
	const registrations: RawExperienceRegistration[] = [];
	const consoleBuffer: ExperienceConsoleEntry[] = [];
	const console = makeCapturingConsole(consoleBuffer);

	const sandbox: Record<string, unknown> = {
		context: {
			experience: {
				register(def: RawExperienceRegistration): void {
					registrations.push(def);
				},
			},
		},
		...buildStandardGlobals(console),
	};

	let vmError: ExperienceSandboxFailure | null = null;
	try {
		runInNewContext(code, sandbox, { timeout: timeoutMs, filename: scriptName });
	} catch (err: unknown) {
		vmError = sandboxFailure(classifyVmError(err), extractMessage(err), consoleBuffer);
	}

	if (vmError !== null) return vmError;

	const count = registrations.length;
	if (count === 0) {
		return sandboxFailure(
			"no_registration",
			"context.experience.register was not called",
			consoleBuffer,
		);
	}
	if (count > 1) {
		return sandboxFailure(
			"multi_registration",
			`context.experience.register was called ${count} times; exactly one definition is allowed`,
			consoleBuffer,
		);
	}

	const def = registrations[0] as Partial<RawExperienceRegistration> | undefined;
	for (const method of EXPERIENCE_MANDATORY_METHODS) {
		if (def === undefined || typeof def[method] !== "function") {
			return sandboxFailure(
				"missing_method",
				`mandatory method "${method}" is missing or not a function`,
				consoleBuffer,
			);
		}
	}

	return {
		ok: true,
		apiVersion: def?.apiVersion,
		manifest: def?.manifest,
		capabilities: def?.capabilities,
		hasChoose: def?.choose !== undefined && typeof def.choose === "function",
		hasFlavor: def?.flavor !== undefined && typeof def.flavor === "function",
		setup: def?.setup,
		sourceHash: hashSource(code),
		console: consoleBuffer,
	};
}

// ─── Method execution ────────────────────────────────────────────────────────

/**
 * Run an experience script's body and invoke one mandatory method
 * `fn(hostContext, input)` inside the SAME `runInNewContext` call so the timeout
 * envelope covers user-authored logic. The body re-registers its single
 * definition; the orchestration snippet then locates it and calls the method.
 *
 * The raw return value is surfaced for the kernel to validate. Deterministic
 * given a deterministic host context.
 */
export function runExperienceMethod(
	code: string,
	scriptName: string,
	method: ExperienceMethodName,
	args: ExperienceMethodArgs,
	timeoutMs: number = EXPERIENCE_VM_DEFAULT_TIMEOUT_MS,
): ExperienceMethodResult {
	const registrations: RawExperienceRegistration[] = [];
	const consoleBuffer: ExperienceConsoleEntry[] = [];
	const console = makeCapturingConsole(consoleBuffer);

	const sandbox: Record<string, unknown> = {
		context: {
			experience: {
				register(def: RawExperienceRegistration): void {
					registrations.push(def);
				},
			},
		},
		// Handles the orchestration snippet reads/writes (plain `var` for VM compat).
		__registered: registrations,
		__method: String(method),
		__hostContext: args.hostContext,
		__input: args.input,
		__output: null,
		__errorKind: null,
		__error: null,
		...buildStandardGlobals(console),
	};

	const orchestration = [
		";(function () {",
		"  var reg = __registered;",
		"  if (reg.length === 0) { __errorKind = 'no_registration'; __error = 'context.experience.register was not called'; return; }",
		"  if (reg.length > 1) { __errorKind = 'multi_registration'; __error = 'context.experience.register was called ' + reg.length + ' times'; return; }",
		"  var def = reg[0];",
		"  var fn = def ? def[__method] : null;",
		"  if (typeof fn !== 'function') { __errorKind = 'missing_method'; __error = 'method \"' + __method + '\" is missing or not a function'; return; }",
		"  try {",
		"    __output = fn(__hostContext, __input);",
		"    __errorKind = null;",
		"  } catch (e) {",
		"    __errorKind = 'runtime';",
		"    __error = (e && e.message) ? String(e.message) : String(e);",
		"  }",
		"})();",
	].join("\n");

	try {
		runInNewContext(code + "\n" + orchestration, sandbox, {
			timeout: timeoutMs,
			filename: scriptName,
		});
	} catch (err: unknown) {
		return sandboxFailure(classifyVmError(err), extractMessage(err), consoleBuffer);
	}

	const errorKind = sandbox.__errorKind as ExperienceSandboxErrorKind | null;
	if (errorKind !== null) {
		return sandboxFailure(errorKind, String(sandbox.__error ?? ""), consoleBuffer);
	}
	return { ok: true, output: sandbox.__output, console: consoleBuffer };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashSource(code: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(new TextEncoder().encode(code))
		.digest("hex");
}

function makeCapturingConsole(buffer: ExperienceConsoleEntry[]): ExperienceCapturingConsole {
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

// Note: Bun's JavaScriptCore throws VM errors cross-realm — they carry a `name`
// and `message` but are NOT `instanceof Error` in the host realm, so we access
// fields structurally rather than via `instanceof Error`.
function classifyVmError(err: unknown): ExperienceSandboxErrorKind {
	if (err !== null && typeof err === "object") {
		const code = (err as { code?: unknown }).code;
		if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return "timeout";
		if ((err as { name?: unknown }).name === "SyntaxError") return "syntax";
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && /timed\s*out|execution timed out/i.test(message)) {
			return "timeout";
		}
		return "runtime";
	}
	if (typeof err === "string" && /timed\s*out/i.test(err)) return "timeout";
	return "runtime";
}

function extractMessage(err: unknown): string {
	if (err !== null && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(err);
}

function sandboxFailure(
	kind: ExperienceSandboxErrorKind,
	message: string,
	consoleBuffer: ExperienceConsoleEntry[],
): ExperienceSandboxFailure {
	return { ok: false, kind, message, console: consoleBuffer };
}
