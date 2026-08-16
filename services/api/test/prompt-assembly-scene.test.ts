/**
 * PromptAssemblyService Scene Tracker injection (SCENE_TRACKER_PLAN SCN-7).
 *
 * Drives the REAL PromptAssemblyService.buildPipelineContext (+ one full
 * assembleForChat for the trace) with a minimal mock store + fake resolver, so
 * resolveSceneInjection is exercised end-to-end: tracker-config resolution,
 * the active-branch query (branch/selection isolation delegated to the store),
 * the isSceneRecordCurrent freshness filter, last-N ordering, format/depth/
 * injectPrompt pass-through, and the scene_state layer landing in the assembled
 * trace. The pure serialization + no-self-injection invariants live in
 * packages/prompt-pipeline/test/scene-injection.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatId } from "@vibe-tavern/domain";
import { computeSceneSchemaHash } from "@vibe-tavern/domain";

const SCHEMA_A = { mood: { $type: "string" }, tension: { $type: "number", min: 0, max: 10 } } as const;
const HASH_A = computeSceneSchemaHash(SCHEMA_A);

interface RawTarget {
	messageId: string;
	variantId: string;
	record: {
		variantId: string;
		schemaHash: string;
		configRevision: number;
		sourceHash: string;
		sceneState: Record<string, unknown>;
		modelId: string | null;
		generatedAt: string;
	};
}

function target(index: number, over: Partial<RawTarget["record"]> = {}): RawTarget {
	return {
		messageId: `msg_${index}`,
		variantId: `var_${index}`,
		record: {
			variantId: `var_${index}`,
			schemaHash: HASH_A,
			configRevision: 0,
			sourceHash: `src_${index}`,
			sceneState: { mood: index % 2 === 0 ? "tense" : "calm", tension: index },
			modelId: "model-a",
			generatedAt: "2026-07-14T12:00:00.000Z",
			...over,
		},
	};
}

interface SceneServiceOptions {
	trackerEnabled?: boolean;
	schema?: Record<string, unknown>;
	revision?: number;
	injectLastN?: number;
	contextWindow?: number;
	injectionDepth?: number;
	promptFormat?: "json" | "xml";
	injectPrompt?: string;
	rawTargets?: RawTarget[];
	/** Captures the branchId the service queried (branch/selection isolation). */
	onHistoryQuery?: (branchId: string, scanLimit: number) => void;
}

function makeSceneService(options: SceneServiceOptions = {}) {
	const {
		trackerEnabled = true,
		schema = SCHEMA_A,
		revision = 0,
		injectLastN = 1,
		contextWindow = 6,
		injectionDepth = 1,
		promptFormat = "json",
		injectPrompt = "",
		rawTargets = [],
		onHistoryQuery,
	} = options;

	const stores = {
		chats: {
			getById: async () => ({
				id: "chat_1",
				characterId: "char_1",
				personaId: null,
				promptPresetId: null,
				activeBranchId: "branch_1",
				title: "T",
				summary: null,
				messageHistoryLimit: 0,
				insightsConfig: { trackerEnabled, tracker: { schema, revision, injectLastN, contextWindow, injectionDepth, promptFormat, injectPrompt } },
				insightsObjectiveState: {},
				createdAt: "2025-01-01T00:00:00Z",
				updatedAt: "2025-01-01T00:00:00Z",
			}),
			getBranches: async () => [{ id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" }],
			getMessages: async () => [],
		},
		messages: {
			getMessages: async () => [],
			getSelectedSceneHistory: async (branchId: string, scanLimit: number) => {
				onHistoryQuery?.(branchId, scanLimit);
				return rawTargets;
			},
		},
		personas: { listAll: async () => [] },
		presets: { listAll: async () => [] },
		chatSummaries: { listByChatBranch: async () => [] },
		characterAssets: { listByCharacter: async () => [] },
		diceRolls: { getRollsForMessages: async () => new Map() },
		experiences: { getAttachmentsForMessages: async () => new Map() },
	} as unknown as StoreContainer;

	const resolver: PromptAssemblyResolver = {
		getCharacter: async () => ({
			id: "char_1",
			name: "Aria",
			description: "A fire mage.",
			personality: "Bold.",
		}),
		getPersona: async () => null,
		getPromptPreset: async () => null,
		listActiveLoreEntries: async () => [],
		listRetrievedMemories: async () => [],
		executeScripts: async () => ({ personality: "Bold.", scenario: null, injectedMessages: [], errors: [], scriptRuns: [] }),
		getToolInstructions: () => null,
	};

	const fileStore = {
		dataRoot: "/mock",
		resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
		readJson: async <T>() => null as T,
		writeJson: async () => {},
		asyncWriteJson: async () => {},
	};

	return new PromptAssemblyService(stores, resolver, fileStore);
}

describe("PromptAssemblyService.resolveSceneInjection (SCN-7)", () => {
	it("injects the last injectLastN valid records in conversation order (oldest→newest)", async () => {
		// Store returns newest-first [t3, t2, t1]; injectLastN=2 → take [t3, t2], reverse → [t2, t3].
		const service = makeSceneService({
			injectLastN: 2,
			rawTargets: [target(3), target(2), target(1)],
		});
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.sceneState).not.toBeNull();
		const entries = built.context.sceneState!.entries;
		expect(entries).toHaveLength(2);
		expect((entries[0] as { tension: number }).tension).toBe(2); // older first
		expect((entries[1] as { tension: number }).tension).toBe(3); // newer last
	});

	it("queries the ACTIVE branch only (branch/selection isolation delegated to the store)", async () => {
		let queriedBranch = "";
		let queriedLimit = 0;
		const service = makeSceneService({
			contextWindow: 5,
			rawTargets: [target(1)],
			onHistoryQuery: (b, l) => { queriedBranch = b; queriedLimit = l; },
		});
		await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(queriedBranch).toBe("branch_1"); // the chat's activeBranchId
		expect(queriedLimit).toBe(5); // contextWindow bounds the scan
	});

	it("excludes schema-mismatched (stale) records", async () => {
		const service = makeSceneService({
			injectLastN: 2,
			rawTargets: [target(1, { schemaHash: "wrong-hash" }), target(2)], // t1 stale, t2 fresh
		});
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.sceneState!.entries).toHaveLength(1); // only the fresh one
		expect((built.context.sceneState!.entries[0] as { tension: number }).tension).toBe(2);
	});

	it("INCLUDES same-schema records regardless of config revision (revision is trace, not a gate)", async () => {
		const service = makeSceneService({
			revision: 3, // config at revision 3
			injectLastN: 2,
			rawTargets: [target(1, { configRevision: 0 }), target(2, { configRevision: 3 })], // both share the live schemaHash
		});
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		// Both records share the live schemaHash → both injected (revision no longer filters).
		expect(built.context.sceneState!.entries).toHaveLength(2);
		const tensions = (built.context.sceneState!.entries as { tension: number }[]).map((e) => e.tension).sort();
		expect(tensions).toEqual([1, 2]);
	});

	it("passes format / depth / injectPrompt through from config", async () => {
		const service = makeSceneService({
			promptFormat: "xml",
			injectionDepth: 4,
			injectPrompt: "Track the evolving scene.",
			rawTargets: [target(1)],
		});
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.sceneState!.format).toBe("xml");
		expect(built.context.sceneState!.injectionDepth).toBe(4);
		expect(built.context.sceneState!.injectPrompt).toBe("Track the evolving scene.");
	});

	it("returns null when the tracker is disabled", async () => {
		const service = makeSceneService({ trackerEnabled: false, rawTargets: [target(1)] });
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.sceneState).toBeNull();
	});

	it("returns null when injectLastN is 0", async () => {
		const service = makeSceneService({ injectLastN: 0, rawTargets: [target(1)] });
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.sceneState).toBeNull();
	});

	it("returns null when no records are in-window (nothing valid to inject)", async () => {
		const service = makeSceneService({ rawTargets: [] });
		const built = await service.buildPipelineContext({ chatId: "chat_1" as ChatId, model: "m" });
		expect(built.context.sceneState).toBeNull();
	});
});

describe("PromptAssemblyService.assembleForChat — scene_state trace (SCN-7)", () => {
	it("emits the scene_state layer in the assembled prompt at priority 175", async () => {
		const service = makeSceneService({ injectLastN: 1, rawTargets: [target(1)] });
		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		const layer = result.prompt.layers.find((l) => l.id === "scene_state");
		expect(layer, "scene_state layer must emit when a valid record is in-window").toBeDefined();
		expect(layer!.priority).toBe(175);
		expect(layer!.position).toBe("in_chat");
		expect(layer!.text).toContain("[Scene state]");
	});

	it("does NOT emit scene_state when nothing valid is in-window", async () => {
		const service = makeSceneService({ rawTargets: [] });
		const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "m" });
		expect(result.prompt.layers.find((l) => l.id === "scene_state")).toBeUndefined();
	});
});
