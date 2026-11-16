/**
 * Step 8 of reports/st-macro-parity.md — the card import path surfaces the
 * dropped-ST-macro warning. `importJson` is the single-card import entry (and
 * the batch path loops it), so a card whose text fields use a macro VT
 * deliberately does not support (e.g. {{lastSwipeId}}) must return the warning
 * «Macro {{lastSwipeId}} is not supported in VT — use scripts instead.» in
 * `imported.warnings` alongside the existing parse warnings, while supported
 * macros (the whole registry, incl. every step 3–7 name) never warn.
 *
 * The scan runs HERE (services/api), not inside the import-export parser:
 * the checker needs the prompt-pipeline macro registry and packages stay
 * domain-only below this layer (st-macro-parity step 8, unit 22).
 */
import { describe, expect, mock, test } from "bun:test";
import type { CreateCharacterData } from "@vibe-tavern/db";
import type { ChatId } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import type { CreateChatRequest } from "../src/domain/chat/chat-application-types.js";
import { importJson } from "../src/runtime/session/session-runtime-import-export.js";
import { makeImportExportDeps } from "./import-test-builders.js";
import { makeCharacterRow } from "./copilot-test-builders.js";

// Inline per-file factory (testing-skill contract); mirrors the stub shape of
// import-lean.test.ts — only the store methods importJson actually touch, the
// rest rides makeImportExportDeps' labeled-miss defaults.
function makeDeps() {
	return makeImportExportDeps(
		{
			characters: {
				create: mock((_data: CreateCharacterData) =>
					Promise.resolve(makeCharacterRow("char_test_123")),
				),
			},
			chatApp: {
				createChat: mock((_input: CreateChatRequest) =>
					Promise.resolve({ id: brandId<ChatId>("chat_test_456"), activeBranchId: "br_test_789" }),
				),
			},
		},
		"ImportExportModuleDeps (import-dropped-macro-warning)",
	);
}

function cardJson(fields: Record<string, string>): string {
	return JSON.stringify({
		spec: "chara_card_v3",
		spec_version: "3.0",
		data: { name: "Macro Card", first_mes: "Hello!", scenario: "A scene", ...fields },
	});
}

describe("importJson — dropped-ST-macro warning (st-macro-parity step 8)", () => {
	test("a card using {{lastSwipeId}} returns the not-supported warning", async () => {
		const result = await importJson(makeDeps(), {
			fileName: "card.json",
			jsonText: cardJson({ description: "State: {{lastSwipeId}}" }),
			lean: true,
		});

		expect(result.imported.warnings).toContain(
			"Macro {{lastSwipeId}} is not supported in VT — use scripts instead.",
		);
		expect(result.imported.warningCount).toBe(result.imported.warnings.length);
	});

	test("a card using only supported macros (incl. step-7 names) is never warned", async () => {
		const result = await importJson(makeDeps(), {
			fileName: "card.json",
			jsonText: cardJson({
				description: "{{charPrompt}} {{systemPrompt}} {{datetimeformat::%H}} {{pick::a::b}}",
				first_mes: "{{user}}, welcome to {{char}}'s {{roll 1d20}}",
			}),
			lean: true,
		});

		expect(result.imported.warnings).toEqual([]);
		expect(result.imported.warningCount).toBe(0);
	});
});
