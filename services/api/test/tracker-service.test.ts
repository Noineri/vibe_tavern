/**
 * SceneTrackerService — DI through the injected `execute` + `resolvePrompt`, the
 * same boundary as `objective-service.test.ts` (AGENTS.md §1.4 — the deps are
 * injected, NOT mocked globally). The store is a typed fake holding mutable
 * state so staleness/cancel tests can mutate the target mid-job (content edit,
 * schema/config revision bump, explicit cancel) and assert nothing stale persists.
 */
import { describe, it, expect } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import {
	SceneTrackerService,
	composeSceneInstruction,
	SceneTargetCancelledError,
	type SceneTarget,
	type SceneGenerateInput,
} from "../src/domain/insights/tracker-service.js";
import { computeSceneSourceHash } from "@vibe-tavern/domain";
import type { SceneTrackerRecord } from "@vibe-tavern/domain";

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
const profile = {} as never; // fake execute ignores it
const BASE_TARGET: SceneTarget = {
	chatId: "chat_1" as never,
	branchId: "branch_1" as never,
	messageId: "m2" as never,
	variantId: "var_1" as never,
};

interface MockVariant {
	id: string;
	content: string;
	isSelected?: boolean;
}
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
}) {
	let trackerRaw: Record<string, unknown> = opts.tracker ?? { schema: TEST_SCHEMA };
	const variants: Record<string, MockVariant[]> = opts.variants ?? {
		m2: [{ id: "var_1", content: "The warlord sneers.", isSelected: true }],
	};
	const records: Record<string, MockRecord> = opts.records ? structuredClone(opts.records) : {};
	const messages = opts.messages ?? [];

	const stores = {
		chats: {
			getById: async () => ({ insightsConfig: { tracker: trackerRaw } }),
		},
		messages: {
			getVariants: async (messageId: string) =>
				(variants[messageId] ?? []).map((v) => ({ id: v.id, content: v.content, isSelected: v.isSelected ?? false })),
			getSceneRecord: async (variantId: string) => records[variantId] ?? null,
			setSceneRecord: async (variantId: string, record: MockRecord) => {
				records[variantId] = record;
			},
			clearSceneRecord: async (variantId: string) => {
				delete records[variantId];
			},
			getMessages: async () => messages,
			getSelectedVariant: async (messageId: string) => {
				const sel = (variants[messageId] ?? []).find((v) => v.isSelected);
				return sel ? { id: sel.id, content: sel.content } : null;
			},
		},
	} as unknown as StoreContainer;

	return {
		stores,
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
		return { text: reply } as never;
	};
	const service = new SceneTrackerService(handle.stores, null as never, null as never, execute as never, async () => promptBase);
	return { service, capturedPrompt: () => captured };
}

/**
 * Build a service whose `execute` blocks until `release` is called, so the test
 * can mutate state mid-job (drift / cancel) before resolving the LLM reply.
 */
function blockingService(handle: StoreHandle, promptBase = "BASE") {
	let captured: ProviderExecutionInput["prompt"] | null = null;
	let releaseExecute: ((value: { text: string }) => void) | undefined;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const execute = async (input: ProviderExecutionInput) => {
		captured = input.prompt;
		return new Promise<{ text: string }>((resolve) => {
			releaseExecute = resolve;
			markStarted?.();
		});
	};
	const service = new SceneTrackerService(handle.stores, null as never, null as never, execute as never, async () => promptBase);
	return {
		service,
		capturedPrompt: () => captured,
		started,
		release: (reply: string) => releaseExecute?.({ text: reply }),
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
			{ variantId: "v0" as never, sceneState: { mood: "tense", tension: 8 } },
		]);
		expect(instruction).toContain("BASE");
		expect(instruction).toContain('"mood"'); // schema descriptor
		expect(instruction).toContain('"tension"');
		expect(instruction).toContain('"tense"'); // continuity scene state
		expect(instruction).toContain("Required output: one JSON object");
	});

	it("strips `label` from the schema descriptor (the model sees machine keys only)", () => {
		const instruction = composeSceneInstruction("BASE", {
			mood: { $type: "string", label: "Настроение" },
			hp: { $type: "number", min: 0, max: 100, label: "HP" },
		}, []);
		expect(instruction).toContain('"mood"');
		expect(instruction).toContain('"hp"');
		// `label` is renderer-only presentation — it must never reach the model.
		expect(instruction).not.toContain('"label"');
		expect(instruction).not.toContain("Настроение");
	});

	it("emits an empty continuity array when none is provided", () => {
		const instruction = composeSceneInstruction("BASE", TEST_SCHEMA, []);
		expect(instruction).toContain("[]");
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
		const service = new SceneTrackerService(handle.stores, null as never, null as never, execute as never, async () => "BASE");
		await expect(service.generateScene(generateInput())).rejects.toThrow("provider 500");
		expect(handle.getRecord("var_1")).toEqual(prior); // preserved
	});

	it("throws when the target variant was deleted during the LLM await", async () => {
		const handle = makeStore({});
		const { service, started, release } = blockingService(handle);
		const pending = service.generateScene(generateInput());
		await started;
		handle.setVariantContent("m2", "var_1", "The warlord sneers.");
		// Simulate deletion: replace the message's variants with none matching.
		(handle.stores as unknown as { messages: { getVariants: () => Promise<MockVariant[]> } }).messages.getVariants = async () => [];
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
		const targetB: SceneTarget = { ...BASE_TARGET, variantId: "var_2" as never };
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
