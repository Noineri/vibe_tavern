/**
 * SceneTrackerService SCN-8 coordination — auto-start + chat-level wait, driven
 * against the REAL service with a blocking injected `execute` (the same DI
 * boundary as tracker-service.test.ts). The store is a typed fake; sessionRuntime
 * + providerProfiles are minimal stubs so the auto-start's resolve/build path
 * runs without the full pipeline. Pins: a fresh variant starts a background job;
 * triggerAutoGenerate is a no-op when current / disabled; waitForForwardState
 * JOINS an active job, STARTS a missing/stale one, returns immediately when
 * current / no target; send-wait cancellation DETACHES without aborting the
 * shared job; and a generation failure resolves the wait (proceed with
 * latest-valid/none) rather than rejecting.
 */
import { describe, it, expect } from "bun:test";
import type { ChatStore, MessageStore, StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { GenerationResult, ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { SceneTrackerService, type SceneTarget } from "../src/domain/insights/tracker-service.js";
import {
	brandId,
	computeSceneSchemaHash,
	normalizeInsightsConfig,
	type ChatBranchId,
	type ChatId,
	type MessageId,
	type MessageVariantId,
} from "@vibe-tavern/domain";
import { execResult, makeChatRow, makeMessageRow, makeSessionRuntime, makeVariantRow } from "./insights-test-builders.js";
import { makeProviderProfileRow } from "./copilot-test-builders.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { strictTestDouble } from "./strict-test-double.js";

const CTX = {
	identity: { chatId: "chat_1" },
	character: { id: "char_1", name: "Aria", description: "A fire mage." },
	chat: { recentMessages: [{ id: "m1", role: "user", content: "hi" }, { id: "m2", role: "assistant", content: "hello" }] },
} as PromptAssemblyContext;

const SCHEMA = { mood: { $type: "string" } } as const;
const SCHEMA_HASH = computeSceneSchemaHash(SCHEMA);
const CHAT: ChatId = brandId<ChatId>("chat_1");
const TARGET: SceneTarget = { chatId: CHAT, branchId: brandId<ChatBranchId>("branch_1"), messageId: brandId<MessageId>("m2"), variantId: brandId<MessageVariantId>("var_1") };
const VALID_REPLY = '{"mood":"calm"}';

interface Harness {
	service: SceneTrackerService;
	started: Promise<void>;
	release: (reply: string) => void;
	releaseError: (err: unknown) => void;
	hasRecord: () => boolean;
	setRecord: (current: boolean) => void;
	setTrackerEnabled: (enabled: boolean) => void;
	setLatest: (target: { messageId: string; variantId: string } | null) => void;
}

/** Build a service whose `execute` blocks until released, signalling `started`. */
function harness(opts: { trackerEnabled?: boolean; latest?: { messageId: string; variantId: string } | null } = {}): Harness {
	let trackerEnabled = opts.trackerEnabled ?? true;
	let latest: { messageId: string; variantId: string } | null = opts.latest === undefined ? { messageId: "m2", variantId: "var_1" } : opts.latest;
	// Structurally the store's MessageVariantSceneRecord minus its OPTIONAL
	// schema/promptFormat snapshot fields (that type is not exported from the
	// @vibe-tavern/db barrel; the strictTestDouble member check still verifies
	// the record shape against the real getSceneRecord/setSceneRecord).
	const records: Record<string, { variantId: string; schemaHash: string; configRevision: number; sourceHash: string; sceneState: Record<string, unknown>; modelId: string | null; generatedAt: string }> = {};

	const stores = strictTestDouble<StoreContainer>(
		{
			chats: strictTestDouble<ChatStore>(
				{
					// The chat row completes through the standing builder; the config
					// rides the domain's persisted-column seam (raw stored json →
					// normalized InsightsConfig — the same values the old erasure
					// handed the service, plus inert defaults it never reads).
					getById: async () =>
						makeChatRow({
							id: "chat_1",
							activeBranchId: "branch_1",
							insightsConfig: normalizeInsightsConfig({ trackerEnabled, tracker: { schema: SCHEMA, revision: 0 } }),
						}),
				},
				"harness: chats (tracker-coordinator)",
			),
			messages: strictTestDouble<MessageStore>(
				{
					getMessages: async () => [makeMessageRow({ id: "m1", role: "user" }), makeMessageRow({ id: "m2", role: "assistant" })],
					getVariants: async () => [makeVariantRow()],
					getSelectedVariant: async () => makeVariantRow({ id: latest?.variantId ?? "var_1" }),
					getLatestSelectedVariant: async () => (latest ? { messageId: latest.messageId, variantId: latest.variantId } : null),
					getSceneRecord: async (variantId) => records[variantId] ?? null,
					setSceneRecord: async (variantId, record) => { records[variantId] = record; },
					clearSceneRecord: async (variantId) => { delete records[variantId]; },
				},
				"harness: messages (tracker-coordinator)",
			),
		},
		"StoreContainer (tracker-coordinator)",
	);

	const sessionRuntime = makeSessionRuntime({ chatLifecycle: { buildPipelineContext: async () => ({ context: CTX }) } });
	const providerProfiles = strictTestDouble<ProviderProfileService>(
		{
			resolveActiveProviderProfile: async () => makeProviderProfileRow({ id: "prof", defaultModel: "scene-model" }),
		},
		"harness: providerProfiles (tracker-coordinator)",
	);

	let releaseExecute: ((value: GenerationResult) => void) | undefined;
	let rejectExecute: ((err: unknown) => void) | undefined;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const execute = async (_input: ProviderExecutionInput) => new Promise<GenerationResult>((resolve, reject) => {
		releaseExecute = resolve;
		rejectExecute = reject;
		markStarted?.();
	});

	const service = new SceneTrackerService(stores, sessionRuntime, providerProfiles, execute, async () => "BASE");

	return {
		service,
		started,
		release: (reply: string) => releaseExecute?.(execResult(reply)),
		releaseError: (err: unknown) => rejectExecute?.(err),
		hasRecord: () => records["var_1"] !== undefined,
		setRecord: (current: boolean) => {
			if (current) records["var_1"] = { variantId: "var_1", schemaHash: SCHEMA_HASH, configRevision: 0, sourceHash: "stub", sceneState: { mood: "calm" }, modelId: "scene-model", generatedAt: "2026-07-14T00:00:00Z" };
			else delete records["var_1"];
		},
		setTrackerEnabled: (enabled: boolean) => { trackerEnabled = enabled; },
		setLatest: (next) => { latest = next; },
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SceneTrackerService auto-start + wait coordination (SCN-8)", () => {
	it("a fresh (record-less) variant starts a background generation that commits on success", async () => {
		const h = harness();
		void h.service.triggerAutoGenerate({ chatId: "chat_1", branchId: "branch_1", messageId: "m2" });
		await h.started;
		expect(h.service.hasTargetJob(TARGET)).toBe(true);
		h.release(VALID_REPLY);
		await flush();
		expect(h.service.hasTargetJob(TARGET)).toBe(false);
		expect(h.hasRecord()).toBe(true);
	});

	it("triggerAutoGenerate is a no-op when the record is already current", async () => {
		const h = harness();
		h.setRecord(true); // a current record exists
		await h.service.triggerAutoGenerate({ chatId: "chat_1", branchId: "branch_1", messageId: "m2" });
		await flush();
		expect(h.service.hasTargetJob(TARGET)).toBe(false); // no job started
	});

	it("triggerAutoGenerate is a no-op when the tracker is disabled", async () => {
		const h = harness({ trackerEnabled: false });
		void h.service.triggerAutoGenerate({ chatId: "chat_1", branchId: "branch_1", messageId: "m2" });
		await flush();
		expect(h.service.hasTargetJob(TARGET)).toBe(false);
	});

	it("waitForForwardState JOINS the active job (started by the event-driven auto-start)", async () => {
		const h = harness();
		void h.service.triggerAutoGenerate({ chatId: "chat_1", branchId: "branch_1", messageId: "m2" });
		await h.started;
		const wait = h.service.waitForForwardState(CHAT);
		await flush();
		h.release(VALID_REPLY);
		await expect(wait).resolves.toBeUndefined(); // waited for the shared job
		expect(h.hasRecord()).toBe(true);
	});

	it("waitForForwardState STARTS a missing/stale job when none is active", async () => {
		const h = harness();
		const wait = h.service.waitForForwardState(CHAT);
		await h.started; // the wait started a fresh job
		expect(h.service.hasTargetJob(TARGET)).toBe(true);
		h.release(VALID_REPLY);
		await expect(wait).resolves.toBeUndefined();
		expect(h.hasRecord()).toBe(true);
	});

	it("waitForForwardState returns immediately when the record is already current", async () => {
		const h = harness();
		h.setRecord(true);
		await expect(h.service.waitForForwardState(CHAT)).resolves.toBeUndefined();
		expect(h.service.hasTargetJob(TARGET)).toBe(false);
	});

	it("waitForForwardState returns immediately when there is no latest assistant target", async () => {
		const h = harness({ latest: null });
		await expect(h.service.waitForForwardState(CHAT)).resolves.toBeUndefined();
		expect(h.service.hasTargetJob(TARGET)).toBe(false);
	});

	it("send-wait cancellation DETACHES the waiter but the shared job keeps running and still commits", async () => {
		const h = harness();
		void h.service.triggerAutoGenerate({ chatId: "chat_1", branchId: "branch_1", messageId: "m2" });
		await h.started;
		const controller = new AbortController();
		const wait = h.service.waitForForwardState(CHAT, controller.signal);
		controller.abort(new Error("user cancelled send"));
		await expect(wait).rejects.toThrow("user cancelled send");
		// The job is NOT cancelled by the waiter's abort — it is still active...
		expect(h.service.hasTargetJob(TARGET)).toBe(true);
		// ...and still commits when the LLM reply lands.
		h.release(VALID_REPLY);
		await flush();
		expect(h.hasRecord()).toBe(true);
	});

	it("a generation failure resolves the wait (proceed with latest-valid/none) and commits nothing", async () => {
		const h = harness();
		const wait = h.service.waitForForwardState(CHAT);
		await h.started;
		h.releaseError(new Error("llm boom"));
		await expect(wait).resolves.toBeUndefined(); // NOT rejected — failure is swallowed
		expect(h.hasRecord()).toBe(false); // nothing committed
	});
});
