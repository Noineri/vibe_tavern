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
import { beforeAll, describe, it, expect, mock, afterEach } from "bun:test";
import { useCoauthorTurnStore, type CoauthorToolActivity } from "../../stores/coauthor-turn-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import type { AppMessage } from "../../api/types.js";
import { brandId, type ChatBranchId, type ChatId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");

// Mock useT at the module boundary — the card imports i18n for labels.
// Returns the key verbatim so assertions can match on stable key strings.
mock.module("../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

let CoauthorToolActivitySlot: typeof import("./CoauthorToolActivitySlot.js").CoauthorToolActivitySlot;
let ToolActivityCard: typeof import("./CoauthorToolActivitySlot.js").ToolActivityCard;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ CoauthorToolActivitySlot, ToolActivityCard } = await import("./CoauthorToolActivitySlot.js"));
});

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

afterEach(() => {
	useSnapshotStore.getState().clear();
	useCoauthorTurnStore.setState({ turnsByChat: {} });
});

describe("CoauthorToolActivitySlot — persisted carrier + final response", () => {
	it("renders a selected-variant tool call once with its operation input", () => {
		const chatId = brandId<ChatId>("chat_slot");
		const branchId = brandId<ChatBranchId>("branch_slot");
		const carrierId = brandId<MessageId>("assistant_carrier");
		const toolResultId = brandId<MessageId>("tool_result");
		const finalResponseId = brandId<MessageId>("assistant_final");
		const createdAt = "2026-07-16T00:00:00.000Z";
		const baseMessage = {
			chatId,
			branchId,
			modelId: null,
			sceneTracker: null,
			state: "complete" as const,
			createdAt,
			updatedAt: createdAt,
		};
		const editArgs = { edits: [{ search: "old trait", replace: "new trait" }], summary: "swap" };
		const carrier: AppMessage = {
			...baseMessage,
			id: carrierId,
			role: "assistant",
			authorType: "assistant",
			position: 0,
			content: "",
			variants: [{
				id: brandId<MessageVariantId>("variant_carrier"),
				messageId: carrierId,
				variantIndex: 0,
				content: "",
				isSelected: true,
				finishReason: null,
				createdAt,
				toolCalls: [{ id: "call_edit", name: "edit_personality", args: editArgs }],
				toolCallId: null,
			}],
			selectedVariantIndex: 0,
		};
		const toolResult: AppMessage = {
			...baseMessage,
			id: toolResultId,
			role: "tool",
			authorType: "tool",
			position: 1,
			content: JSON.stringify({ target: "profile", proposed: FULL_PROFILE, summary: "swap" }),
			variants: [{
				id: brandId<MessageVariantId>("variant_result"),
				messageId: toolResultId,
				variantIndex: 0,
				content: "",
				isSelected: true,
				finishReason: null,
				createdAt,
				toolCallId: "call_edit",
			}],
			selectedVariantIndex: 0,
		};
		const finalResponse: AppMessage = {
			...baseMessage,
			id: finalResponseId,
			role: "assistant",
			authorType: "assistant",
			position: 2,
			content: "Done",
			variants: [],
			selectedVariantIndex: null,
		};

		useSnapshotStore.setState({
			messageOrder: [carrier.id, toolResult.id, finalResponse.id],
			messagesById: {
				[carrier.id]: carrier,
				[toolResult.id]: toolResult,
				[finalResponse.id]: finalResponse,
			},
		});
		// Mirrors the observed post-commit state: a live activity remains available
		// for Reviewing, but its persisted carrier is now authoritative for display.
		// It must not be rendered a second time under the final assistant.
		useCoauthorTurnStore.setState({
			turnsByChat: { [chatId]: [activity({ toolCallId: "call_edit", toolName: "edit_personality", summary: "swap", args: undefined })] },
		});

		const { getAllByText, getByText, queryByText } = render(
			<>
				<CoauthorToolActivitySlot chatId={chatId} messageId={carrier.id} isStreaming={false} />
				<CoauthorToolActivitySlot chatId={chatId} messageId={finalResponse.id} isStreaming={false} />
			</>,
		);

		expect(getAllByText("swap")).toHaveLength(1);
		fireEvent.click(getByText("swap"));
		expect(getByText("old trait")).toBeDefined();
		expect(getByText("new trait")).toBeDefined();
		expect(queryByText("coauthor_tool_op_unavailable")).toBeNull();
	});
});

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

describe("ToolActivityCard — lore tool previews (CTX-L3)", () => {
	it("create_lorebook shows the book name + description instead of 'unavailable'", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard activity={activity({
				toolName: "create_lorebook",
				summary: "Drafted a new lorebook.",
				args: { name: "Castle Anvil", description: "Seat of the crown.", summary: "Drafted a new lorebook." },
			})} />,
		);
		fireEvent.click(getByText("Drafted a new lorebook."));
		expect(getByText("coauthor_tool_op_lore_book")).toBeDefined();
		expect(getByText(/Castle Anvil/)).toBeDefined();
		expect(getByText(/Seat of the crown\./)).toBeDefined();
		expect(queryByText("coauthor_tool_op_unavailable")).toBeNull();
	});

	it("create_lore_entry shows activation keys as chips + the entry content", () => {
		const { getByText } = render(
			<ToolActivityCard activity={activity({
				toolName: "create_lore_entry",
				summary: "Added the Castle entry.",
				args: { lorebookId: "lb1", title: "Castle", content: "An ancient stronghold.", keys: ["castle", "fortress"], summary: "Added the Castle entry." },
			})} />,
		);
		fireEvent.click(getByText("Added the Castle entry."));
		expect(getByText("coauthor_tool_op_lore_entry")).toBeDefined();
		expect(getByText("castle")).toBeDefined();
		expect(getByText("fortress")).toBeDefined();
		expect(getByText("An ancient stronghold.")).toBeDefined();
	});

	it("ai_write_lore_entry shows the delegated instruction brief", () => {
		const { getByText } = render(
			<ToolActivityCard activity={activity({
				toolName: "ai_write_lore_entry",
				summary: "Wrote the backstory.",
				args: { entryId: "e1", instruction: "Cover the originating incident and the sensory trigger.", summary: "Wrote the backstory." },
			})} />,
		);
		fireEvent.click(getByText("Wrote the backstory."));
		expect(getByText("coauthor_tool_op_lore_write")).toBeDefined();
		expect(getByText("Cover the originating incident and the sensory trigger.")).toBeDefined();
	});

	it("ai_generate_lore_keys shows keyTarget + mode params (default both / replace)", () => {
		const { getByText } = render(
			<ToolActivityCard activity={activity({
				toolName: "ai_generate_lore_keys",
				summary: "Generated activation keys.",
				args: { entryId: "e1", summary: "Generated activation keys." },
			})} />,
		);
		fireEvent.click(getByText("Generated activation keys."));
		expect(getByText("coauthor_tool_op_lore_keys")).toBeDefined();
		expect(getByText("ai_quickpill_key_target_both")).toBeDefined();
		expect(getByText("coauthor_tool_op_replace")).toBeDefined();
	});

	it("ai_generate_lore_keys reflects keyTarget=primary + appendMode (augment)", () => {
		const { getByText, queryByText } = render(
			<ToolActivityCard activity={activity({
				toolName: "ai_generate_lore_keys",
				summary: "Added primary triggers.",
				args: { entryId: "e1", keyTarget: "primary", appendMode: true, summary: "Added primary triggers." },
			})} />,
		);
		fireEvent.click(getByText("Added primary triggers."));
		expect(getByText("ai_quickpill_key_target_primary")).toBeDefined();
		expect(getByText("ai_quickpill_append")).toBeDefined();
		expect(queryByText("ai_quickpill_key_target_secondary")).toBeNull();
	});

	it("set_lore_activation shows the constant toggle", () => {
		const { getByText } = render(
			<ToolActivityCard activity={activity({
				toolName: "set_lore_activation",
				summary: "Made the entry constant.",
				args: { entryId: "e1", constant: true, summary: "Made the entry constant." },
			})} />,
		);
		fireEvent.click(getByText("Made the entry constant."));
		expect(getByText("coauthor_tool_op_lore_activation")).toBeDefined();
		expect(getByText("coauthor_tool_op_lore_constant")).toBeDefined();
	});
});

	describe("ToolActivityCard — read_skill_file activity (CTX-S6)", () => {
		it("renders the read path as the title with NO error label (a done read, not an error)", () => {
			const { getByText, queryByText } = render(
				<ToolActivityCard
					activity={activity({
						toolName: "read_skill_file",
						status: "done",
						summary: undefined,
						target: undefined,
						proposed: undefined,
						readPath: "general-writing/SKILL.md",
					})}
				/>,
			);
			expect(getByText("general-writing/SKILL.md")).toBeDefined();
			// The pre-S6 path flagged reads as error because {path,content} failed the
			// proposal schema. A done read must render cleanly with no error label.
			expect(queryByText("coauthor_tool_error")).toBeNull();
		});

		it("is not expandable — no operation preview renders on click", () => {
			const { getByText, queryByText } = render(
				<ToolActivityCard
					activity={activity({
						toolName: "read_skill_file",
						status: "done",
						summary: undefined,
						target: undefined,
						proposed: undefined,
						readPath: "general-writing/references/rules.md",
					})}
				/>,
			);
			fireEvent.click(getByText("general-writing/references/rules.md"));
			// Reads have no SEARCH/REPLACE/body preview (the path IS the label).
			expect(queryByText("coauthor_tool_op_unavailable")).toBeNull();
			expect(queryByText("coauthor_tool_op_section_write")).toBeNull();
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
