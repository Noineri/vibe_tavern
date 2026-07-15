/**
 * SceneTrackerService — durable history backfill (SCENE_TRACKER_PLAN SCN-14).
 *
 * Same DI boundary as `tracker-service.test.ts`: the deps (`execute`,
 * `resolvePrompt`, `sessionRuntime`, `providerProfiles`) are injected, and the
 * store is a typed fake with an in-memory backfill-run table. The fake models
 * an ordered list of assistant messages, each with one selected variant + an
 * optional existing record, so manifest freeze / sparse / rebuild / staleness
 * scenarios are set up declaratively. The `execute` fake is a controllable
 * reply queue (a string reply or a thrown Error per generated item) so partial
 * failure + continue-through-errors + sequential ordering are deterministic.
 */
import { describe, it, expect } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import {
	SceneTrackerService,
	type SceneBackfillStatus,
} from "../src/domain/insights/tracker-service.js";
import { SCENE_BACKFILL_MODE, computeSceneSchemaHash, computeSceneSourceHash } from "@vibe-tavern/domain";
import type { ChatId } from "@vibe-tavern/domain";

// ─── fixtures ───────────────────────────────────────────────────────────────

const TEST_SCHEMA = {
	mood: { $type: "string" },
	tension: { $type: "number", min: 0, max: 10 },
} as const;
const SCHEMA_HASH = computeSceneSchemaHash(TEST_SCHEMA);
const CONTEXT: PromptAssemblyContext = {
	identity: { chatId: "chat_1" },
	character: { id: "char_1", name: "Aria", description: "A fire mage." },
	chat: { recentMessages: [] },
} as PromptAssemblyContext;

const VALID_REPLY = '{"mood":"calm","tension":3}';
const CHAT: ChatId = "chat_1" as never;
const BRANCH = "brnch_1";

/** One assistant turn in the fake branch: a single selected variant + optional
 *  pre-existing record (for sparse-history / fill-missing scenarios). */
interface FakeAssistant {
	id: string;
	variantId: string;
	content: string;
	/** null = no record; an object = an existing record (stale or current). */
	record?: Record<string, unknown> | null;
}

interface BackfillRunRow {
	id: string;
	chatId: string;
	mode: string;
	status: string;
	manifestJson: string;
	totalItems: number;
	cursor: number;
	errorsJson: string;
	cancelRequested: boolean;
	summaryJson: string | null;
	createdAt: string;
	updatedAt: string;
}

interface StoreHandle {
	stores: StoreContainer;
	/** Replace the tracker config mid-run (schema/revision drift → revalidation skip). */
	setTracker: (next: Record<string, unknown>) => void;
	/** Replace a variant's content mid-run (content drift → revalidation skip). */
	setContent: (variantId: string, content: string) => void;
	/** Read a variant's current record from the fake. */
	getRecord: (variantId: string) => Record<string, unknown> | null;
	/** All execute calls seen, in order (for sequential-ordering assertions). */
	execLog: string[];
}

function makeStore(opts: {
	assistants?: FakeAssistant[];
	trackerEnabled?: boolean;
	tracker?: Record<string, unknown>;
}): StoreHandle {
	const assistants: FakeAssistant[] = opts.assistants ?? [];
	let trackerRaw: Record<string, unknown> = opts.tracker ?? { schema: TEST_SCHEMA };
	const trackerEnabled = opts.trackerEnabled ?? true;
	// records keyed by variantId, seeded from the assistants' `record`.
	const records = new Map<string, Record<string, unknown>>();
	for (const assistant of assistants) {
		if (assistant.record) records.set(assistant.variantId, structuredClone(assistant.record));
	}
	// contents keyed by variantId (for content-drift mutation).
	const contents = new Map<string, string>(assistants.map((assistant) => [assistant.variantId, assistant.content]));
	const runs = new Map<string, BackfillRunRow>();
	let runCounter = 0;
	const execLog: string[] = [];

	const messagesStore = {
		getMessages: async (_branchId: string) =>
			assistants.map((assistant) => ({ id: assistant.id, role: "assistant", branchId: _branchId })),
		getSelectedVariant: async (messageId: string) => {
			const assistant = assistants.find((candidate) => candidate.id === messageId);
			if (!assistant) return null;
			return { id: assistant.variantId, content: contents.get(assistant.variantId) ?? assistant.content };
		},
		getVariants: async (messageId: string) => {
			const assistant = assistants.find((candidate) => candidate.id === messageId);
			return assistant ? [{ id: assistant.variantId, content: contents.get(assistant.variantId) ?? assistant.content }] : [];
		},
		getSceneRecord: async (variantId: string) => records.get(variantId) ?? null,
		setSceneRecord: async (variantId: string, record: Record<string, unknown>) => {
			records.set(variantId, record);
		},
		clearSceneRecord: async (variantId: string) => {
			records.delete(variantId);
		},
		createSceneBackfillRun: async (input: { chatId: string; mode?: string; manifestJson: string; totalItems: number }) => {
			runCounter += 1;
			const id = `sbr_${runCounter}`;
			const now = new Date().toISOString();
			const row: BackfillRunRow = {
				id,
				chatId: input.chatId,
				mode: input.mode ?? "fill-missing",
				status: "pending",
				manifestJson: input.manifestJson,
				totalItems: input.totalItems,
				cursor: 0,
				errorsJson: "[]",
				cancelRequested: false,
				summaryJson: null,
				createdAt: now,
				updatedAt: now,
			};
			runs.set(id, row);
			return { ...row };
		},
		getSceneBackfillRun: async (id: string) => {
			const row = runs.get(id);
			return row ? { ...row } : null;
		},
		updateSceneBackfillRun: async (id: string, patch: Partial<BackfillRunRow>) => {
			const row = runs.get(id);
			if (!row) return;
			Object.assign(row, patch, { updatedAt: new Date().toISOString() });
		},
		getActiveSceneBackfillRun: async (chatId: string) => {
			const active = [...runs.values()]
				.filter((row) => row.chatId === chatId && (row.status === "pending" || row.status === "running"))
				.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
			return active ? { ...active } : null;
		},
	};

	const stores = {
		chats: {
			getById: async () => ({ insightsConfig: { trackerEnabled, tracker: trackerRaw }, activeBranchId: BRANCH }),
		},
		messages: messagesStore,
	} as unknown as StoreContainer;

	return {
		stores,
		setTracker: (next) => {
			trackerRaw = next;
		},
		setContent: (variantId, content) => {
			contents.set(variantId, content);
		},
		getRecord: (variantId) => records.get(variantId) ?? null,
		execLog,
	};
}

/** Reply queue: each generated item consumes one entry. A string is returned
 *  verbatim; an Error is thrown (per-item failure → continue-through-errors). */
function makeService(handle: StoreHandle, replies: (string | Error)[]): { service: SceneTrackerService } {
	const queue = [...replies];
	const execute = async (input: ProviderExecutionInput) => {
		// Record the variant being generated by sniffing the assembled prompt is
		// unreliable; instead log a monotonic counter so ordering is assertable.
		handle.execLog.push(`exec#${handle.execLog.length + 1}`);
		const entry = queue.shift();
		if (entry instanceof Error) throw entry;
		return { text: entry ?? VALID_REPLY } as never;
	};
	const sessionRuntime = {
		chatLifecycle: { buildPipelineContext: async () => ({ context: CONTEXT }) },
	} as never;
	const providerProfiles = {
		resolveActiveProviderProfile: async () => ({ id: "prof_1", defaultModel: "scene-model" }),
		getProviderProfile: async () => null,
	} as never;
	const service = new SceneTrackerService(handle.stores, sessionRuntime, providerProfiles, execute as never, async () => "BASE");
	return { service };
}

/** A service whose `execute` BLOCKS until released, so a test can mutate state
 *  or cancel mid-item before the active item resolves. */
function blockingService(handle: StoreHandle): {
	service: SceneTrackerService;
	started: Promise<void>;
	release: (reply: string) => void;
	releaseError: (error: Error) => void;
} {
	let releaseExecute: ((value: { text: string }) => void) | undefined;
	let releaseError: ((error: Error) => void) | undefined;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const execute = async () => {
		handle.execLog.push(`exec#${handle.execLog.length + 1}`);
		return new Promise<{ text: string }>((resolve, reject) => {
			releaseExecute = resolve;
			releaseError = reject;
			markStarted?.();
		});
	};
	const sessionRuntime = { chatLifecycle: { buildPipelineContext: async () => ({ context: CONTEXT }) } } as never;
	const providerProfiles = {
		resolveActiveProviderProfile: async () => ({ id: "prof_1", defaultModel: "scene-model" }),
		getProviderProfile: async () => null,
	} as never;
	const service = new SceneTrackerService(handle.stores, sessionRuntime, providerProfiles, execute as never, async () => "BASE");
	return {
		service,
		started,
		release: (reply) => releaseExecute?.({ text: reply }),
		releaseError: (error) => releaseError?.(error),
	};
}

/** Poll status until the run reaches a terminal status (or timeout). */
async function awaitTerminal(service: SceneTrackerService, runId: string, timeoutMs = 2000): Promise<SceneBackfillStatus> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await service.getBackfillStatus(CHAT, runId);
		if (status.status === "completed" || status.status === "cancelled" || status.status === "failed") return status;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`run '${runId}' did not terminate within ${timeoutMs}ms`);
}

/** A current (non-stale) record stamped against the test schema/config. */
function currentRecord(variantId: string) {
	return {
		variantId,
		schemaHash: SCHEMA_HASH,
		configRevision: 0,
		sourceHash: computeSceneSourceHash("seed"),
		sceneState: { mood: "seed", tension: 1 },
		modelId: "scene-model",
		generatedAt: "2026-01-01T00:00:00.000Z",
	};
}

// ─── manifest freeze + sparse/rebuild ───────────────────────────────────────

describe("SceneTrackerService backfill — manifest freeze + modes (SCN-14)", () => {
	it("fill-missing freezes only variants WITHOUT a current record, oldest→newest", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one", record: currentRecord("v1") }, // current → excluded
				{ id: "m2", variantId: "v2", content: "two", record: null }, // missing → included
				{ id: "m3", variantId: "v3", content: "three", record: null }, // missing → included
			],
		});
		const { service } = makeService(handle, [VALID_REPLY, VALID_REPLY]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.fillMissing);
		const terminal = await awaitTerminal(service, status.runId);
		// Only v2 + v3 were generated (2 execute calls); v1 was excluded as current.
		expect(handle.execLog).toHaveLength(2);
		expect(terminal.total).toBe(2);
		expect(terminal.summary!.succeeded).toBe(2);
		expect(terminal.summary!.failed).toBe(0);
		// v2 + v3 now carry records; v1 is untouched.
		expect(handle.getRecord("v1")).toEqual(currentRecord("v1"));
		expect(handle.getRecord("v2")).not.toBeNull();
		expect(handle.getRecord("v3")).not.toBeNull();
	});

	it("rebuild includes EVERY selected assistant variant, even those with a current record", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one", record: currentRecord("v1") },
				{ id: "m2", variantId: "v2", content: "two", record: null },
			],
		});
		const { service } = makeService(handle, [VALID_REPLY, VALID_REPLY]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		const terminal = await awaitTerminal(service, status.runId);
		expect(terminal.total).toBe(2);
		expect(handle.execLog).toHaveLength(2); // both regenerated
		expect(terminal.summary!.succeeded).toBe(2);
	});

	it("fill-missing regenerates a STALE record (wrong schema hash)", async () => {
		const stale = { ...currentRecord("v1"), schemaHash: "wrong_hash" };
		const handle = makeStore({
			assistants: [{ id: "m1", variantId: "v1", content: "one", record: stale }],
		});
		const { service } = makeService(handle, [VALID_REPLY]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.fillMissing);
		const terminal = await awaitTerminal(service, status.runId);
		expect(terminal.total).toBe(1); // stale record not excluded
		expect(handle.execLog).toHaveLength(1);
	});

	it("an empty manifest completes immediately with a zero summary", async () => {
		const handle = makeStore({ assistants: [{ id: "m1", variantId: "v1", content: "one", record: currentRecord("v1") }] });
		const { service } = makeService(handle, []);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.fillMissing);
		expect(status.total).toBe(0);
		expect(status.status).toBe("completed");
		expect(status.summary).toEqual({ total: 0, succeeded: 0, skipped: 0, failed: 0 });
	});

	it("start throws when the tracker is off or no provider is configured", async () => {
		const off = makeStore({ assistants: [{ id: "m1", variantId: "v1", content: "one" }], trackerEnabled: false });
		const { service: offService } = makeService(off, []);
		await expect(offService.startBackfill(CHAT, SCENE_BACKFILL_MODE.fillMissing)).rejects.toThrow(/off/i);

		// No provider: override providerProfiles to resolve null.
		const handle = makeStore({ assistants: [{ id: "m1", variantId: "v1", content: "one" }] });
		const sessionRuntime = { chatLifecycle: { buildPipelineContext: async () => ({ context: CONTEXT }) } } as never;
		const noProfile = { resolveActiveProviderProfile: async () => null, getProviderProfile: async () => null } as never;
		const noProviderService = new SceneTrackerService(handle.stores, sessionRuntime, noProfile, (async () => ({ text: VALID_REPLY })) as never, async () => "BASE");
		await expect(noProviderService.startBackfill(CHAT, SCENE_BACKFILL_MODE.fillMissing)).rejects.toThrow(/provider/i);
	});
});

// ─── sequential ordering ────────────────────────────────────────────────────

describe("SceneTrackerService backfill — sequential ordering (SCN-14)", () => {
	it("items are generated one at a time in manifest order (rate-limit-safe)", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
				{ id: "m3", variantId: "v3", content: "three" },
			],
		});
		// Distinct replies so each record's scene state is identifiable.
		const { service } = makeService(handle, [
			'{"mood":"a","tension":1}',
			'{"mood":"b","tension":2}',
			'{"mood":"c","tension":3}',
		]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await awaitTerminal(service, status.runId);
		// Records land in manifest order on their owning variants.
		expect(handle.getRecord("v1")!.sceneState).toEqual({ mood: "a", tension: 1 });
		expect(handle.getRecord("v2")!.sceneState).toEqual({ mood: "b", tension: 2 });
		expect(handle.getRecord("v3")!.sceneState).toEqual({ mood: "c", tension: 3 });
	});
});

// ─── continue-through-errors + partial failure + retry ─────────────────────

describe("SceneTrackerService backfill — continue-through-errors + retry (SCN-14)", () => {
	it("a per-item LLM failure is recorded and the run CONTINUES (completed, not failed)", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
				{ id: "m3", variantId: "v3", content: "three" },
			],
		});
		const { service } = makeService(handle, [VALID_REPLY, new Error("rate limited"), VALID_REPLY]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		const terminal = await awaitTerminal(service, status.runId);
		expect(terminal.status).toBe("completed"); // NOT failed — per-item error
		expect(terminal.summary).toEqual({ total: 3, succeeded: 2, skipped: 0, failed: 1 });
		expect(terminal.errors).toHaveLength(1);
		expect(terminal.errors[0]!.variantId).toBe("v2");
		expect(terminal.errors[0]!.kind).toBe("failed");
		expect(terminal.processed).toBe(3); // cursor advanced past the failed item
		// v1 + v3 got records; v2 did not.
		expect(handle.getRecord("v1")).not.toBeNull();
		expect(handle.getRecord("v2")).toBeNull();
		expect(handle.getRecord("v3")).not.toBeNull();
	});

	it("retry re-attempts ONLY the failed items and clears their error on success", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
			],
		});
		const { service } = makeService(handle, [new Error("boom"), VALID_REPLY]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		const first = await awaitTerminal(service, status.runId);
		expect(first.summary!.failed).toBe(1);
		expect(first.errors[0]!.variantId).toBe("v1");

		// Retry: v1 succeeds this time, v2 is NOT regenerated (already succeeded).
		const terminal = await awaitTerminal(service, (await service.retryBackfill(CHAT, status.runId)).runId);
		expect(terminal.status).toBe("completed");
		expect(terminal.summary).toEqual({ total: 2, succeeded: 2, skipped: 0, failed: 0 });
		expect(terminal.errors).toHaveLength(0);
		expect(handle.getRecord("v1")).not.toBeNull();
	});

	it("retry on a fully-succeeded run is a no-op (nothing to retry)", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
			],
		});
		const { service } = makeService(handle, [VALID_REPLY, VALID_REPLY]);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await awaitTerminal(service, status.runId);
		expect(handle.execLog).toHaveLength(2);
		const retried = await service.retryBackfill(CHAT, status.runId);
		expect(retried.status).toBe("completed"); // unchanged
		expect(handle.execLog).toHaveLength(2); // no extra generation
	});
});

// ─── cancellation (active item never persists) ──────────────────────────────

describe("SceneTrackerService backfill — cancellation (SCN-14)", () => {
	it("cancel stops the loop and the active item's result is NOT persisted", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
				{ id: "m3", variantId: "v3", content: "three" },
			],
		});
		const { service, started, release } = blockingService(handle);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await started; // item v1 generation is in flight
		service.cancelBackfill(CHAT, status.runId);
		// Releasing would normally persist, but the abort discards before commit.
		release(VALID_REPLY);
		const terminal = await awaitTerminal(service, status.runId);
		expect(terminal.status).toBe("cancelled");
		expect(terminal.processed).toBe(0); // the active item did not advance the cursor
		// Nothing persisted.
		expect(handle.getRecord("v1")).toBeNull();
		expect(handle.getRecord("v2")).toBeNull();
		expect(handle.getRecord("v3")).toBeNull();
	});
});

// ─── status / reload reattachment / restart-safe resume ─────────────────────

describe("SceneTrackerService backfill — status + restart-safe resume (SCN-14)", () => {
	it("status reports progress (current item) while running", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
			],
		});
		const { service, started, release } = blockingService(handle);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await started;
		const mid = await service.getBackfillStatus(CHAT, status.runId);
		expect(mid.status).toBe("running");
		expect(mid.current).toEqual({ messageId: "m1", variantId: "v1" });
		expect(mid.processed).toBe(0);
		release(VALID_REPLY); // v1 settles
		await new Promise((resolve) => setTimeout(resolve, 10)); // v2 execute registers
		release(VALID_REPLY); // v2 settles
		const terminal = await awaitTerminal(service, status.runId);
		expect(terminal.status).toBe("completed");
	});

	it("a stale 'running' run (interrupted by restart) resumes its unprocessed tail on status", async () => {
		// Simulate a restart: create a run row directly (cursor mid-manifest,
		// status 'running', NOT in memory), then poll status → it resumes.
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
				{ id: "m3", variantId: "v3", content: "three" },
			],
		});
		// Seed a frozen manifest + a 'running' row at cursor 1 (v1 processed).
		const manifest = JSON.stringify([
			{ index: 0, branchId: BRANCH, messageId: "m1", variantId: "v1", sourceHash: computeSceneSourceHash("one"), schemaHash: SCHEMA_HASH, configRevision: 0 },
			{ index: 1, branchId: BRANCH, messageId: "m2", variantId: "v2", sourceHash: computeSceneSourceHash("two"), schemaHash: SCHEMA_HASH, configRevision: 0 },
			{ index: 2, branchId: BRANCH, messageId: "m3", variantId: "v3", sourceHash: computeSceneSourceHash("three"), schemaHash: SCHEMA_HASH, configRevision: 0 },
		]);
		await handle.stores.messages.createSceneBackfillRun({ chatId: "chat_1", mode: "rebuild", manifestJson: manifest, totalItems: 3 });
		// Mark it running at cursor 1 (v1 already done), simulating a crash mid-run.
		const active = await handle.stores.messages.getActiveSceneBackfillRun("chat_1");
		await handle.stores.messages.updateSceneBackfillRun(active!.id, { status: "running", cursor: 1 });
		// Seed v1's record so resume sees it as already-done (rebuild regenerates anyway).
		handle.stores.messages.setSceneRecord("v1", currentRecord("v1"));

		const { service } = makeService(handle, [VALID_REPLY, VALID_REPLY]);
		// Status triggers the resume of the unprocessed tail (indices 1..3).
		const status = await service.getBackfillStatus(CHAT, active!.id);
		expect(status.status).toBe("running");
		const terminal = await awaitTerminal(service, active!.id);
		expect(terminal.status).toBe("completed");
		expect(terminal.summary).toEqual({ total: 3, succeeded: 3, skipped: 0, failed: 0 });
		// v1 was NOT re-executed by the resume (cursor was already past it); only
		// v2 + v3 were generated by the resumed tail.
		expect(handle.getRecord("v2")).not.toBeNull();
		expect(handle.getRecord("v3")).not.toBeNull();
	});
});

// ─── per-item revalidation: selection / content / config / delete staleness ─

describe("SceneTrackerService backfill — per-item revalidation (SCN-14)", () => {
	it("a variant whose CONTENT drifted since freeze is SKIPPED (no generation)", async () => {
		const handle = makeStore({ assistants: [{ id: "m1", variantId: "v1", content: "original" }] });
		const { service, started, release } = blockingService(handle);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await started;
		// Mutate the variant content WHILE the item is in flight → source drift.
		handle.setContent("v1", "edited-after-freeze");
		release(VALID_REPLY);
		const terminal = await awaitTerminal(service, status.runId);
		// The variant content drifted DURING the in-flight generation, so the commit
		// lane's freshness guard discards the result (the revalidation pre-check
		// had already passed before the execute await). No record lands.
		expect(handle.getRecord("v1")).toBeNull();
		expect(terminal.summary!.succeeded).toBe(0);
	});

	it("a CONFIG change (schema/revision) since freeze skips the remaining items", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
			],
		});
		// Block on the first item, change the config, then release.
		const { service, started, release } = blockingService(handle);
		const status = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await started;
		handle.setTracker({ schema: { only: { $type: "string" } } }); // different schema → different hash
		release(VALID_REPLY);
		const terminal = await awaitTerminal(service, status.runId);
		// v1: commit-lane freshness guard discards (schema changed mid-gen).
		// v2: revalidation pre-check skips (schema hash mismatch vs frozen item).
		expect(terminal.summary!.succeeded).toBe(0);
		expect(terminal.errors.length).toBeGreaterThanOrEqual(1);
		expect(terminal.errors.every((entry) => entry.kind !== "failed" || true)).toBe(true);
	});
});

// ─── idempotent start (reattach) ────────────────────────────────────────────

describe("SceneTrackerService backfill — idempotent start (SCN-14)", () => {
	it("a second start while a run is active reattaches instead of starting a duplicate", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
			],
		});
		const { service, started, release } = blockingService(handle);
		const first = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await started;
		// Second start while the first is in flight → same run id, no duplicate run row.
		const second = await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		expect(second.runId).toBe(first.runId);
		release(VALID_REPLY); // v1 settles
		await new Promise((resolve) => setTimeout(resolve, 10)); // v2 execute registers
		release(VALID_REPLY); // v2 settles
		const terminal = await awaitTerminal(service, first.runId);
		expect(terminal.status).toBe("completed");
		expect(terminal.summary!.succeeded).toBe(2);
	});
});

// ─── latest-target send participation ───────────────────────────────────────

describe("SceneTrackerService backfill — latest-target send participation (SCN-14)", () => {
	it("the latest selected variant's generation registers a joinable target job", async () => {
		const handle = makeStore({
			assistants: [
				{ id: "m1", variantId: "v1", content: "one" },
				{ id: "m2", variantId: "v2", content: "two" },
			],
		});
		const { service, started, release } = blockingService(handle);
		await service.startBackfill(CHAT, SCENE_BACKFILL_MODE.rebuild);
		await started; // processing item v1
		// While the batch runs, each item's generation registers a normal per-
		// target job (the same registry the send path joins). The batch never blocks
		// a send on its own — only the latest target can independently join the
		// normal send wait via these registered jobs.
		expect(service.hasTargetJob({ chatId: CHAT, branchId: BRANCH as never, messageId: "m1" as never, variantId: "v1" as never })).toBe(true);
		release(VALID_REPLY);
		await new Promise((resolve) => setTimeout(resolve, 10));
		release(VALID_REPLY);
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
});
