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
import type { StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { SceneTrackerService, type SceneTarget } from "../src/domain/insights/tracker-service.js";
import { computeSceneSchemaHash } from "@vibe-tavern/domain";

const CTX = {
	identity: { chatId: "chat_1" },
	character: { id: "char_1", name: "Aria", description: "A fire mage." },
	chat: { recentMessages: [{ id: "m1", role: "user", content: "hi" }, { id: "m2", role: "assistant", content: "hello" }] },
} as PromptAssemblyContext;

const SCHEMA = { mood: { $type: "string" } } as const;
const SCHEMA_HASH = computeSceneSchemaHash(SCHEMA);
const TARGET: SceneTarget = { chatId: "chat_1" as never, branchId: "branch_1" as never, messageId: "m2" as never, variantId: "var_1" as never };
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
	const records: Record<string, { variantId: string; schemaHash: string; configRevision: number; sourceHash: string; sceneState: Record<string, unknown>; modelId: string | null; generatedAt: string }> = {};

	const stores = {
		chats: {
			getById: async () => ({ id: "chat_1", activeBranchId: "branch_1", insightsConfig: { trackerEnabled, tracker: { schema: SCHEMA, revision: 0 } } }),
		},
		messages: {
			getMessages: async () => [{ id: "m1", role: "user" }, { id: "m2", role: "assistant" }],
			getVariants: async () => [{ id: "var_1", content: "hello", isSelected: true }],
			getSelectedVariant: async () => ({ id: latest?.variantId ?? "var_1", content: "hello" }),
			getLatestSelectedVariant: async () => latest ? { messageId: latest.messageId, variantId: latest.variantId } : null,
			getSceneRecord: async (variantId: string) => records[variantId] ?? null,
			setSceneRecord: async (variantId: string, record: typeof records[string]) => { records[variantId] = record; },
			clearSceneRecord: async (variantId: string) => { delete records[variantId]; },
		},
	} as unknown as StoreContainer;

	const sessionRuntime = { chatLifecycle: { buildPipelineContext: async () => ({ context: CTX }) } } as never;
	const providerProfiles = { resolveActiveProviderProfile: async () => ({ id: "prof", defaultModel: "scene-model" }) } as never;

	let releaseExecute: ((value: { text: string }) => void) | undefined;
	let rejectExecute: ((err: unknown) => void) | undefined;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const execute = async (_input: ProviderExecutionInput) => new Promise<{ text: string }>((resolve, reject) => {
		releaseExecute = resolve;
		rejectExecute = reject;
		markStarted?.();
	});

	const service = new SceneTrackerService(stores, sessionRuntime, providerProfiles, execute as never, async () => "BASE");

	return {
		service,
		started,
		release: (reply: string) => releaseExecute?.({ text: reply }),
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
		const wait = h.service.waitForForwardState("chat_1" as never);
		await flush();
		h.release(VALID_REPLY);
		await expect(wait).resolves.toBeUndefined(); // waited for the shared job
		expect(h.hasRecord()).toBe(true);
	});

	it("waitForForwardState STARTS a missing/stale job when none is active", async () => {
		const h = harness();
		const wait = h.service.waitForForwardState("chat_1" as never);
		await h.started; // the wait started a fresh job
		expect(h.service.hasTargetJob(TARGET)).toBe(true);
		h.release(VALID_REPLY);
		await expect(wait).resolves.toBeUndefined();
		expect(h.hasRecord()).toBe(true);
	});

	it("waitForForwardState returns immediately when the record is already current", async () => {
		const h = harness();
		h.setRecord(true);
		await expect(h.service.waitForForwardState("chat_1" as never)).resolves.toBeUndefined();
		expect(h.service.hasTargetJob(TARGET)).toBe(false);
	});

	it("waitForForwardState returns immediately when there is no latest assistant target", async () => {
		const h = harness({ latest: null });
		await expect(h.service.waitForForwardState("chat_1" as never)).resolves.toBeUndefined();
		expect(h.service.hasTargetJob(TARGET)).toBe(false);
	});

	it("send-wait cancellation DETACHES the waiter but the shared job keeps running and still commits", async () => {
		const h = harness();
		void h.service.triggerAutoGenerate({ chatId: "chat_1", branchId: "branch_1", messageId: "m2" });
		await h.started;
		const controller = new AbortController();
		const wait = h.service.waitForForwardState("chat_1" as never, controller.signal);
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
		const wait = h.service.waitForForwardState("chat_1" as never);
		await h.started;
		h.releaseError(new Error("llm boom"));
		await expect(wait).resolves.toBeUndefined(); // NOT rejected — failure is swallowed
		expect(h.hasRecord()).toBe(false); // nothing committed
	});
});
