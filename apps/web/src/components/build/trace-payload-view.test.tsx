/**
 * Wave C — TracePayloadView tests.
 *
 * Two layers:
 *   1. Pure-function tests for `groupPayloadForTrace` (no DOM) — pin the
 *      preamble/history split and the inject-divider + message-group shape.
 *   2. DOM render tests for `TracePayloadView` — pin that the Chat History
 *      accordion renders collapsed, injects are always-visible dividers, and
 *      message runs collapse into expandable groups.
 *
 * See PROMPT_TRACE_PAYLOAD_FIX_PLAN.md, Wave C.
 */
import { describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent } from "@testing-library/react";
import {
	groupPayloadForTrace,
	TracePayloadView,
	type PayloadMessage,
} from "./trace-payload-view.js";
import type { PromptLayerDto } from "@vibe-tavern/domain";

const NOOP = () => {};

// Mock useT at the module boundary (same relative path the component uses).
mock.module("../../i18n/context.js", () => ({
	useT: () => ({ t: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

const formatTokens = (n: number) => `${n} tok`;

function layer(overrides: Partial<PromptLayerDto> & Pick<PromptLayerDto, "id">): PromptLayerDto {
	return {
		sourceType: "prompt_preset",
		sourceId: "src",
		sourceName: overrides.id,
		position: "in_prompt",
		priority: 0,
		enabled: true,
		reason: "",
		tokenCount: 10,
		text: `text-${overrides.id}`,
		...overrides,
	};
}

// ─── Pure function: groupPayloadForTrace ──────────────────────────────

describe("groupPayloadForTrace", () => {
	it("splits leading layerId entries into preamble and the rest into history", () => {
		const messages: PayloadMessage[] = [
			{ role: "system", content: "sys", layerId: "prompt_preset_system" },
			{ role: "system", content: "char", layerId: "character_base" },
			{ role: "user", content: "hello", messageId: "m1" },
			{ role: "assistant", content: "hi", messageId: "m2" },
			{ role: "system", content: "note", layerId: "prompt_preset_authors_note" },
		];
		const layers = [
			layer({ id: "prompt_preset_system" }),
			layer({ id: "character_base" }),
			layer({ id: "prompt_preset_authors_note", position: "in_chat", injectionDepth: 0 }),
		];
		const g = groupPayloadForTrace(messages, layers);
		expect(g.hasHistory).toBe(true);
		expect(g.preamble.map((l) => l.id)).toEqual(["prompt_preset_system", "character_base"]);
		// History: one message group (m1,m2) then one inject divider.
		expect(g.history).toHaveLength(2);
		expect(g.history[0]!.kind).toBe("messages");
		expect(g.history[1]!.kind).toBe("inject");
	});

	it("groups consecutive messages and emits injects as dividers between them", () => {
		const messages: PayloadMessage[] = [
			{ role: "user", content: "u1", messageId: "m1" },
			{ role: "assistant", content: "a1", messageId: "m2" },
			{ role: "system", content: "inj", layerId: "mid_inject" },
			{ role: "user", content: "u2", messageId: "m3" },
		];
		const layers = [layer({ id: "mid_inject", position: "in_chat", injectionDepth: 2 })];
		const g = groupPayloadForTrace(messages, layers);
		expect(g.history).toEqual([
			{ kind: "messages", start: 1, end: 2, count: 2, messages: [
				{ role: "user", content: "u1", messageId: "m1" },
				{ role: "assistant", content: "a1", messageId: "m2" },
			] },
			{ kind: "inject", layerId: "mid_inject", sourceName: "mid_inject", sourceType: "prompt_preset", depth: 2, tokenCount: 10, text: "text-mid_inject" },
			{ kind: "messages", start: 3, end: 3, count: 1, messages: [
				{ role: "user", content: "u2", messageId: "m3" },
			] },
		]);
	});

	it("treats a payload with no chat messages as all-preamble, no history", () => {
		const messages: PayloadMessage[] = [
			{ role: "system", content: "sys", layerId: "prompt_preset_system" },
		];
		const layers = [layer({ id: "prompt_preset_system" })];
		const g = groupPayloadForTrace(messages, layers);
		expect(g.hasHistory).toBe(false);
		expect(g.history).toEqual([]);
		expect(g.preamble.map((l) => l.id)).toEqual(["prompt_preset_system"]);
	});
});

// ─── DOM render: TracePayloadView ─────────────────────────────────────

describe("TracePayloadView (DOM)", () => {
	useDomEnv();

	function traceFixture() {
		return {
			layers: [
				layer({ id: "prompt_preset_system", sourceName: "System Prompt", tokenCount: 50, text: "SYS_TEXT" }),
				layer({ id: "character_base", sourceName: "Character", tokenCount: 30, text: "CHAR_TEXT" }),
				layer({ id: "recent_history", sourceName: "recent_history", tokenCount: 120, text: "" }),
				layer({ id: "prompt_preset_authors_note", sourceName: "Post-History Instructions", position: "in_chat", injectionDepth: 0, tokenCount: 5, text: "NOTE_TEXT" }),
			],
			tokenAccounting: { total: 205 },
			activatedLoreEntries: [],
			scriptInjections: [],
			retrievedMemories: [],
			finalPayload: {
				messages: [
					{ role: "system", content: "SYS_TEXT", layerId: "prompt_preset_system" },
					{ role: "system", content: "CHAR_TEXT", layerId: "character_base" },
					{ role: "user", content: "hello", messageId: "m1" },
					{ role: "assistant", content: "hi there", messageId: "m2" },
					{ role: "system", content: "NOTE_TEXT", layerId: "prompt_preset_authors_note" },
				],
			},
		};
	}

	it("renders preamble layer cards and a collapsed Chat History accordion", () => {
		const { getByText, queryByText } = render(
			<TracePayloadView trace={traceFixture() as never} searchQuery="" formatTokens={formatTokens} />,
		);
		// Preamble cards visible.
		expect(getByText("System Prompt")).toBeTruthy();
		expect(getByText("Character")).toBeTruthy();
		// Chat History accordion header present.
		expect(getByText("trace_chat_history")).toBeTruthy();
		// Collapsed by default: message content not shown.
		expect(queryByText("hello")).toBeNull();
		expect(queryByText("hi there")).toBeNull();
	});

	it("expanding Chat History reveals the inject divider and message groups", () => {
		const { getByText, queryByText, container } = render(
			<TracePayloadView trace={traceFixture() as never} searchQuery="" formatTokens={formatTokens} />,
		);
		// Collapsed: divider + group content hidden.
		expect(queryByText("Post-History Instructions")).toBeNull();
		expect(container.textContent).not.toContain("hi there");

		// Click the accordion header to expand.
		fireEvent.click(getByText("trace_chat_history"));

		// Inject divider is visible once expanded (its text body still hidden).
		expect(getByText("Post-History Instructions")).toBeTruthy();
		expect(container.textContent).not.toContain("NOTE_TEXT");
		// Message group (collapsed) shows its label, not the full content yet —
		// the first message appears in the group's preview line, but the second
		// message only renders once the group itself is expanded.
		expect(getByText(/trace_message_group_range|trace_message_group_one/)).toBeTruthy();
		expect(container.textContent).not.toContain("hi there");
	});

	it("an inject expands to reveal its injected text", () => {
		const { getByText, queryByText, container } = render(
			<TracePayloadView trace={traceFixture() as never} searchQuery="" formatTokens={formatTokens} />,
		);
		fireEvent.click(getByText("trace_chat_history"));
		// Inject body hidden until the inject header itself is clicked.
		expect(container.textContent).not.toContain("NOTE_TEXT");

		fireEvent.click(getByText("Post-History Instructions"));
		expect(container.textContent).toContain("NOTE_TEXT");

		// Collapsing the inject hides the body again.
		fireEvent.click(getByText("Post-History Instructions"));
		expect(queryByText("NOTE_TEXT")).toBeNull();
	});

	it("a search query force-expands history, shows matching groups, and filters out non-matching injects", () => {
		const { getByText, queryByText, container } = render(
			<TracePayloadView trace={traceFixture() as never} searchQuery="hello" formatTokens={formatTokens} />,
		);
		// Search auto-expands the accordion.
		// The inject ("Post-History Instructions" / "NOTE_TEXT") does NOT match
		// "hello" and is correctly filtered out.
		expect(queryByText("Post-History Instructions")).toBeNull();
		// Matching message content is shown (group auto-expanded by search).
		expect(container.textContent).toContain("hello");
		// The matching group renders both its messages.
		expect(container.textContent).toContain("hi there");
	});

	it("a search query matching an inject's text expands that inject", () => {
		const { container } = render(
			<TracePayloadView trace={traceFixture() as never} searchQuery="NOTE_TEXT" formatTokens={formatTokens} />,
		);
		// The inject matches the query and is auto-expanded to reveal its text.
		expect(container.textContent).toContain("NOTE_TEXT");
	});

	it("falls back to a flat layer list when finalPayload has no messages", () => {
		const trace = {
			...traceFixture(),
			finalPayload: {},
		};
		const { getByText, queryByText } = render(
			<TracePayloadView trace={trace as never} searchQuery="" formatTokens={formatTokens} />,
		);
		expect(getByText("System Prompt")).toBeTruthy();
		// No history accordion without messages.
		expect(queryByText("trace_chat_history")).toBeNull();
	});
});
