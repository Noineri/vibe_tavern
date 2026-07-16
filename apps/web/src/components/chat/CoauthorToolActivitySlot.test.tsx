/**
 * CA-9.2b / CED-6 — CoauthorToolActivityCard DOM tests.
 *
 * Pins the card's OPERATION-LEVEL previews (the slot wrapper is store-driven and
 * covered by the coauthor-turn-store tests; here we exercise the pure,
 * prop-driven card). The card must look like an IDE/CLI operation, not a full
 * profile dump: it renders the operation INPUT (scoped SEARCH/REPLACE for
 * edits, the section body for writes, the slot text for greetings) — never the
 * full cumulative `proposed` profile, except for a true whole-document
 * `write_profile`. Historical rows without input show their summary but must
 * not fall back to printing the full proposed snapshot.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolActivityCard } from "./CoauthorToolActivitySlot.js";
import type { CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";

// Mock useT at the module boundary — the card imports i18n for labels.
// Returns the key verbatim so assertions can match on stable key strings.
vi.mock("../../i18n/context.js", () => ({
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// A full cumulative profile.md (what `proposed` carries for profile-target ops).
// Section ops must NOT render this verbatim — only write_profile may.
const FULL_PROFILE = "---\nname: Kira\n---\n# PERSONALITY\nBold and direct.\n# SCENARIO\nA quiet bar.\n# EXAMPLES\n{{char}}: Hi.";

function activity(over: Partial<CoauthorToolActivity>): CoauthorToolActivity {
	return {
		toolCallId: "call_1",
		toolName: "write_profile",
		status: "done",
		summary: "Made the personality more assertive.",
		target: "profile",
		proposed: FULL_PROFILE,
		...over,
	};
}

describe("ToolActivityCard — operation previews (CED-6)", () => {
	it("an exact-edit card shows only the SEARCH/REPLACE deltas, never the full profile", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard
				activity={activity({
					toolName: "edit_personality",
					summary: "sharpen",
					args: { edits: [{ search: "Bold and direct.", replace: "Bold, direct, and a little cruel." }], summary: "sharpen" },
				})}
			/>,
		);
		fireEvent.click(getByText("sharpen"));
		// The scoped search + replace content is shown.
		expect(getByText("Bold and direct.")).toBeDefined();
		expect(getByText("Bold, direct, and a little cruel.")).toBeDefined();
		// A section the edit did NOT touch must NOT leak → we are not printing the full profile.
		expect(queryByText("A quiet bar.")).toBeNull();
		expect(queryByText(/# EXAMPLES/)).toBeNull();
	});

	it("a whole-section write card shows only the new section body + write label, never the full profile", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard
				activity={activity({
					toolName: "write_scenario",
					summary: "rewrite scenario",
					args: { content: "A neon-lit rooftop in the rain.", summary: "rewrite scenario" },
				})}
			/>,
		);
		fireEvent.click(getByText("rewrite scenario"));
		expect(getByText("A neon-lit rooftop in the rain.")).toBeDefined();
		expect(getByText("coauthor_tool_op_section_write")).toBeDefined();
		// Untouched sections do not leak.
		expect(queryByText("A quiet bar.")).toBeNull();
		expect(queryByText(/# PERSONALITY/)).toBeNull();
	});

	it("a greeting card shows the affected slot content + slot label", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard
				activity={activity({
					toolName: "edit_greeting",
					summary: "rewrite opener",
					target: "greeting",
					greetingIndex: 0,
					proposed: "{{char}} leans on the bar, smirking.",
					args: { index: 0, content: "{{char}} leans on the bar, smirking.", summary: "rewrite opener" },
				})}
			/>,
		);
		fireEvent.click(getByText("rewrite opener"));
		expect(getByText("{{char}} leans on the bar, smirking.")).toBeDefined();
		expect(getByText("coauthor_tool_op_greeting_primary")).toBeDefined();
		// The profile document is not involved in a greeting op.
		expect(queryByText(/# PERSONALITY/)).toBeNull();
	});

	it("write_profile is the only op that shows the full profile document", () => {
		const { getByText } = render(
			<ToolActivityCard
				activity={activity({
					toolName: "write_profile",
					summary: "full rewrite",
					args: { profileMd: FULL_PROFILE, summary: "full rewrite" },
				})}
			/>,
		);
		fireEvent.click(getByText("full rewrite"));
		// The full document is shown (multiple sections present).
		expect(getByText(/# PERSONALITY/)).toBeDefined();
		expect(getByText(/# SCENARIO/)).toBeDefined();
	});

	it("a historical activity without input shows its summary but never the full proposed snapshot", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard
				activity={activity({
					toolName: "edit_personality",
					summary: "older edit",
					args: undefined, // missing input (historical / no carrier call)
				})}
			/>,
		);
		// Summary still visible; toggle enabled.
		expect(getByText("older edit")).toBeDefined();
		fireEvent.click(getByText("older edit"));
		// Explicit "unavailable" note (no input to reconstruct the operation).
		expect(getByText("coauthor_tool_op_unavailable")).toBeDefined();
		// The full cumulative profile must NOT be printed as a fallback.
		expect(queryByText("A quiet bar.")).toBeNull();
		expect(queryByText(/# EXAMPLES/)).toBeNull();
	});
});

describe("ToolActivityCard — affordances (unchanged)", () => {
	it("shows the streaming label, disables the toggle, and hides the preview", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard activity={activity({ status: "streaming", summary: "Tightening the scenario." })} />,
		);
		expect(getByText("Tightening the scenario.")).toBeDefined();
		expect(getByText("coauthor_tool_streaming")).toBeDefined();
		expect(queryByText(/# PERSONALITY/)).toBeNull();
	});

	it("shows the error label for an errored activity", () => {
		const { getByText } = render(<ToolActivityCard activity={activity({ status: "error", summary: "Rewrite greeting" })} />);
		expect(getByText("Rewrite greeting")).toBeDefined();
		expect(getByText("coauthor_tool_error")).toBeDefined();
	});

	it("falls back to the generic label when the summary is empty/blank", () => {
		const { getByText } = render(<ToolActivityCard activity={activity({ summary: "   " })} />);
		expect(getByText("coauthor_tool_activity")).toBeDefined();
	});
});
