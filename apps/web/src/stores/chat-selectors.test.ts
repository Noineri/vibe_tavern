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
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { brandId } from "@vibe-tavern/domain";
import type { ChatBranchId, ChatId, MessageId, PromptTraceRecordDto, AssemblePromptResponse } from "@vibe-tavern/domain";
import { useDomEnv } from "../../test/dom-env.js";
import { wireBranch, wireChat, wirePromptPreview } from "../../test/wire-fixtures.js";
import { useActiveTrace } from "./chat-selectors.js";
import { useSnapshotStore } from "./snapshot-store.js";
import { useTraceHistoryStore, type TraceHistoryEntry } from "./trace-history-store.js";
import { useContextPreviewStore, type ContextPreviewEntry } from "./context-preview-store.js";

useDomEnv();

const originalSnapshotState = useSnapshotStore.getState();
const originalTraceState = useTraceHistoryStore.getState();
const originalPreviewState = useContextPreviewStore.getState();
afterAll(() => {
	useSnapshotStore.setState(originalSnapshotState, true);
	useTraceHistoryStore.setState(originalTraceState, true);
	useContextPreviewStore.setState(originalPreviewState, true);
});

const { renderHook } = await import("@testing-library/react");

const chatId = "chat-1" as ChatId;
const branchA = "brnch-a" as ChatBranchId;
const branchB = "brnch-b" as ChatBranchId;

function makeTrace(id: string, branchId: ChatBranchId, tokenTotal: number): PromptTraceRecordDto {
	return {
		id,
		chatId,
		branchId,
		messageId: brandId<MessageId>("msg-1"),
		createdAt: "2026-01-01T00:00:00Z",
		model: "test-model",
		presetName: "test-preset",
		latencyMs: 0,
		tokenAccounting: { total: tokenTotal },
		layers: [],
		// `finalPayload` is `Record<string, unknown>` — the erased literal's null
		// was a hidden type lie; nothing in these tests reads it.
		finalPayload: {},
		activatedLoreEntries: [],
		activatedLoreDetail: [],
		retrievedMemories: [],
		scriptInjections: [],
	};
}

const previewA = wirePromptPreview(50);
const previewB = wirePromptPreview(10);

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

describe("useActiveTrace — branch-scoped selection (lazy cache)", () => {
	beforeEach(() => {
		useSnapshotStore.getState().clearMessages();
		useSnapshotStore.setState({
			activeChat: wireChat({ id: chatId }),
			activeBranch: wireBranch({ id: branchA }),
			promptTrace: null,
		});
		useTraceHistoryStore.setState({ entries: {} });
		useContextPreviewStore.setState({ entries: {} });
	});

	test("returns the selected trace when it is in the active branch's cached history", () => {
		const traceOnA = makeTrace("t1", branchA, 100);
		seedTraceCache(branchA, [traceOnA]);
		seedPreviewCache(branchA, previewA);
		const hook = renderHook(({ id }: { id: string | null }) => useActiveTrace(id), {
			initialProps: { id: "t1" },
		});
		try {
			expect(hook.result.current).toBe(traceOnA);
		} finally {
			hook.unmount();
		}
	});

	test("falls back to the branch's cached preview when the active branch has no traces (post-fork)", () => {
		// After forking to branchB, the trace cache for branchB is empty and
		// promptTrace is stale (belongs to branchA), so it must be ignored.
		// The hook falls back to branchB's cached live preview.
		const traceOnA = makeTrace("t1", branchA, 6800);
		useSnapshotStore.setState({
			activeBranch: wireBranch({ id: branchB }),
			promptTrace: traceOnA, // stale: belongs to branchA
		});
		seedPreviewCache(branchB, previewB); // fresh: 10 tokens for branchB
		// branchB trace cache is empty (the realistic post-fork state).
		const hook = renderHook(({ id }: { id: string | null }) => useActiveTrace(id), {
			initialProps: { id: null },
		});
		try {
			expect(hook.result.current).toBe(previewB);
			expect((hook.result.current as AssemblePromptResponse).tokenAccounting.total).toBe(10);
		} finally {
			hook.unmount();
		}
	});

	test("ignores a stale selectedTraceId that is absent from the active branch's cache", () => {
		// selectedTraceId points at a branchA trace, but the active branchB cache
		// only holds branchB's trace → the stale id is not found, and the latest
		// branchB trace (promptTrace) wins instead.
		const traceOnB = makeTrace("t-on-b", branchB, 20);
		seedTraceCache(branchB, [traceOnB]);
		seedPreviewCache(branchB, previewB);
		useSnapshotStore.setState({
			activeBranch: wireBranch({ id: branchB }),
			promptTrace: traceOnB,
		});
		const hook = renderHook(({ id }: { id: string | null }) => useActiveTrace(id), {
			initialProps: { id: "t-on-a" },
		});
		try {
			expect(hook.result.current).toBe(traceOnB);
			expect((hook.result.current as PromptTraceRecordDto).id).toBe("t-on-b");
		} finally {
			hook.unmount();
		}
	});

	test("returns null when no cached traces, no promptTrace, and no cached preview", () => {
		const hook = renderHook(({ id }: { id: string | null }) => useActiveTrace(id), {
			initialProps: { id: null },
		});
		try {
			expect(hook.result.current).toBeNull();
		} finally {
			hook.unmount();
		}
	});

	test("prefers the latest promptTrace when it belongs to the active branch", () => {
		const latest = makeTrace("latest", branchA, 300);
		const older = makeTrace("older", branchA, 100);
		seedTraceCache(branchA, [older]); // cache holds an older trace
		seedPreviewCache(branchA, previewA);
		useSnapshotStore.setState({ promptTrace: latest });
		// No selectedTraceId → latestForBranch (promptTrace) wins over cache[0].
		const hook = renderHook(({ id }: { id: string | null }) => useActiveTrace(id), {
			initialProps: { id: null },
		});
		try {
			expect(hook.result.current).toBe(latest);
		} finally {
			hook.unmount();
		}
	});

	test("resolves selectedTraceId from the cache even when promptTrace differs", () => {
		const latest = makeTrace("latest", branchA, 300);
		const older = makeTrace("older", branchA, 100);
		seedTraceCache(branchA, [latest, older]);
		seedPreviewCache(branchA, previewA);
		useSnapshotStore.setState({ promptTrace: latest });
		// User navigated to the older trace → it must be resolved from the cache.
		const hook = renderHook(({ id }: { id: string | null }) => useActiveTrace(id), {
			initialProps: { id: "older" },
		});
		try {
			expect(hook.result.current).toBe(older);
		} finally {
			hook.unmount();
		}
	});
});
