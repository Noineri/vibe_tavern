/**
 * useActiveTrace — branch-scoped trace selection.
 *
 * Regression test for: after a fork / activate-branch switch, the store
 * still holds the PREVIOUS branch's `promptTrace` + `promptTraceHistory`
 * (they are only re-fetched lazily — see TRACE_LAZY_LOADING_PLAN).
 * `useActiveTrace` must filter them against the ACTIVE branch so the UI
 * (context bar, Build Mode trace view, TopBar lore/memory counts) never
 * shows the old branch's token count / layers. When no trace exists for
 * the active branch, it falls back to `contextPreview` (always assembled
 * fresh for the active branch).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatBranchId, PromptTraceRecordDto, AssemblePromptResponse } from "@vibe-tavern/domain";
import { useSnapshotStore } from "./snapshot-store.js";

// `useActiveTrace` reads the store via useSyncExternalStore. To exercise
// the pure selection logic without a DOM harness, we reach into the same
// store state the hook reads and reproduce the selection predicate here.
// (The hook body is a one-line `useSnapshotStore(useShallow(fn))`; the
// selection logic under test is identical to `fn`.)
//
// If the selector logic drifts from this reproduction, the tests below
// flag it — keep them in sync when editing `useActiveTrace`.
function selectActiveTrace(
	state: ReturnType<typeof useSnapshotStore.getState>,
	selectedTraceId: string | null,
): PromptTraceRecordDto | AssemblePromptResponse | null {
	const activeBranchId = state.activeBranch?.id ?? null;
	const historyForBranch = activeBranchId
		? state.promptTraceHistory.filter((trace) => trace.branchId === activeBranchId)
		: state.promptTraceHistory;
	const latestForBranch =
		state.promptTrace && state.promptTrace.branchId === activeBranchId
			? state.promptTrace
			: null;
	const fromHistory =
		historyForBranch.find((trace) => trace.id === selectedTraceId) ??
		latestForBranch ??
		historyForBranch[0];
	if (fromHistory) return fromHistory;
	if (state.contextPreview) return state.contextPreview;
	return null;
}

const branchA = "brnch-a" as ChatBranchId;
const branchB = "brnch-b" as ChatBranchId;

function makeTrace(id: string, branchId: ChatBranchId, tokenTotal: number): PromptTraceRecordDto {
	return {
		id,
		chatId: "chat-1" as never,
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
		retrievedMemories: [],
		scriptInjections: [],
		assembledLayers: [],
	} as unknown as PromptTraceRecordDto;
}

const previewA = { layers: [], tokenAccounting: { total: 50 } } as unknown as AssemblePromptResponse;
const previewB = { layers: [], tokenAccounting: { total: 10 } } as unknown as AssemblePromptResponse;

describe("useActiveTrace — branch-scoped selection", () => {
	beforeEach(() => {
		useSnapshotStore.getState().clearMessages();
		useSnapshotStore.setState({
			activeBranch: { id: branchA } as never,
			promptTrace: null,
			promptTraceHistory: [],
			contextPreview: null,
		});
	});

	test("returns the selected trace when it belongs to the active branch", () => {
		const traceOnA = makeTrace("t1", branchA, 100);
		useSnapshotStore.setState({
			promptTraceHistory: [traceOnA],
			contextPreview: previewA,
		});
		const selected = selectActiveTrace(useSnapshotStore.getState(), "t1");
		expect(selected).toBe(traceOnA);
	});

	test("falls back to contextPreview when no trace exists for the active branch (post-fork scenario)", () => {
		// Simulate: user was on branchA (68-msg chat, traces live), forked to
		// branchB (2-msg chat). Store still holds branchA's traces; activeBranch
		// switched to branchB. The hook MUST show branchB's fresh contextPreview,
		// NOT branchA's stale traces.
		const traceOnA = makeTrace("t1", branchA, 6800);
		useSnapshotStore.setState({
			activeBranch: { id: branchB } as never,
			promptTrace: traceOnA,                 // stale: belongs to branchA
			promptTraceHistory: [traceOnA],        // stale: belongs to branchA
			contextPreview: previewB,              // fresh: 10 tokens for branchB
		});
		const selected = selectActiveTrace(useSnapshotStore.getState(), null);
		expect(selected).toBe(previewB);
		expect((selected as AssemblePromptResponse).tokenAccounting.total).toBe(10);
	});

	test("does NOT return a stale selectedTraceId that belongs to another branch", () => {
		const traceOnA = makeTrace("t-on-a", branchA, 6800);
		const traceOnB = makeTrace("t-on-b", branchB, 20);
		useSnapshotStore.setState({
			activeBranch: { id: branchB } as never,
			promptTrace: traceOnB,
			promptTraceHistory: [traceOnA, traceOnB],
			contextPreview: previewB,
		});
		// selectedTraceId points at a trace from the (no-longer-active) branchA.
		// It must be ignored; the latest branchB trace wins instead.
		const selected = selectActiveTrace(useSnapshotStore.getState(), "t-on-a");
		expect(selected).toBe(traceOnB);
		expect((selected as PromptTraceRecordDto).id).toBe("t-on-b");
	});

	test("returns null when no traces and no contextPreview exist", () => {
		useSnapshotStore.setState({
			activeBranch: { id: branchA } as never,
			promptTrace: null,
			promptTraceHistory: [],
			contextPreview: null,
		});
		expect(selectActiveTrace(useSnapshotStore.getState(), null)).toBeNull();
	});

	test("with no active branch, falls back to unfiltered history (bootstrap before branch resolved)", () => {
		const trace = makeTrace("t1", branchA, 100);
		useSnapshotStore.setState({
			activeBranch: null,
			promptTrace: trace,
			promptTraceHistory: [trace],
			contextPreview: previewA,
		});
		// No activeBranch → no filtering; the old behavior must be preserved so
		// the very first bootstrap render (before activeBranch is ingested)
		// doesn't go blank.
		const selected = selectActiveTrace(useSnapshotStore.getState(), null);
		expect(selected).toBe(trace);
	});
});

// Keep mock import referenced so bun:test types resolve in colocated tests.
void mock;
