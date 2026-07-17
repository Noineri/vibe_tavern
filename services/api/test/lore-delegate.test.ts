/**
 * CTX-L2b — lore AI-delegation unit tests.
 *
 * Pins `createLoreDelegate` (the isolated one-shot LLM call that reuses the
 * standalone AI-assistant lore system-prompt assets) and `parseLoreKeysJson`.
 * The executor is mocked; the system-prompt assets are loaded for real so the
 * test also verifies the delegate wires the reused asset + a grounding block +
 * the mirrored buildUserMessage user turn.
 */
import { describe, expect, it } from "bun:test";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import {
	createLoreDelegate,
	parseLoreKeysJson,
	type LoreDelegateInput,
	type LoreExecutor,
} from "../src/domain/coauthor/lore/lore-delegate.js";

/** A fake resolved profile (the executor only reads it opaquely here). */
const fakeProfile = { id: "prof_1", name: "p", providerType: "openai" } as ProviderExecutionInput["profile"];

/** Build a representative delegation input for a drafted entry. */
function sampleInput(kind: LoreDelegateInput["kind"]): LoreDelegateInput {
	return {
		kind,
		characterProfileMd: "# PERSONALITY\nVex is a commander.",
		lorebookName: "Bridge Crew",
		lorebookDescription: "Officers of the flagship.",
		entryId: "lore_entry_1",
		entryTitle: "Lieutenant Commander Vex",
		entryContent: "Vex commands the bridge.",
		entryKeys: ["Vex"],
		entrySecondaryKeys: [],
		instruction: "Write her command style and reputation.",
		keyTarget: "both",
		logic: "and_any",
	};
}

/** Read the messages the delegate handed to the executor. */
function messagesOf(prompt: ProviderExecutionInput["prompt"]): Array<{ role: string; content: string }> {
	const fp = prompt.finalPayload as { messages?: Array<{ role: string; content: string }> };
	return fp.messages ?? [];
}

describe("parseLoreKeysJson (CTX-L2b)", () => {
	it("parses a clean {keys, secondaryKeys} object", () => {
		const r = parseLoreKeysJson('{"keys":["Vex","commander"],"secondaryKeys":["fleet","rank"]}');
		expect(r).toEqual({ keys: ["Vex", "commander"], secondaryKeys: ["fleet", "rank"] });
	});

	it("strips markdown fences", () => {
		const r = parseLoreKeysJson('```json\n{"keys":["a"],"secondaryKeys":[]}\n```');
		expect(r).toEqual({ keys: ["a"], secondaryKeys: [] });
	});

	it("extracts the JSON object from surrounding prose", () => {
		const r = parseLoreKeysJson('Here you go:\n{"keys":["a","b"],"secondaryKeys":[]}\nDone.');
		expect(r.keys).toEqual(["a", "b"]);
	});

	it("trims and drops empty entries", () => {
		const r = parseLoreKeysJson('{"keys":["a","","  b  "],"secondaryKeys":[]}');
		expect(r.keys).toEqual(["a", "b"]);
	});

	it("throws on non-JSON", () => {
		expect(() => parseLoreKeysJson("not json at all")).toThrow(/did not return a JSON object/);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseLoreKeysJson("{keys: [unquoted]}")).toThrow(/malformed JSON/);
	});

	it("throws when both key arrays are empty", () => {
		expect(() => parseLoreKeysJson('{"keys":[],"secondaryKeys":[]}')).toThrow(/no keys/);
	});
});

describe("createLoreDelegate (CTX-L2b)", () => {
	it("write_entry: returns generated content and reuses the assistant lore-entry asset + grounding", async () => {
		let captured: ProviderExecutionInput | null = null;
		const execute: LoreExecutor = async (input) => {
			captured = input;
			return { text: "A crisp, unhurried commander who never raises her voice." };
		};
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "small-model" });
		const result = await delegate(sampleInput("write_entry"));

		expect(result.content).toBe("A crisp, unhurried commander who never raises her voice.");
		expect(result.keys).toBeUndefined();

		// The system prompt reuses the standalone assistant asset (the Role
		// heading is unique to lore-entry-ai-prompt.md) and appends a grounding
		// block carrying the live character card + lorebook meta.
		const msgs = messagesOf(captured!.prompt);
		expect(msgs[0]!.role).toBe("system");
		expect(msgs[0]!.content).toContain("expert worldbuilding assistant");
		expect(msgs[0]!.content).toContain("Grounding (co-author delegation)");
		expect(msgs[0]!.content).toContain("Vex is a commander.");
		expect(msgs[0]!.content).toContain("Bridge Crew");
		// The user message mirrors the assistant's buildUserMessage (lore_entry).
		expect(msgs[1]!.role).toBe("user");
		// The user message mirrors the assistant's buildUserMessage (lore_entry) —
		// the existing-content branch fires because the drafted entry has content.
		expect(msgs[1]!.content).toContain("Return the complete updated lorebook entry content only");
		expect(msgs[1]!.content).toContain("Modification request:");
		expect(msgs[1]!.content).toContain("Write her command style and reputation.");
		// The delegate bound the configured (optionally smaller) model.
		expect(captured!.model).toBe("small-model");
		expect(captured!.overrideMaxTokens).toBeGreaterThan(0);
	});

	it("write_entry: throws on empty generated content", async () => {
		const execute: LoreExecutor = async () => ({ text: "   " });
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "m" });
		await expect(delegate(sampleInput("write_entry"))).rejects.toThrow(/empty content/);
	});

	it("generate_keys: parses {keys, secondaryKeys} and forwards them", async () => {
		let captured: ProviderExecutionInput | null = null;
		const execute: LoreExecutor = async (input) => {
			captured = input;
			return { text: '{"keys":["Vex","commander","lieutenant"],"secondaryKeys":["bridge","orders","fleet"]}' };
		};
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "m" });
		const result = await delegate(sampleInput("generate_keys"));

		expect(result.keys).toEqual(["Vex", "commander", "lieutenant"]);
		expect(result.secondaryKeys).toEqual(["bridge", "orders", "fleet"]);

		// The user message mirrors buildUserMessage (lore_keys): the entry
		// content, the AND_ANY logic line, and the existing-keys dedup directive.
		const user = messagesOf(captured!.prompt)[1]!.content;
		expect(user).toContain("Generate activation keys for this lorebook entry");
		expect(user).toContain("Vex commands the bridge.");
		expect(user).toContain("Logic mode: and_any");
		expect(user).toContain('Existing primary keys (do NOT duplicate)');
		// The system prompt reuses lore-keys-ai-prompt.md.
		expect(messagesOf(captured!.prompt)[0]!.content).toContain("lexical analysis AI");
	});

	it("generate_keys: keyTarget=primary emits the only-primary directive (mirrors the manual lore_keys flow)", async () => {
		let captured: ProviderExecutionInput | null = null;
		const execute: LoreExecutor = async (input) => {
			captured = input;
			return { text: '{"keys":["Vex"],"secondaryKeys":[]}' };
		};
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "m" });
		const input = { ...sampleInput("generate_keys"), keyTarget: "primary" as const, instruction: "" };
		await delegate(input);

		const user = messagesOf(captured!.prompt)[1]!.content;
		expect(user).toContain("Target: generate ONLY primary keys. Return secondaryKeys as an empty array.");
		// No secondary-only directive.
		expect(user).not.toContain("ONLY secondary keys");
	});

	it("generate_keys: keyTarget=secondary emits the only-secondary directive", async () => {
		let captured: ProviderExecutionInput | null = null;
		const execute: LoreExecutor = async (input) => {
			captured = input;
			return { text: '{"keys":[],"secondaryKeys":["bridge"]}' };
		};
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "m" });
		const input = { ...sampleInput("generate_keys"), keyTarget: "secondary" as const };
		await delegate(input);

		const user = messagesOf(captured!.prompt)[1]!.content;
		expect(user).toContain("Target: generate ONLY secondary keys. Return keys as an empty array.");
		expect(user).not.toContain("ONLY primary keys");
	});

	it("generate_keys: a non-empty instruction is appended as 'Additional instruction'", async () => {
		let captured: ProviderExecutionInput | null = null;
		const execute: LoreExecutor = async (input) => {
			captured = input;
			return { text: '{"keys":["Vex"],"secondaryKeys":[]}' };
		};
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "m" });
		const input = { ...sampleInput("generate_keys"), instruction: "Prefer nouns and ranks." };
		await delegate(input);

		expect(messagesOf(captured!.prompt)[1]!.content).toContain("Additional instruction: Prefer nouns and ranks.");
	});

	it("generate_keys: rejects on non-JSON output", async () => {
		const execute: LoreExecutor = async () => ({ text: "Vex, commander, bridge" });
		const delegate = createLoreDelegate({ execute, profile: fakeProfile, model: "m" });
		await expect(delegate(sampleInput("generate_keys"))).rejects.toThrow(/JSON/);
	});
});
