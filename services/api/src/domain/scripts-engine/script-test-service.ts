import type { StoreContainer } from "@vibe-tavern/db";
import type {
  DiceActorType,
  DiceCheckDefinition,
  DiceFaceShape,
  DiceResolution,
} from "@vibe-tavern/domain";
import type { RandomSource } from "@vibe-tavern/domain";
import { executeScripts } from "./script-sandbox.js";
import {
  discoverDiceChecks,
  executeDiceRoll,
} from "./dice-script-sandbox.js";
import {
  validateRegistration,
  validateResolveOutput,
} from "./dice-script-service.js";

export interface ScriptTestInput {
	scriptId: string;
	/** Unsaved authoring buffer for this run only; omitted → stored code. */
	code?: string;
	messages?: Array<{ role: string; content: string }>;
	characterName?: string;
	characterPersonality?: string;
	characterScenario?: string;
	lastMessage?: string;
	/** Optional persona to expose as `context.persona`. Lets a user test
	 *  persona-branching scripts without wiring up a real chat. */
	persona?: { name: string; description: string };
}

// ─── Prompt-script test result (the existing seven-channel tester output) ────

export interface PromptScriptTestResult {
	personality: string;
	scenario: string;
	state: Record<string, unknown>;
	/** Messages a script pushed via `context.chat.injectMessage(...)`.
	 *  Surfaced so the test panel can show inject-only scripts (e.g. the
	 *  dice-roller template), which produce no personality/scenario output. */
	injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
	/** Console output captured from the script (P1) — log/warn/error entries the
	 *  script emitted, for the test panel's debug console. */
	console: Array<{ level: 'log' | 'warn' | 'error'; args: string }>;
	/** Final shared bucket after the script ran (P5). Turn-scoped; surfaced so
	 *  the test panel can confirm cross-script handoff values. */
	shared: Record<string, unknown>;
	errors: Array<{ scriptId: string; scriptName: string; error: string; line?: number }>;
}

// ─── Dice-script test result (discovery + deterministic sample rolls) ────────

/** One check's sample-roll outcome inside the Dice test panel. */
export interface DiceSampleRoll {
	checkId: string;
	checkLabel: string;
	notation: string;
	faceShape: DiceFaceShape;
	resolution: DiceResolution;
	/** `ok: true` with the validated attempt/final, or `ok: false` with an error
	 *  tag (vm_error / validation_error / no_resolve_fn / etc.). */
	result:
		| { ok: true; faces: number[]; modifier: number; subtotal: number; total: number; final?: { total: number; outcome?: string; degree?: string; constraint?: string }; retryReason?: string; policy?: string; grantReason?: string }
		| { ok: false; error: string };
}

export interface DiceScriptTestResult {
	/** Validated check descriptors from discovery. */
	checks: DiceCheckDefinition[];
	/** One deterministic sample roll per valid check (first allowed actor). */
	sampleRolls: DiceSampleRoll[];
	/** Discovery VM error (syntax/runtime/timeout); null when clean. */
	discoveryError: string | null;
}

// ─── Discriminated result (dispatch by scriptKind) ───────────────────────────

export type ScriptTestResult =
	| ({ kind: "prompt" } & PromptScriptTestResult)
	| ({ kind: "dice" } & DiceScriptTestResult);

// ─── Main dispatch ───────────────────────────────────────────────────────────

/**
 * Test a script by dispatching on its `scriptKind`. Prompt scripts run the
 * existing seven-channel tester UNCHANGED; Dice scripts get discovery plus
 * deterministic sample-roll results against simulated persona/character inputs.
 * A script with no `scriptKind` (legacy/mock) is treated as `prompt` — the
 * default kind — so existing prompt-script tests are unaffected.
 */
export async function testScript(
	stores: StoreContainer,
	input: ScriptTestInput,
): Promise<ScriptTestResult> {
	const script = await stores.scripts.getById(input.scriptId);
	if (!script) throw new Error(`Script not found: ${input.scriptId}`);

	const code = input.code ?? script.code;

	if (script.scriptKind === "dice") {
		return { kind: "dice", ...testDiceScript(code, script.name, input) };
	}
	return { kind: "prompt", ...testPromptScript(code, script, input) };
}

// ─── Prompt-script tester (unchanged behavior) ───────────────────────────────

function testPromptScript(
	code: string,
	script: { id: string; name: string; sortOrder: number },
	input: ScriptTestInput,
): PromptScriptTestResult {
	const messages =
		input.messages && input.messages.length > 0
			? input.messages
			: input.lastMessage
				? [{ role: "user", content: input.lastMessage }]
				: [];

	const sandboxMessages = messages.map((m) => ({ message: m.content, role: m.role }));

	const result = executeScripts({
		scripts: [
			{
				id: script.id,
				name: script.name,
				code,
				sortOrder: script.sortOrder,
			},
		],
		chat: { messages: sandboxMessages },
		character: {
			name: input.characterName ?? "Assistant",
			personality: input.characterPersonality ?? "",
			scenario: input.characterScenario ?? "",
		},
		activeLoreEntries: [],
		scriptState: {},
		persona: input.persona,
	});

	const run = result.scriptRuns[0];

	return {
		personality: result.character.personality,
		scenario: result.character.scenario,
		state: result.updatedScriptState[script.id] ?? {},
		injectedMessages: result.injectedMessages,
		console: run?.console ?? [],
		shared: result.shared,
		errors: result.errors,
	};
}

// ─── Dice-script tester (discovery + deterministic sample rolls) ─────────────

/**
 * Deterministic RandomSource for the Dice test panel. Uses a fixed-seed
 * mulberry32 PRNG so sample rolls are reproducible across panel re-runs — the
 * author sees the same faces every time for the same script body, making it
 * easy to verify check logic without cryptographic randomness.
 */
function createDeterministicTestRng(): RandomSource {
	let seed = 0x12345678;
	return {
		intBelow(max: number): number {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			const float = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			return Math.floor(float * max);
		},
	};
}

function testDiceScript(
	code: string,
	scriptName: string,
	input: ScriptTestInput,
): DiceScriptTestResult {
	const discovery = discoverDiceChecks(code, scriptName);
	if (discovery.error) {
		return { checks: [], sampleRolls: [], discoveryError: discovery.error };
	}

	// Validate registrations into descriptors.
	const checks: DiceCheckDefinition[] = [];
	for (const raw of discovery.registrations) {
		const def = validateRegistration(raw);
		if (def) checks.push(def);
	}

	// One deterministic sample roll per valid check, using the first allowed
	// actor. The actor label comes from the test body's persona/character name.
	const rng = createDeterministicTestRng();
	const characterLabel = input.characterName ?? "Character";
	const personaLabel = input.persona?.name ?? "Persona";

	const sampleRolls: DiceSampleRoll[] = checks.map((check) => {
		const actorType: DiceActorType = check.actors[0];
		const actorLabel = actorType === "persona" ? personaLabel : characterLabel;

		const roll = executeDiceRoll(code, scriptName, check.id, {
			actor: { actorType, actorId: `test_${actorType}`, actorLabel },
			priorAttempts: [],
			rng,
		});

		if (!roll.ok || roll.output == null) {
			return {
				checkId: check.id,
				checkLabel: check.label,
				notation: check.notation,
				faceShape: check.faceShape,
				resolution: check.resolution,
				result: { ok: false, error: roll.error ?? "resolve() returned no output" },
			};
		}

		const validated = validateResolveOutput(roll.output, check);
		if (!validated.ok) {
			return {
				checkId: check.id,
				checkLabel: check.label,
				notation: check.notation,
				faceShape: check.faceShape,
				resolution: check.resolution,
				result: { ok: false, error: validated.error.message },
			};
		}

		return {
			checkId: check.id,
			checkLabel: check.label,
			notation: check.notation,
			faceShape: check.faceShape,
			resolution: check.resolution,
			result: {
				ok: true,
				faces: validated.faces,
				modifier: validated.modifier,
				subtotal: validated.subtotal,
				total: validated.total,
				...(validated.final !== undefined ? { final: validated.final } : {}),
				...(validated.retryReason !== undefined ? { retryReason: validated.retryReason } : {}),
				...(validated.policy !== undefined ? { policy: validated.policy } : {}),
				...(validated.grantReason !== undefined ? { grantReason: validated.grantReason } : {}),
			},
		};
	});

	return { checks, sampleRolls, discoveryError: null };
}

export interface ParsedScriptImport {
	name: string;
	code: string;
}

export function parseScriptImport(
	body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string },
): ParsedScriptImport {
	let name = body.name ?? "Imported Script";
	let code = "";

	if (body.format === "js" && body.code) {
		code = body.code;
	} else if (body.format === "json" && body.jsonText) {
		try {
			const parsed = JSON.parse(body.jsonText);
			if (typeof parsed === "object" && parsed !== null) {
				name = parsed.name ?? name;
				code = parsed.code ?? parsed.script ?? "";
			}
		} catch {
			throw new Error("Invalid JSON in script import");
		}
	}

	return { name, code };
}
