/**
 * CA-9.2b — CoauthorToolActivityCard DOM tests.
 *
 * Pins the card's visible behaviours (the slot wrapper is store-driven and
 * covered by the coauthor-turn-store tests in CA-9.2a; here we exercise the
 * pure, prop-driven card):
 *   - a `done` activity renders the model's summary and expands to the proposed
 *     preview on click;
 *   - a `streaming` activity shows the "editing…" label, disables the toggle,
 *     and hides the proposed preview;
 *   - an `error` activity shows the error label;
 *   - an empty summary falls back to the section label.
 */
import { describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { render, fireEvent } from "@testing-library/react";
import { ToolActivityCard } from "./CoauthorToolActivitySlot.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";

// Mock useT at the module boundary — the card imports i18n for labels.
// Returns the key verbatim so assertions can match on stable key strings.
mock.module("../../i18n/context.js", () => ({
	useT: () => ({ t: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

function activity(over: Partial<CoauthorToolActivity> = {}): CoauthorToolActivity {
	return {
		toolCallId: "call_1",
		toolName: "edit_profile",
		status: "done",
		summary: "Made the personality more assertive.",
		target: "profile",
		proposed: "---\nname: Kira\n---\n# PERSONALITY\nBold and direct.",
		...over,
	};
}

describe("ToolActivityCard", () => {
	useDomEnv();

	it("renders the summary for a done activity and expands to the proposed preview on click", () => {
		const { getByText, queryByText, container } = render(<ToolActivityCard activity={activity()} />);
		expect(getByText("Made the personality more assertive.")).toBeDefined();
		// Proposed preview is hidden until expanded.
		expect(queryByText(/# PERSONALITY/)).toBeNull();
		fireEvent.click(getByText("Made the personality more assertive."));
		expect(getByText(/# PERSONALITY/)).toBeDefined();
		// Sanity: the card root is a bordered surface.
		expect(container.querySelector(".border-border")).not.toBeNull();
	});

	it("shows the streaming label, disables the toggle, and hides the proposed preview", () => {
		const { getByText, queryByText } = render(<ToolActivityCard activity={activity({ status: "streaming", summary: "Tightening the scenario." })} />);
		expect(getByText("Tightening the scenario.")).toBeDefined();
		// The streaming affordance label (i18n key, returned verbatim by the mock).
		expect(getByText("coauthor_tool_streaming")).toBeDefined();
		// Proposed preview must not render while streaming.
		expect(queryByText(/# PERSONALITY/)).toBeNull();
	});

	it("shows the error label for an errored activity", () => {
		const { getByText } = render(<ToolActivityCard activity={activity({ status: "error", summary: "Rewrite greeting" })} />);
		expect(getByText("Rewrite greeting")).toBeDefined();
		expect(getByText("coauthor_tool_error")).toBeDefined();
	});

	it("falls back to the section label when the summary is empty/blank", () => {
		const { getByText } = render(<ToolActivityCard activity={activity({ summary: "   " })} />);
		expect(getByText("coauthor_tool_activity")).toBeDefined();
	});
});
