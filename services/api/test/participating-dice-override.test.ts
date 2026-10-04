// «Текущие» honors the chat's own dice selection (LOREBOOK_LIST_FILTERS_REPORT
// step 8): when a chat carries insightsConfig.diceScriptIds, that selection
// REPLACES the binding-resolved dice scripts at runtime (the dice-script-service
// resolution), and the participating answer must show exactly what runs — the
// bound PROMPT scripts plus the selection resolved by the SAME one-source rule
// the Dice runtime reads. These run real in-memory stores through the adapter
// seam (where the reuse lands); the route wiring and the fail-closed 404 are
// pinned by participating-routes.test.ts, the binding core by
// script-participating.test.ts.
import { describe, expect, test } from "bun:test";

import { createDb, ChatStore, ScriptStore, CharacterStore, PersonaStore } from "@vibe-tavern/db";
import type { StoreContainer, StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { ScriptAdapter } from "../src/api/adapters/script-adapter.js";

const fixedClock: StoreClock = { now: () => "2026-10-04T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_dice_ovr_${++counter}` };

async function setup() {
	const db = await createDb(":memory:");
	const scripts = new ScriptStore(db, { content: null, clock: fixedClock, idGenerator: idGen });
	const chats = new ChatStore(db, { clock: fixedClock, idGenerator: idGen });
	const characters = new CharacterStore(db, { clock: fixedClock, idGenerator: idGen });
	const personas = new PersonaStore(db, { clock: fixedClock, idGenerator: idGen });
	const char = await characters.create({ name: "C" });
	const persona = await personas.create({ name: "P" });
	const charOther = await characters.create({ name: "CO" });
	const chat = await chats.createChat({ characterId: char.id, personaId: persona.id, title: "T", promptPresetId: null });
	const adapter = new ScriptAdapter({ chats, scripts } as unknown as StoreContainer);
	return { chats, scripts, chat, adapter, char, charOther };
}

/** Replace only the dice selection on the chat's Insights config, keeping every
 *  other field as the store normalized it. */
async function setDiceSelection(chats: ChatStore, chatId: string, diceScriptIds: string[] | null) {
	const chat = await chats.getById(chatId);
	if (!chat) throw new Error(`chat '${chatId}' disappeared`);
	await chats.updateInsightsConfig(chatId, { insightsConfig: { ...chat.insightsConfig, diceScriptIds } });
}

/**
 * Fixture: a chat-scoped bound dice script, a character-linked bound prompt
 * script, a SELECTED dice script the binding would NOT include (linked to
 * another character), and a selected-but-disabled dice script (the runtime
 * resolution drops disabled ids silently — «Текущие» shows what runs).
 */
async function seedScripts(scripts: ScriptStore, chatId: string, ownerId: string, otherOwnerId: string) {
	await scripts.create({ name: "dice-bound", scopeType: "chat", chatId, enabled: true, scriptKind: "dice", sortOrder: 10 });
	const promptBound = await scripts.create({ name: "prompt-bound", scopeType: "entity", enabled: true, scriptKind: "prompt", sortOrder: 20 });
	await scripts.addLink(promptBound.id, "character", ownerId);
	const diceSelected = await scripts.create({ name: "dice-selected", scopeType: "entity", enabled: true, scriptKind: "dice", sortOrder: 30 });
	await scripts.addLink(diceSelected.id, "character", otherOwnerId);
	const diceSelectedOff = await scripts.create({ name: "dice-selected-off", scopeType: "entity", enabled: false, scriptKind: "dice", sortOrder: 5 });
	return { diceSelected, diceSelectedOff };
}

const names = (list: Array<{ name: string }>) => list.map((s) => s.name);

describe("ScriptAdapter.listParticipatingScripts — chat-local dice selection (step 8)", () => {
	test("without a selection the list stays binding-based (unchanged)", async () => {
		const { chats, scripts, chat, adapter, char, charOther } = await setup();
		await seedScripts(scripts, chat.id, char.id, charOther.id);
		const stored = await chats.getById(chat.id);
		expect(stored?.insightsConfig.diceScriptIds).toBeNull();

		const participating = names(await adapter.listParticipatingScripts(chat.id));
		// Bound dice + bound prompt; the other character's script and the
		// disabled unbound one stay out (script-participating.test.ts policy).
		expect(participating).toEqual(["dice-bound", "prompt-bound"]);
	});

	test("with a selection: exactly the selected dice scripts plus the bound prompt scripts", async () => {
		const { chats, scripts, chat, adapter, char, charOther } = await setup();
		const { diceSelected, diceSelectedOff } = await seedScripts(scripts, chat.id, char.id, charOther.id);
		await setDiceSelection(chats, chat.id, [diceSelected.id, diceSelectedOff.id]);

		const participating = names(await adapter.listParticipatingScripts(chat.id));
		// The bound-but-not-selected dice script is REPLACED by the selection;
		// the selected script the binding excludes (other character's link)
		// participates; the selected disabled id drops (the same resolution the
		// Dice runtime reads); prompt scripts are untouched by the override.
		expect(participating).toEqual(["prompt-bound", "dice-selected"]);
	});

	test("an empty selection removes every dice script; the bound prompt scripts stay", async () => {
		const { chats, scripts, chat, adapter, char, charOther } = await setup();
		await seedScripts(scripts, chat.id, char.id, charOther.id);
		await setDiceSelection(chats, chat.id, []);

		const participating = names(await adapter.listParticipatingScripts(chat.id));
		expect(participating).toEqual(["prompt-bound"]);
	});

	test("returning to null (inherit) restores the binding-based list", async () => {
		const { chats, scripts, chat, adapter, char, charOther } = await setup();
		const { diceSelected } = await seedScripts(scripts, chat.id, char.id, charOther.id);
		await setDiceSelection(chats, chat.id, [diceSelected.id]);
		expect(names(await adapter.listParticipatingScripts(chat.id))).toEqual(["prompt-bound", "dice-selected"]);

		await setDiceSelection(chats, chat.id, null);
		expect(names(await adapter.listParticipatingScripts(chat.id))).toEqual(["dice-bound", "prompt-bound"]);
	});
});
