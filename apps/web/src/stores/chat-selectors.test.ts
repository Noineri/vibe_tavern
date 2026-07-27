/**
 * useActiveTrace — branch-scoped trace selection.
 *
 * Trace history lives in a branch-scoped cache (`useTraceHistoryStore`,
 * keyed by `${chatId}::${branchId}`). The live context preview now lives in a
 * separate branch-scoped cache (`useContextPreviewStore`) — it is no longer a
 * field on the snapshot store. `useActiveTrace` reads: trace-history cache →
 * the snapshot's single latest `promptTrace` → the preview cache.
 *
 * The branch-scoping is structural (cache key), not a client-side filter.
 * These tests pin the selection predicate against all three sources.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatBranchId, ChatId, PromptTraceRecordDto, AssemblePromptResponse } from "@vibe-tavern/domain";
import { useSnapshotStore } from "./snapshot-store.js";
import { useTraceHistoryStore, type TraceHistoryEntry } from "./trace-history-store.js";
import { useContextPreviewStore, type ContextPreviewEntry } from "./context-preview-store.js";

// `useActiveTrace` reads three sources via hooks. To exercise the pure
// selection logic without a DOM harness, we reproduce the predicate here,
// feeding it the same slices the hook reads. Keep in sync with `useActiveTrace`
// in chat-selectors.ts when editing.
function selectActiveTrace(
	snapshot: ReturnType<typeof useSnapshotStore.getState>,
	cachedTraces: PromptTraceRecordDto[],
	preview: AssemblePromptResponse | null,
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
	if (preview) return preview;
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
function seedTraceCache(branchId: ChatBranchId, traces: PromptTraceRecordDto[]): TraceHistoryEntry {
	const entry: TraceHistoryEntry = { status: "success", traces, error: null };
	useTraceHistoryStore.setState((s) => ({
		entries: { ...s.entries, [`${chatId}::${branchId}`]: entry },
	}));
	return entry;
}

/** Seed the context-preview cache with a success entry for (chatId, branchId). */
function seedPreviewCache(branchId: ChatBranchId, preview: AssemblePromptResponse | null): ContextPreviewEntry {
	const entry: ContextPreviewEntry = { status: "success", preview, error: null };
	useContextPreviewStore.setState((s) => ({
		entries: { ...s.entries, [`${chatId}::${branchId}`]: entry },
	}));
	return entry;
}

/** Read the cached preview for the active branch (null if not cached). */
function activePreview(snapshot: ReturnType<typeof useSnapshotStore.getState>): AssemblePromptResponse | null {
	const branchId = snapshot.activeBranch?.id ?? null;
	if (!branchId) return null;
	return useContextPreviewStore.getState().entries[`${chatId}::${branchId}`]?.preview ?? null;
}

describe("useActiveTrace — branch-scoped selection (lazy cache)", () => {
	beforeEach(() => {
		useSnapshotStore.getState().clearMessages();
		useSnapshotStore.setState({
			activeChat: { id: chatId } as never,
			activeBranch: { id: branchA } as never,
			promptTrace: null,
		});
		useTraceHistoryStore.setState({ entries: {} });
		useContextPreviewStore.setState({ entries: {} });
	});

	test("returns the selected trace when it is in the active branch's cached history", () => {
		const traceOnA = makeTrace("t1", branchA, 100);
		seedTraceCache(branchA, [traceOnA]);
		seedPreviewCache(branchA, previewA);
		const selected = selectActiveTrace(useSnapshotStore.getState(), [traceOnA], activePreview(useSnapshotStore.getState()), "t1");
		expect(selected).toBe(traceOnA);
	});

	test("falls back to the branch's cached preview when the active branch has no traces (post-fork)", () => {
		// After forking to branchB, the trace cache for branchB is empty and
		// promptTrace is stale (belongs to branchA), so it must be ignored.
		// The hook falls back to branchB's cached live preview.
		const traceOnA = makeTrace("t1", branchA, 6800);
		useSnapshotStore.setState({
			activeBranch: { id: branchB } as never,
			promptTrace: traceOnA, // stale: belongs to branchA
		});
		seedPreviewCache(branchB, previewB); // fresh: 10 tokens for branchB
		// branchB trace cache is empty (the realistic post-fork state).
		const selected = selectActiveTrace(useSnapshotStore.getState(), [], activePreview(useSnapshotStore.getState()), null);
		expect(selected).toBe(previewB);
		expect((selected as AssemblePromptResponse).tokenAccounting.total).toBe(10);
	});

	test("ignores a stale selectedTraceId that is absent from the active branch's cache", () => {
		// selectedTraceId points at a branchA trace, but the active branchB cache
		// only holds branchB's trace → the stale id is not found, and the latest
		// branchB trace (promptTrace) wins instead.
		const traceOnB = makeTrace("t-on-b", branchB, 20);
		seedTraceCache(branchB, [traceOnB]);
		seedPreviewCache(branchB, previewB);
		useSnapshotStore.setState({
			activeBranch: { id: branchB } as never,
			promptTrace: traceOnB,
		});
		const selected = selectActiveTrace(useSnapshotStore.getState(), [traceOnB], activePreview(useSnapshotStore.getState()), "t-on-a");
		expect(selected).toBe(traceOnB);
		expect((selected as PromptTraceRecordDto).id).toBe("t-on-b");
	});

	test("returns null when no cached traces, no promptTrace, and no cached preview", () => {
		expect(selectActiveTrace(useSnapshotStore.getState(), [], activePreview(useSnapshotStore.getState()), null)).toBeNull();
	});

	test("prefers the latest promptTrace when it belongs to the active branch", () => {
		const latest = makeTrace("latest", branchA, 300);
		const older = makeTrace("older", branchA, 100);
		seedTraceCache(branchA, [older]); // cache holds an older trace
		seedPreviewCache(branchA, previewA);
		useSnapshotStore.setState({ promptTrace: latest });
		// No selectedTraceId → latestForBranch (promptTrace) wins over cache[0].
		const selected = selectActiveTrace(useSnapshotStore.getState(), [older], activePreview(useSnapshotStore.getState()), null);
		expect(selected).toBe(latest);
	});

	test("resolves selectedTraceId from the cache even when promptTrace differs", () => {
		const latest = makeTrace("latest", branchA, 300);
		const older = makeTrace("older", branchA, 100);
		seedTraceCache(branchA, [latest, older]);
		seedPreviewCache(branchA, previewA);
		useSnapshotStore.setState({ promptTrace: latest });
		// User navigated to the older trace → it must be resolved from the cache.
		const selected = selectActiveTrace(useSnapshotStore.getState(), [latest, older], activePreview(useSnapshotStore.getState()), "older");
		expect(selected).toBe(older);
	});
});
