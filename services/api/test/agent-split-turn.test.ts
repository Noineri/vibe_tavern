import { describe, it, expect } from "bun:test";
import {
	applyAgentTurnAnswer,
	hasAwaitingPermissionMarker,
	renderWaitToolOutputWireText,
	stringifyObjectWireText,
	type AgentPersistedToolResult,
	type AgentSplitTurnMessageRow,
} from "../src/domain/agent/agent-split-turn.js";

/**
 * SC-23e — the generalized split-turn mechanism (agent-split-turn.ts), pinned
 * at its OWN boundary: the wire rendering for both wait families (the ask
 * branch byte-pins the pre-SC-23e TAG-5 rendering — the extraction moved it,
 * these prove nothing changed), the permission answer application (allow →
 * the executor's real result stored, deny → the denied marker, stale/foreign
 * ids refused), and the marker-aware stop condition (stops on the awaiting
 * marker, never on a call that answers unknown). The end-to-end ask flow and
 * the sidechat permission flow are pinned in experience-copilot-stream.test.ts
 * and sidechat-ooc-stream.test.ts respectively.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** In-memory rows + captured rewrites (the store subset the application
 *  needs — no DB, no thread machinery). */
function makeFixture(rows: AgentSplitTurnMessageRow[]): {
	rows: AgentSplitTurnMessageRow[];
	rewrites: Array<{ toolCallId: string; payload: AgentPersistedToolResult }>;
	store: { setToolResultOutput: (threadId: string, toolCallId: string, payload: AgentPersistedToolResult) => Promise<void> };
} {
	const rewrites: Array<{ toolCallId: string; payload: AgentPersistedToolResult }> = [];
	return {
		rows,
		rewrites,
		store: {
			setToolResultOutput: async (_threadId, toolCallId, payload) => {
				rewrites.push({ toolCallId, payload });
			},
		},
	};
}

/** An assistant row carrying one tool call (the persisted `toolCallsJson`
 *  shape persistTurn writes). */
function callRow(toolCallId: string, toolName: string, input: unknown): AgentSplitTurnMessageRow {
	return {
		role: "assistant",
		content: "",
		toolCallId: null,
		toolCallsJson: JSON.stringify([{ type: "tool-call", toolCallId, toolName, input }]),
	};
}

/** A tool-result row (the persisted `{ toolName, output }` wrapper). */
function resultRow(toolCallId: string, toolName: string, output: unknown): AgentSplitTurnMessageRow {
	return {
		role: "tool",
		content: JSON.stringify({ toolName, output }),
		toolCallId,
		toolCallsJson: null,
	};
}

// ─── Wire rendering ─────────────────────────────────────────────────────────

describe("renderWaitToolOutputWireText (TAG-5 byte-pins + SC-23e permission)", () => {
	it("ask_user keeps the TAG-5 wire shapes byte-identically", () => {
		expect(renderWaitToolOutputWireText("ask_user", { status: "answered", answer: "blue" })).toBe('{"answer":"blue"}');
		expect(renderWaitToolOutputWireText("ask_user", { status: "skipped" })).toBe('{"skipped":true}');
		expect(renderWaitToolOutputWireText("ask_user", { status: "awaiting_answer", question: "Q?" })).toBe(
			'{"unanswered":true,"note":"the user did not answer this question; they moved on"}',
		);
		// The ask family's non-marker outputs fall through to the generic
		// object guarantee — same as before the extraction.
		expect(renderWaitToolOutputWireText("ask_user", { status: "answered", answer: "" })).toBe(
			'{"status":"answered","answer":""}',
		);
	});

	it("the permission family renders the marker statuses through self-describing keys", () => {
		expect(
			renderWaitToolOutputWireText("read_message_prompt", {
				status: "awaiting_permission",
				position: 3,
				variantNumber: 2,
				replyFirstLine: "She opens the door",
				promptTokens: 4321,
				presetName: "Agentic Narrator",
			}),
		).toBe('{"unanswered":true,"note":"the user did not answer this permission request; they moved on"}');
		expect(
			renderWaitToolOutputWireText("read_message_prompt", { status: "granted", prompt: "<rp_prompt preset=\"X\">…</rp_prompt>", promptTokens: 4321 }),
		).toBe('{"prompt":"<rp_prompt preset=\\"X\\">…</rp_prompt>","promptTokens":4321}');
		expect(renderWaitToolOutputWireText("read_message_prompt", { status: "denied" })).toBe('{"denied":true}');
	});

	it("a non-wait tool renders undefined (the caller keeps the generic wire)", () => {
		expect(renderWaitToolOutputWireText("search_context", { status: "awaiting_permission" })).toBeDefined();
		// ^ the marker statuses belong to the MECHANISM, not a tool name — a
		// tool that returns one is a wait tool by construction. But an ordinary
		// output of an ordinary tool stays undefined:
		expect(renderWaitToolOutputWireText("search_context", { results: [] })).toBeUndefined();
		expect(renderWaitToolOutputWireText("todo", { items: [] })).toBeUndefined();
		// The unknown-prompt answer is NOT a marker — the function yields to
		// the caller, whose generic fallback renders it as the stored object
		// (pinned below via stringifyObjectWireText).
		expect(renderWaitToolOutputWireText("read_message_prompt", { status: "unknown_prompt", note: "n" })).toBeUndefined();
		expect(stringifyObjectWireText({ status: "unknown_prompt", note: "n" })).toBe('{"status":"unknown_prompt","note":"n"}');
	});

	it("stringifyObjectWireText keeps the Struct contract (objects verbatim, primitives wrapped)", () => {
		expect(stringifyObjectWireText({ a: 1 })).toBe('{"a":1}');
		expect(stringifyObjectWireText("flat")).toBe('{"result":"flat"}');
		expect(stringifyObjectWireText(42)).toBe('{"result":42}');
	});
});

// ─── The answer application ─────────────────────────────────────────────────

describe("applyAgentTurnAnswer — the ask family (TAG-5, byte-identical)", () => {
	it("an ask answer rewrites the marker row to the answered payload", async () => {
		const rows = [callRow("tc_1", "ask_user", { question: "Q?" }), resultRow("tc_1", "ask_user", { status: "awaiting_answer", question: "Q?" })];
		const fx = makeFixture(rows);
		await applyAgentTurnAnswer({
			threadId: "t1",
			answer: { toolCallId: "tc_1", text: "blue" },
			priorMessages: fx.rows,
			store: fx.store,
		});
		expect(fx.rewrites).toEqual([
			{ toolCallId: "tc_1", payload: { toolName: "ask_user", output: { status: "answered", answer: "blue" } } },
		]);
		// The in-memory copy is rewritten so this turn's assembly sees it.
		expect(JSON.parse(rows[1]!.content)).toEqual({ toolName: "ask_user", output: { status: "answered", answer: "blue" } });
	});

	it("a foreign or stale toolCallId is refused with the TAG-5 message", async () => {
		const fx = makeFixture([resultRow("tc_other", "ask_user", { status: "awaiting_answer" })]);
		await expect(
			applyAgentTurnAnswer({
				threadId: "t1",
				answer: { toolCallId: "tc_missing", text: "blue" },
				priorMessages: fx.rows,
				store: fx.store,
			}),
		).rejects.toThrow(
			"The question being answered was not found (or is no longer awaiting) in this thread.",
		);
		// An awaiting PERMISSION row is not an ask row — same refusal family.
		const fx2 = makeFixture([resultRow("tc_p", "read_message_prompt", { status: "awaiting_permission" })]);
		await expect(
			applyAgentTurnAnswer({
				threadId: "t1",
				answer: { toolCallId: "tc_p", text: "blue" },
				priorMessages: fx2.rows,
				store: fx2.store,
			}),
		).rejects.toThrow("The question being answered was not found");
	});
});

describe("applyAgentTurnAnswer — the permission family (SC-23e)", () => {
	function permissionFixture(): ReturnType<typeof makeFixture> {
		return makeFixture([
			callRow("tc_p1", "read_message_prompt", { position: 3 }),
			resultRow("tc_p1", "read_message_prompt", { status: "awaiting_permission", position: 3, variantNumber: 1, replyFirstLine: "L", promptTokens: 10, presetName: "P" }),
		]);
	}

	it("deny stores the denied marker and rewrites the in-memory row", async () => {
		const fx = permissionFixture();
		await applyAgentTurnAnswer({
			threadId: "t1",
			answer: { toolCallId: "tc_p1", decision: "deny" },
			priorMessages: fx.rows,
			store: fx.store,
		});
		expect(fx.rewrites).toEqual([
			{ toolCallId: "tc_p1", payload: { toolName: "read_message_prompt", output: { status: "denied" } } },
		]);
		expect(JSON.parse(fx.rows[1]!.content)).toEqual({ toolName: "read_message_prompt", output: { status: "denied" } });
	});

	it("allow re-runs the kind's executor with the RECORDED input and stores its real result", async () => {
		const fx = permissionFixture();
		const calls: Array<{ toolName: string; toolInput: unknown; toolCallId: string }> = [];
		await applyAgentTurnAnswer({
			threadId: "t1",
			answer: { toolCallId: "tc_p1", decision: "allow" },
			priorMessages: fx.rows,
			store: fx.store,
			runWaitTool: async (toolName, toolInput, toolCallId) => {
				calls.push({ toolName, toolInput, toolCallId });
				return { status: "granted", prompt: "<rp_prompt/>", promptTokens: 7 };
			},
		});
		expect(calls).toEqual([
			{ toolName: "read_message_prompt", toolInput: { position: 3 }, toolCallId: "tc_p1" },
		]);
		expect(fx.rewrites).toEqual([
			{
				toolCallId: "tc_p1",
				payload: { toolName: "read_message_prompt", output: { status: "granted", prompt: "<rp_prompt/>", promptTokens: 7 } },
			},
		]);
	});

	it("a permission answer for a non-awaiting row is refused", async () => {
		const fx = makeFixture([resultRow("tc_ask", "ask_user", { status: "awaiting_answer" })]);
		await expect(
			applyAgentTurnAnswer({
				threadId: "t1",
				answer: { toolCallId: "tc_ask", decision: "deny" },
				priorMessages: fx.rows,
				store: fx.store,
			}),
		).rejects.toThrow(
			"The permission request being answered was not found (or is no longer awaiting) in this thread.",
		);
	});

	it("allow without the kind's executor, or with the call row gone, is refused", async () => {
		const noExecutor = permissionFixture();
		await expect(
			applyAgentTurnAnswer({
				threadId: "t1",
				answer: { toolCallId: "tc_p1", decision: "allow" },
				priorMessages: noExecutor.rows,
				store: noExecutor.store,
			}),
		).rejects.toThrow("no wait-tool executor is wired");
		// Marker row present, its tool-CALL row deleted — the input cannot be
		// re-run: refused before any rewrite.
		const noCallRow = makeFixture([
			resultRow("tc_p2", "read_message_prompt", { status: "awaiting_permission" }),
		]);
		await expect(
			applyAgentTurnAnswer({
				threadId: "t1",
				answer: { toolCallId: "tc_p2", decision: "allow" },
				priorMessages: noCallRow.rows,
				store: noCallRow.store,
				runWaitTool: async () => "never",
			}),
		).rejects.toThrow("its recorded input cannot be re-run");
		expect(noCallRow.rewrites).toEqual([]);
	});
});

// ─── The marker-aware stop condition ────────────────────────────────────────

describe("hasAwaitingPermissionMarker (the SC-23e stop condition)", () => {
	const condition = hasAwaitingPermissionMarker("read_message_prompt");
	/** A stop-condition call fixture: the step-list shape the condition reads. */
	const cond = (
		toolResults: ReadonlyArray<{ toolName?: string; output?: unknown }>,
	): {
		steps: Array<{ toolResults?: ReadonlyArray<{ toolName?: string; output?: unknown }> }>;
	} => ({ steps: [{ toolResults: [...toolResults] }] });

	it("stops on the latest step's awaiting marker for the tool", () => {
		expect(
			condition(cond([{ toolName: "read_message_prompt", output: { status: "awaiting_permission" } }])),
		).toBe(true);
	});

	it("does NOT stop on the tool's non-marker answers (unknown/unresolved relay in-turn)", () => {
		expect(condition(cond([{ toolName: "read_message_prompt", output: { status: "unknown_prompt" } }]))).toBe(false);
		expect(condition(cond([{ toolName: "read_message_prompt", output: { status: "unresolved" } }]))).toBe(false);
	});

	it("does not stop on another tool's marker, an earlier step's marker, or an empty step list", () => {
		expect(condition(cond([{ toolName: "ask_user", output: { status: "awaiting_permission" } }]))).toBe(false);
		expect(condition({ steps: [{ toolResults: [] }, { toolResults: [] }] })).toBe(false);
		expect(condition({ steps: [] })).toBe(false);
	});
});
