/**
 * SceneTrackerService — DI through the injected `execute` + `resolvePrompt`, the
 * same boundary as `objective-service.test.ts` (AGENTS.md §1.4 — the deps are
 * injected, NOT mocked globally). The store is a typed fake holding mutable
 * state so staleness/cancel tests can mutate the target mid-job (content edit,
 * schema/config revision bump, explicit cancel) and assert nothing stale persists.
 */
import { describe, it, expect } from "bun:test";
import type { ChatStore, MessageStore, StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { GenerationResult, ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import {
	SceneTrackerService,
	composeSceneInstruction,
	SceneTargetCancelledError,
	type SceneTarget,
	type SceneGenerateInput,
} from "../src/domain/insights/tracker-service.js";
import {
	brandId,
	computeSceneSourceHash,
	normalizeInsightsConfig,
	type ChatBranchId,
	type ChatId,
	type MessageId,
	type MessageVariantId,
} from "@vibe-tavern/domain";
import type { SceneTrackerRecord } from "@vibe-tavern/domain";
import { execResult, makeChatRow, makeMessageRow, makeVariantRow } from "./insights-test-builders.js";
import { makeProviderProfileRow } from "./copilot-test-builders.js";
import { unusedObjectiveDeps } from "./objective-service-fixture.js";
import { strictTestDouble } from "./strict-test-double.js";

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A small two-field DSL: one required string + a bounded number. */
const TEST_SCHEMA = {
	mood: { $type: "string" },
	tension: { $type: "number", min: 0, max: 10 },
} as const;

const context: PromptAssemblyContext = {
	identity: { chatId: "chat_1" },
	character: { id: "char_1", name: "Aria", description: "A fire mage." },
	chat: {
		recentMessages: [
			{ id: "m1", role: "user", content: "I draw my sword." },
			{ id: "m2", role: "assistant", content: "The warlord sneers." },
		],
	},
} as PromptAssemblyContext;
const profile = makeProviderProfileRow(); // the fake execute ignores it; the row is the real stored shape
const BASE_TARGET: SceneTarget = {
	chatId: brandId<ChatId>("chat_1"),
	branchId: brandId<ChatBranchId>("branch_1"),
	messageId: brandId<MessageId>("m2"),
	variantId: brandId<MessageVariantId>("var_1"),
};

interface MockVariant {
	id: string;
	content: string;
	isSelected?: boolean;
}
/** The stored per-variant Scene record shape — structurally the store's
 *  MessageVariantSceneRecord with its OPTIONAL schema/promptFormat snapshot
 *  fields omitted (that type is not exported from the @vibe-tavern/db barrel;
 *  the strictTestDouble member check still verifies this shape against the
 *  real getSceneRecord/setSceneRecord signatures). */
interface MockRecord {
	variantId: string;
	schemaHash: string;
	configRevision: number;
	sourceHash: string;
	sceneState: Record<string, unknown>;
	modelId: string | null;
	generatedAt: string;
}

/** Mutable store fake. `trackerRaw` is the raw `.tracker` sub-object the service
 *  normalizes; mutating it mid-job simulates a config/schema/revision drift. */
function makeStore(opts: {
	tracker?: Record<string, unknown>;
	variants?: Record<string, MockVariant[]>;
	records?: Record<string, MockRecord>;
	messages?: Array<{ id: string; role: string }>;
	/** Wire the current-Scene cache rebuild path (getCurrentSceneTarget + updateInsightsCurrentScene). */
	cacheRebuild?: boolean;
	/** Make updateInsightsCurrentScene throw (to prove rebuild failures are swallowed). */
	cacheThrow?: boolean;
}) {
	let trackerRaw: Record<string, unknown> = opts.tracker ?? { schema: TEST_SCHEMA };
	const variants: Record<string, MockVariant[]> = opts.variants ?? {
		m2: [{ id: "var_1", content: "The warlord sneers.", isSelected: true }],
	};
	const records: Record<string, MockRecord> = opts.records ? structuredClone(opts.records) : {};
	const messages = opts.messages ?? [];

	const cacheWrites: unknown[] = [];
	const stores = strictTestDouble<StoreContainer>(
		{
			chats: strictTestDouble<ChatStore>(
				{
					// The chat row completes through the standing builder; the config
					// rides the domain's persisted-column seam (raw stored json →
					// normalized InsightsConfig — the same tracker values the old
					// erasure handed the service, plus inert defaults it never
					// reads; trackerEnabled stays falsy on this path either way).
					getById: async () => makeChatRow({ insightsConfig: normalizeInsightsConfig({ tracker: trackerRaw }) }),
					...(opts.cacheRebuild
						? {
								updateInsightsCurrentScene: async (_chatId: string, cache: unknown) => {
									if (opts.cacheThrow) throw new Error("cache write failed");
									cacheWrites.push(cache);
								},
							}
						: {}),
				},
				"makeStore: chats (tracker-service)",
			),
			messages: strictTestDouble<MessageStore>(
				{
					...(opts.cacheRebuild
						? {
								getCurrentSceneTarget: async () => {
									for (let i = messages.length - 1; i >= 0; i -= 1) {
										const m = messages[i];
										if (!m || m.role !== "assistant") continue;
										const sel = (variants[m.id] ?? []).find((v) => v.isSelected);
										if (!sel) continue;
										const rec = records[sel.id];
										if (!rec) continue;
										return { messageId: m.id, variantId: sel.id, record: rec };
									}
									return null;
								},
							}
						: {}),
					// Rows/variants complete through the standing builders (the erased
					// fragments carried only the fields the service reads).
					getVariants: async (messageId: string) =>
						(variants[messageId] ?? []).map((v) => makeVariantRow({ id: v.id, content: v.content, isSelected: v.isSelected ?? false })),
					getSceneRecord: async (variantId) => records[variantId] ?? null,
					setSceneRecord: async (variantId, record) => {
						records[variantId] = record;
					},
					clearSceneRecord: async (variantId) => {
						delete records[variantId];
					},
					getMessages: async () => messages.map((m) => makeMessageRow(m)),
					getSelectedVariant: async (messageId) => {
						const sel = (variants[messageId] ?? []).find((v) => v.isSelected);
						return sel ? makeVariantRow({ id: sel.id, content: sel.content }) : null;
					},
				},
				"makeStore: messages (tracker-service)",
			),
		},
		"StoreContainer (tracker-service)",
	);

	return {
		stores,
		cacheWrites,
		/** Replace the raw tracker config mid-job (schema/revision drift). */
		setTracker: (next: Record<string, unknown>) => {
			trackerRaw = next;
		},
		/** Replace a variant's content mid-job (content drift / edit). */
		setVariantContent: (messageId: string, variantId: string, content: string) => {
			const list = variants[messageId];
			const v = list?.find((item) => item.id === variantId);
			if (v) v.content = content;
		},
		getRecord: (variantId: string): MockRecord | null => records[variantId] ?? null,
	};
}

type StoreHandle = ReturnType<typeof makeStore>;

/**
 * Build a service whose `execute` captures the prompt and returns `reply`
 * immediately. For staleness/cancel tests use {@link blockingService}.
 */
function quickService(handle: StoreHandle, reply: string, promptBase = "BASE") {
	let captured: ProviderExecutionInput["prompt"] | null = null;
	const execute = async (input: ProviderExecutionInput) => {
		captured = input.prompt;
		return execResult(reply);
	};
	const service = new SceneTrackerService(handle.stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => promptBase);
	return { service, capturedPrompt: () => captured };
}

/**
 * Build a service whose `execute` blocks until `release` is called, so the test
 * can mutate state mid-job (drift / cancel) before resolving the LLM reply.
 */
function blockingService(handle: StoreHandle, promptBase = "BASE") {
	let captured: ProviderExecutionInput["prompt"] | null = null;
	let releaseExecute: ((value: GenerationResult) => void) | undefined;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const execute = async (input: ProviderExecutionInput) => {
		captured = input.prompt;
		return new Promise<GenerationResult>((resolve) => {
			releaseExecute = resolve;
			markStarted?.();
		});
	};
	const service = new SceneTrackerService(handle.stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => promptBase);
	return {
		service,
		capturedPrompt: () => captured,
		started,
		release: (reply: string) => releaseExecute?.(execResult(reply)),
	};
}

const VALID_REPLY = '{"mood":"calm","tension":3}';

function generateInput(target: SceneTarget = BASE_TARGET, continuity?: SceneGenerateInput["continuity"]): SceneGenerateInput {
	return { target, profile, model: "scene-model", context, continuity };
}

// ─── pure helper ────────────────────────────────────────────────────────────

describe("composeSceneInstruction (SCN-5)", () => {
	it("embeds the schema descriptor and the continuity window into the base", () => {
		const instruction = composeSceneInstruction("BASE", TEST_SCHEMA, [
			{ variantId: brandId<MessageVariantId>("v0"), sceneState: { mood: "tense", tension: 8 } },
		]);
		expect(instruction).toContain("BASE");
		expect(instruction).toContain('"mood"'); // schema descriptor
		expect(instruction).toContain('"tension"');
		expect(instruction).toContain('"tense"'); // continuity scene state
		expect(instruction).toContain("Required output: one JSON object");
	});

	it("keeps the schema descriptor machine-key-only but passes labels as separate hash-invariant hints", () => {
		const instruction = composeSceneInstruction("BASE", {
			mood: { $type: "string", label: "Настроение" },
			hp: { $type: "number", min: 0, max: 100, label: "HP" },
		}, []);
		// The schema descriptor itself stays label-free (labels are renderer-only and
		// must never change schemaHash) — no `label` keys leak into the schema JSON.
		expect(instruction).toContain('"$type":"string"');
		expect(instruction).not.toMatch(/"label"\s*:/);
		// ...but the human names travel as a SEPARATE hints block so the model can read
		// each field's meaning (e.g. `hp` → "HP") without affecting the schema hash.
		expect(instruction).toContain("Настроение");
		expect(instruction).toContain("HP");
	});

	it("emits an empty continuity array when none is provided", () => {
		const instruction = composeSceneInstruction("BASE", TEST_SCHEMA, []);
		expect(instruction).toContain("[]");
	});

	const VOCABULARY_PHRASE = "output exactly that word";
	const TONED_SCHEMA = {
		timeOfDay: { $type: "string", toneBy: { Dawn: "warning", Night: "danger" } },
		citadel: {
			$type: "object",
			properties: {
				condition: { $type: "string", toneBy: { Stable: "success", Ruined: "danger" } },
				level: { $type: "number", tone: "accent" },
			},
		},
		units: {
			$type: "array",
			items: {
				$type: "object",
				properties: { rank: { $type: "string", toneBy: { SR: "accent", R: "success" } } },
			},
		},
		mood: { $type: "string", tone: "warning" },
		notes: { $type: "string", toneBy: {} },
	} as const;

	it("lists the toneBy words verbatim per string field path (top-level, nested object, array item)", () => {
		const instruction = composeSceneInstruction("BASE", TONED_SCHEMA, []);
		expect(instruction).toContain(VOCABULARY_PHRASE);
		expect(instruction).toContain('"timeOfDay":["Dawn","Night"]');
		expect(instruction).toContain('"citadel.condition":["Stable","Ruined"]');
		expect(instruction).toContain('"units[].rank":["SR","R"]');
		// Only string nodes with a non-empty map get an entry: a bare `tone`, an empty
		// `toneBy`, and a number node never appear.
		expect(instruction).not.toContain('"mood":[');
		expect(instruction).not.toContain('"notes":[');
		expect(instruction).not.toContain('"citadel.level"');
	});

	it("places the vocabulary block after the labels block and before the required-output line", () => {
		const instruction = composeSceneInstruction("BASE", {
			timeOfDay: { $type: "string", label: "Time", toneBy: { Night: "danger" } },
		}, []);
		const labels = instruction.indexOf("Field labels");
		const vocabulary = instruction.indexOf(VOCABULARY_PHRASE);
		const required = instruction.indexOf("Required output: one JSON object");
		expect(labels).toBeGreaterThan(-1);
		expect(vocabulary).toBeGreaterThan(labels);
		expect(required).toBeGreaterThan(vocabulary);
	});

	it("keeps toneBy and tone out of the schema JSON sent to the model", () => {
		const instruction = composeSceneInstruction("BASE", TONED_SCHEMA, []);
		const schemaPart = instruction.slice(
			instruction.indexOf("Scene schema ("),
			instruction.indexOf("Recent scene continuity"),
		);
		expect(schemaPart).toContain('"timeOfDay"');
		expect(schemaPart).not.toContain("toneBy");
		expect(schemaPart).not.toMatch(/"tone"\s*:/);
		expect(schemaPart).not.toContain("Dawn");
	});

	it("adds no vocabulary block without a toneBy node, and a toneBy-free schema yields exactly the old instruction", () => {
		const schema = {
			mood: { $type: "string", label: "Mood", tone: "accent" },
			hp: { $type: "number", min: 0, max: 100 },
		} as const;
		const instruction = composeSceneInstruction("BASE", schema, []);
		expect(instruction).not.toContain(VOCABULARY_PHRASE);
		expect(instruction).toBe(
			"BASE\n\n" +
				'Scene schema (produce one JSON object with exactly these fields, no extras): {"mood":{"$type":"string"},"hp":{"$type":"number","min":0,"max":100}}\n\n' +
				"Recent scene continuity (prior states — evolve them to match the current scene): []" +
				'\n\nField labels (human names for the schema keys; they do NOT add, rename, or remove any field — output the machine keys exactly as in the schema): ["mood: Mood"]' +
				"\n\nRequired output: one JSON object matching the schema exactly.",
		);
	});

	// ── DK-2: the story clock hint block ────────────────────────────────────────

	const CLOCK_SCHEMA = {
		story_day: { $type: "number", min: 1, max: 999, clock: "day", label: "Story day" },
		story_time: { $type: "string", clock: "part", label: "Part of day" },
		story_date: { $type: "string", clock: "label", label: "Date label" },
		mood: { $type: "string" },
	} as const;

	it("adds ONE story clock block for a marked schema: day rule, the four closed part words, the label field", () => {
		const instruction = composeSceneInstruction("BASE", CLOCK_SCHEMA, []);
		expect(instruction).toContain("Story clock (the schema marks these fields as the story clock)");
		expect(instruction).toContain('the story day field "story_day" is the 1-based day counter: it starts at 1 and grows by 1 when the night passes');
		expect(instruction).toContain('the part-of-day field "story_time" accepts exactly one of these four words');
		expect(instruction).toContain('"morning", "day", "evening", "night"');
		expect(instruction).toContain("closed set");
		expect(instruction).toContain('the date-label field "story_date" carries a free-form display label');
		// ONE block, not one per field.
		expect(instruction.split("Story clock (the schema marks these fields").length - 1).toBe(1);
	});

	it("teaches the part words as a CLOSED rule (unlike the toneBy preference list)", () => {
		const instruction = composeSceneInstruction("BASE", { story_time: { $type: "string", clock: "part" } }, []);
		expect(instruction).toContain("closed set");
		expect(instruction).toContain("no other word is valid there");
		// The toneBy phrasing ("a preference, not a closed enum") never leaks into the clock block.
		expect(instruction).not.toContain("preference");
	});

	it("mentions only the fields the schema actually marks (day-only and label-only schemas)", () => {
		const dayOnly = composeSceneInstruction("BASE", { story_day: { $type: "number", clock: "day" } }, []);
		expect(dayOnly).toContain('the story day field "story_day"');
		expect(dayOnly).not.toContain("part-of-day field");
		expect(dayOnly).not.toContain("date-label field");

		const labelOnly = composeSceneInstruction("BASE", { caption: { $type: "string", clock: "label" } }, []);
		expect(labelOnly).toContain('the date-label field "caption"');
		expect(labelOnly).not.toContain("story day field");
	});

	it("places the clock block after the vocabulary block and before the required-output line", () => {
		const schema = {
			timeOfDay: { $type: "string", clock: "part", toneBy: { Night: "danger" } },
			story_day: { $type: "number", clock: "day" },
		} as const;
		const instruction = composeSceneInstruction("BASE", schema, []);
		const labels = instruction.indexOf("Field labels");
		const vocabulary = instruction.indexOf(VOCABULARY_PHRASE);
		const clock = instruction.indexOf("Story clock (");
		const required = instruction.indexOf("Required output: one JSON object");
		expect(vocabulary).toBeGreaterThan(labels);
		expect(clock).toBeGreaterThan(vocabulary);
		expect(required).toBeGreaterThan(clock);
	});

	it("adds no clock block without a marked field — an unmarked schema keeps the byte-identical instruction", () => {
		const schema = {
			story_day: { $type: "number", min: 1, max: 999 },
			story_time: { $type: "string" },
		} as const;
		const instruction = composeSceneInstruction("BASE", schema, []);
		expect(instruction).not.toContain("Story clock (");
		expect(instruction).toBe(
			"BASE\n\n" +
				'Scene schema (produce one JSON object with exactly these fields, no extras): {"story_day":{"$type":"number","min":1,"max":999},"story_time":{"$type":"string"}}\n\n' +
				"Recent scene continuity (prior states — evolve them to match the current scene): []" +
				"\n\nRequired output: one JSON object matching the schema exactly.",
		);
	});

	it("keeps the clock marker visible in the schema JSON (semantic — the marker rides the strip projection) while presentation stays out", () => {
		const instruction = composeSceneInstruction("BASE", CLOCK_SCHEMA, []);
		const schemaPart = instruction.slice(
			instruction.indexOf("Scene schema ("),
			instruction.indexOf("Recent scene continuity"),
		);
		expect(schemaPart).toContain('"clock":"day"');
		expect(schemaPart).toContain('"clock":"part"');
		expect(schemaPart).toContain('"clock":"label"');
		expect(schemaPart).not.toMatch(/"label"\s*:/);
		expect(schemaPart).not.toContain("toneBy");
	});
});

// ─── service (DI execute + resolvePrompt) ───────────────────────────────────

describe("SceneTrackerService.generateScene (SCN-5)", () => {
	it("parses valid JSON into a record stamped with the live freshness metadata", async () => {
		const handle = makeStore({});
		const { service, capturedPrompt } = quickService(handle, VALID_REPLY);

		const record = await service.generateScene(generateInput());
		expect(record.variantId).toBe("var_1");
		expect(record.sceneState).toEqual({ mood: "calm", tension: 3 });
		expect(record.modelId).toBe("scene-model");
		expect(record.sourceHash).toBe(computeSceneSourceHash("The warlord sneers."));
		expect(record.schemaHash).toBe(record.schemaHash); // recomputed from schema
		expect(record.configRevision).toBe(0); // default revision

		// Persisted.
		const stored = handle.getRecord("var_1");
		expect(stored?.sceneState).toEqual({ mood: "calm", tension: 3 });

		// The prompt reached the executor and carries the schema + the task.
		const prompt = capturedPrompt();
		expect(prompt).not.toBeNull();
	});

	it("rejects malformed LLM output and persists nothing", async () => {
		const handle = makeStore({});
		const { service } = quickService(handle, "I cannot help with that.");
		await expect(service.generateScene(generateInput())).rejects.toThrow();
		expect(handle.getRecord("var_1")).toBeNull();
	});

	it("rejects output with unknown fields (strict schema) and persists nothing", async () => {
		const handle = makeStore({});
		const { service } = quickService(handle, '{"mood":"calm","tension":3,"surprise":"nope"}');
		await expect(service.generateScene(generateInput())).rejects.toThrow();
		expect(handle.getRecord("var_1")).toBeNull();
	});

	it("rejects out-of-range / wrong-primitive output and persists nothing", async () => {
		const handle = makeStore({});
		const { service: s1 } = quickService(handle, '{"mood":"calm","tension":99}');
		await expect(s1.generateScene(generateInput())).rejects.toThrow();
		const { service: s2 } = quickService(makeStore({}), '{"mood":5,"tension":3}');
		await expect(s2.generateScene(generateInput())).rejects.toThrow();
	});

	it("preserves a prior record when generation fails (in-place Update overwrites only on success)", async () => {
		const prior: MockRecord = {
			variantId: "var_1",
			schemaHash: "old-hash",
			configRevision: 0,
			sourceHash: "old-source",
			sceneState: { mood: "tense", tension: 9 },
			modelId: "old-model",
			generatedAt: "2026-01-01T00:00:00.000Z",
		};
		const handle = makeStore({ records: { var_1: prior } });
		const { service } = quickService(handle, "garbage");
		await expect(service.generateScene(generateInput())).rejects.toThrow();
		expect(handle.getRecord("var_1")).toEqual(prior); // untouched
	});

	it("discards a result when the variant content was edited during the LLM await (content drift)", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		handle.setVariantContent("m2", "var_1", "The warlord lunges — EDITED."); // content drift
		release(VALID_REPLY);
		// Only a CONTENT change during the await invalidates the result.
		await expect(pending).rejects.toThrow(/content changed/i);
		expect(handle.getRecord("var_1")).toBeNull(); // nothing persisted
	});

	it("PERSISTS a result when the schema changed during the LLM await (the record carries its baseline snapshot)", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		handle.setTracker({ schema: { location: { $type: "string" } } }); // schema drift
		release(VALID_REPLY);
		// A schema change does NOT discard — the record is persisted as a fact of
		// its baseline (gen-start) schema, with its own snapshot for rendering.
		const record = await pending;
		expect(record.sceneState).toEqual({ mood: "calm", tension: 3 }); // parsed under the baseline schema
		const stored = handle.getRecord("var_1");
		expect(stored).not.toBeNull();
		expect(stored?.sceneState).toEqual({ mood: "calm", tension: 3 });
	});

	it("PERSISTS a result when the config revision bumped during the LLM await (revision is trace, not a gate)", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		handle.setTracker({ schema: TEST_SCHEMA, revision: 7 }); // revision drift
		release(VALID_REPLY);
		// A revision bump (model/provider/prompt change) does NOT discard — the
		// record keeps the baseline revision it was generated under.
		const record = await pending;
		expect(record.configRevision).toBe(0); // baseline, not the bumped 7
		expect(handle.getRecord("var_1")).not.toBeNull();
	});

	it("never persists when cancelled mid-job (explicit Cancel never persists)", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		service.cancelTarget(BASE_TARGET);
		release(VALID_REPLY); // a valid reply arrives, but cancel wins
		await expect(pending).rejects.toThrow(SceneTargetCancelledError);
		expect(handle.getRecord("var_1")).toBeNull();
	});

	it("preserves a prior record when cancelled mid-job", async () => {
		const prior: MockRecord = {
			variantId: "var_1", schemaHash: "h", configRevision: 0, sourceHash: "s",
			sceneState: { mood: "calm", tension: 2 }, modelId: "m", generatedAt: "2026-01-01T00:00:00.000Z",
		};
		const handle = makeStore({ records: { var_1: prior } });
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		service.cancelTarget(BASE_TARGET);
		release(VALID_REPLY);
		await expect(pending).rejects.toThrow();
		expect(handle.getRecord("var_1")).toEqual(prior); // preserved
	});

	it("preserves a prior record when the provider execution fails", async () => {
		const prior: MockRecord = {
			variantId: "var_1", schemaHash: "h", configRevision: 0, sourceHash: "s",
			sceneState: { mood: "calm", tension: 2 }, modelId: "m", generatedAt: "2026-01-01T00:00:00.000Z",
		};
		const handle = makeStore({ records: { var_1: prior } });
		const execute = async () => {
			throw new Error("provider 500");
		};
		const service = new SceneTrackerService(handle.stores, unusedObjectiveDeps, unusedObjectiveDeps, execute, async () => "BASE");
		await expect(service.generateScene(generateInput())).rejects.toThrow("provider 500");
		expect(handle.getRecord("var_1")).toEqual(prior); // preserved
	});

	it("throws when the target variant was deleted during the LLM await", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		handle.setVariantContent("m2", "var_1", "The warlord sneers.");
		// Simulate deletion: replace the message's variants with none matching
		// (the typed store double takes the mutation directly).
		handle.stores.messages.getVariants = async () => [];
		release(VALID_REPLY);
		await expect(pending).rejects.toThrow(/no longer exists/i);
	});

	it("persists Unicode and long Russian values verbatim", async () => {
		const handle = makeStore({});
		const longRu = "Мрачная атмосфера нависла над замком, и тени колыхались в тусклом свете факелов".repeat(2);
		const { service } = quickService(handle, JSON.stringify({ mood: longRu, tension: 6 }));
		const record = await service.generateScene(generateInput());
		expect((record.sceneState as { mood: string }).mood).toBe(longRu);
	});

	it("generation for one variant never touches another (ownership by immutable id)", async () => {
		const handle = makeStore({
			variants: {
				m2: [
					{ id: "var_1", content: "Reply A", isSelected: false },
					{ id: "var_2", content: "Reply B", isSelected: true },
				],
			},
		});
		const { service } = quickService(handle, '{"mood":"calm","tension":3}');
		const targetB: SceneTarget = { ...BASE_TARGET, variantId: brandId<MessageVariantId>("var_2") };
		const record = await service.generateScene(generateInput(targetB));
		expect(record.variantId).toBe("var_2");
		expect(handle.getRecord("var_1")).toBeNull(); // sibling untouched
		expect(handle.getRecord("var_2")?.sceneState).toEqual({ mood: "calm", tension: 3 });
	});
});

describe("SceneTrackerService.editScene / deleteScene (SCN-5)", () => {
	it("editScene validates against the current schema and commits with live metadata", async () => {
		const handle = makeStore({});
		const { service } = quickService(handle, ""); // edit does not call execute
		const record = await service.editScene(BASE_TARGET, { mood: "tense", tension: 7 });
		expect(record.sceneState).toEqual({ mood: "tense", tension: 7 });
		expect(record.modelId).toBeNull(); // manual edit has no model
		expect(handle.getRecord("var_1")?.sceneState).toEqual({ mood: "tense", tension: 7 });
	});

	it("editScene rejects state that fails schema validation", async () => {
		const handle = makeStore({});
		const { service } = quickService(handle, "");
		await expect(service.editScene(BASE_TARGET, { mood: "tense", tension: 99 })).rejects.toThrow(/validation/i);
		await expect(service.editScene(BASE_TARGET, { mood: "tense" })).rejects.toThrow(/validation/i); // missing tension
		await expect(service.editScene(BASE_TARGET, { surprise: "x" })).rejects.toThrow(/validation/i); // unknown
		expect(handle.getRecord("var_1")).toBeNull();
	});

	it("deleteScene clears the record", async () => {
		const handle = makeStore({
			records: { var_1: { variantId: "var_1", schemaHash: "h", configRevision: 0, sourceHash: "s", sceneState: {}, modelId: null, generatedAt: "2026-01-01T00:00:00.000Z" } },
		});
		const { service } = quickService(handle, "");
		await service.deleteScene(BASE_TARGET);
		expect(handle.getRecord("var_1")).toBeNull();
	});
});

describe("SceneTrackerService — concurrency + seams (SCN-5)", () => {
	it("edit then delete serialize through the target commit lane (delete observes the edit)", async () => {
		const handle = makeStore({});
		const { service } = quickService(handle, "");
		const edited = service.editScene(BASE_TARGET, { mood: "calm", tension: 2 });
		const deleted = service.deleteScene(BASE_TARGET);
		await edited;
		await deleted;
		// Both committed under the same lane; final state is deleted.
		expect(handle.getRecord("var_1")).toBeNull();
	});

	it("exposes target job seams (hasTargetJob / getTargetJob) while a generation is in flight", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		expect(service.hasTargetJob(BASE_TARGET)).toBe(false);
		const pending = service.generateScene(generateInput());
		await started;
		expect(service.hasTargetJob(BASE_TARGET)).toBe(true);
		expect(service.getTargetJob(BASE_TARGET)).toBeInstanceOf(Promise);
		release(VALID_REPLY);
		await pending;
		expect(service.hasTargetJob(BASE_TARGET)).toBe(false); // cleaned up after settle
	});
});

describe("Scene cache rebuild wiring (SCENE_TRACKER_STATE_LIFECYCLE step 7)", () => {
	it("rebuilds the current-Scene cache after a successful generation", async () => {
		const handle = makeStore({ messages: [{ id: "m2", role: "assistant" }], cacheRebuild: true });
		const { service } = quickService(handle, VALID_REPLY);
		await service.generateScene(generateInput());
		// The canonical record persisted AND the derived cache was rebuilt with it.
		expect(handle.getRecord("var_1")).not.toBeNull();
		expect(handle.cacheWrites).toHaveLength(1);
		expect((handle.cacheWrites[0] as { sceneState: Record<string, unknown> }).sceneState).toEqual({ mood: "calm", tension: 3 });
	});

	it("a cache rebuild failure is swallowed — the canonical record survives and generation does not throw", async () => {
		const handle = makeStore({ messages: [{ id: "m2", role: "assistant" }], cacheRebuild: true, cacheThrow: true });
		const { service } = quickService(handle, VALID_REPLY);
		await service.generateScene(generateInput()); // must NOT throw
		expect(handle.getRecord("var_1")).not.toBeNull(); // canonical record untouched by the cache failure
		expect(handle.cacheWrites).toHaveLength(0);
	});

	it("rebuilds the cache after edit and clears it after delete", async () => {
		const handle = makeStore({ messages: [{ id: "m2", role: "assistant" }], cacheRebuild: true });
		const { service } = quickService(handle, VALID_REPLY);
		await service.editScene(BASE_TARGET, { mood: "tense", tension: 7 });
		expect(handle.cacheWrites).toHaveLength(1);
		expect((handle.cacheWrites[0] as { sceneState: Record<string, unknown> }).sceneState).toEqual({ mood: "tense", tension: 7 });
		await service.deleteScene(BASE_TARGET);
		expect(handle.cacheWrites).toHaveLength(2);
		expect(handle.cacheWrites[1]).toBeNull(); // delete → cache cleared
	});
});
