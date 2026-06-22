/**
 * useActiveTrace — branch-scoped trace selection (TL-B2).
 *
 * After the lazy-loading refactor, trace history lives in a branch-scoped
 * cache (`useTraceHistoryStore`, keyed by `${chatId}::${branchId}`) rather
 * than in a `promptTraceHistory` field on the snapshot store. `useActiveTrace`
 * reads the cache entry for the active (chatId, branchId) plus the snapshot's
 * single `promptTrace` (latest) + `contextPreview`.
 *
 * The branch-scoping is now structural (cache key), not a client-side filter.
 * These tests pin the selection predicate against both stores.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatBranchId, ChatId, PromptTraceRecordDto, AssemblePromptResponse } from "@vibe-tavern/domain";
import { useSnapshotStore } from "./snapshot-store.js";
import { useTraceHistoryStore, type TraceHistoryEntry } from "./trace-history-store.js";

// `useActiveTrace` reads two stores via hooks. To exercise the pure selection
// logic without a DOM harness, we reproduce the predicate here, feeding it the
// same slices the hook reads. Keep in sync with `useActiveTrace` in
// chat-selectors.ts when editing.
function selectActiveTrace(
	snapshot: ReturnType<typeof useSnapshotStore.getState>,
	cachedTraces: PromptTraceRecordDto[],
	selectedTraceId: string | null,
): PromptTraceRecordDto | AssemblePromptResponse | null {
	const activeBranchId = snapshot.activeBranch?.id ?? null;
	const historyForBranch = cachedTraces;
	const latestForBranch =
		snapshot.promptTrace && snapshot.promptTrace.branchId === activeBranchId
			? snapshot.promptTrace
			: null;
	const fromHistory =
		historyForBranch.find((trace) => trace.id === selectedTraceId) ??
		latestForBranch ??
		historyForBranch[0];
	if (fromHistory) return fromHistory;
	if (snapshot.contextPreview) return snapshot.contextPreview;
	return null;
}

const chatId = "chat-1" as ChatId;
const branchA = "brnch-a" as ChatBranchId;
const branchB = "brnch-b" as ChatBranchId;

function makeTrace(id: string, branchId: ChatBranchId, tokenTotal: number): PromptTraceRecordDto {
	return {
		id,
		chatId,
		branchId,
		messageId: "msg-1" as never,
		createdAt: "2026-01-01T00:00:00Z",
		model: "test-model",
		presetName: "test-preset",
		latencyMs: 0,
		tokenAccounting: { total: tokenTotal } as never,
		layers: [],
		finalPayload: null as never,
		activatedLoreEntries: [],
		activatedLoreDetail: [],
		retrievedMemories: [],
		scriptInjections: [],
	} as unknown as PromptTraceRecordDto;
}

const previewA = { layers: [], tokenAccounting: { total: 50 } } as unknown as AssemblePromptResponse;
const previewB = { layers: [], tokenAccounting: { total: 10 } } as unknown as AssemblePromptResponse;

/** Seed the trace-history cache with a success entry for (chatId, branchId). */
function seedCache(branchId: ChatBranchId, traces: PromptTraceRecordDto[]): TraceHistoryEntry {
	const entry: TraceHistoryEntry = { status: "success", traces, error: null };
	useTraceHistoryStore.setState((s) => ({
		entries: { ...s.entries, [`${chatId}::${branchId}`]: entry },
	}));
	return entry;
}

describe("useActiveTrace — branch-scoped selection (lazy cache)", () => {
	beforeEach(() => {
		useSnapshotStore.getState().clearMessages();
		useSnapshotStore.setState({
			activeChat: { id: chatId } as never,
			activeBranch: { id: branchA } as never,
			promptTrace: null,
			contextPreview: null,
		});
		useTraceHistoryStore.setState({ entries: {} });
	});

	test("returns the selected trace when it is in the active branch's cached history", () => {
		const traceOnA = makeTrace("t1", branchA, 100);
		seedCache(branchA, [traceOnA]);
		useSnapshotStore.setState({ contextPreview: previewA });
		const selected = selectActiveTrace(useSnapshotStore.getState(), [traceOnA], "t1");
		expect(selected).toBe(traceOnA);
	});

	test("falls back to contextPreview when the active branch has no cached traces (post-fork)", () => {
		// After forking to branchB, the cache for branchB is empty (not yet
		// fetched). promptTrace is stale (belongs to branchA), so it must be
		// ignored. The hook falls back to branchB's fresh contextPreview.
		const traceOnA = makeTrace("t1", branchA, 6800);
		useSnapshotStore.setState({
			activeBranch: { id: branchB } as never,
			promptTrace: traceOnA,        // stale: belongs to branchA
			contextPreview: previewB,     // fresh: 10 tokens for branchB
		});
		// branchB cache is empty (the realistic post-fork state).
		const selected = selectActiveTrace(useSnapshotStore.getState(), [], null);
		expect(selected).toBe(previewB);
		expect((selected as AssemblePromptResponse).tokenAccounting.total).toBe(10);
	});

	test("ignores a stale selectedTraceId that is absent from the active branch's cache", () => {
		// selectedTraceId points at a branchA trace, but the active branchB cache
		// only holds branchB's trace → the stale id is not found, and the latest
		// branchB trace (promptTrace) wins instead.
		const traceOnB = makeTrace("t-on-b", branchB, 20);
		seedCache(branchB, [traceOnB]);
		useSnapshotStore.setState({
			activeBranch: { id: branchB } as never,
			promptTrace: traceOnB,
			contextPreview: previewB,
		});
		const selected = selectActiveTrace(useSnapshotStore.getState(), [traceOnB], "t-on-a");
		expect(selected).toBe(traceOnB);
		expect((selected as PromptTraceRecordDto).id).toBe("t-on-b");
	});

	test("returns null when no cached traces, no promptTrace, and no contextPreview", () => {
		expect(selectActiveTrace(useSnapshotStore.getState(), [], null)).toBeNull();
	});

	test("prefers the latest promptTrace when it belongs to the active branch", () => {
		const latest = makeTrace("latest", branchA, 300);
		const older = makeTrace("older", branchA, 100);
		seedCache(branchA, [older]); // cache holds an older trace
		useSnapshotStore.setState({ promptTrace: latest, contextPreview: previewA });
		// No selectedTraceId → latestForBranch (promptTrace) wins over cache[0].
		const selected = selectActiveTrace(useSnapshotStore.getState(), [older], null);
		expect(selected).toBe(latest);
	});

	test("resolves selectedTraceId from the cache even when promptTrace differs", () => {
		const latest = makeTrace("latest", branchA, 300);
		const older = makeTrace("older", branchA, 100);
		seedCache(branchA, [latest, older]);
		useSnapshotStore.setState({ promptTrace: latest, contextPreview: previewA });
		// User navigated to the older trace → it must be resolved from the cache.
		const selected = selectActiveTrace(useSnapshotStore.getState(), [latest, older], "older");
		expect(selected).toBe(older);
	});
});

// Keep mock import referenced so bun:test types resolve in colocated tests.
void mock;
