/**
 * Characterization test for ST JSONL chat import: which swipe survives the
 * round-trip. Per AGENTS.md §1 this was written BEFORE the fix, against the
 * current (buggy) behaviour, so the boundary it pins is the one the bug lives
 * on — `importJson` → `importSillyTavernChat` against the REAL MessageStore
 * (not a stub), exactly the path the user hits with "export chat → import back".
 *
 * The bug: `importSillyTavernChat` rebuilt each message's variants one at a time
 * (`addMessage(variants[0])` then `addVariant(slice(1))`). Every `addVariant`
 * deselects the prior and selects itself, so after the loop the implicit
 * selection was the LAST swipe. It then tried to restore the real one via
 * `findIndex(v => v.content === selected.content)` gated on `selectedIndex > 0`
 * — which (a) never runs when the chosen swipe was index 0, leaving the LAST
 * swipe selected, and (b) matches by text, so duplicate-content swipes resolve
 * to the first match. A separate fallout: `addMessage` takes no `reasoning`, so
 * the chosen variant 0 lost its `<thinking>` on import.
 *
 * These cases must hold after the fix for every chosen position, and for
 * reasoning on variant 0.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
	createDb,
	MessageStore,
	ChatStore,
	characters,
	type StoreClock,
	type StoreIdGenerator,
} from "@vibe-tavern/db";
import { serializeSillyTavernChat } from "@vibe-tavern/import-export";
import {
	importJson,
	type ImportExportModuleDeps,
} from "../src/runtime/session/session-runtime-import-export.js";

const FIXED_NOW = "2025-05-04T12:00:00.000Z";
let clockTick = 0;
const testClock: StoreClock = { now() { clockTick++; return new Date(Date.parse(FIXED_NOW) + clockTick).toISOString(); } };
let idCounters = new Map<string, number>();
const testIdGen: StoreIdGenerator = {
	next(prefix: string) {
		const n = (idCounters.get(prefix) ?? 0) + 1;
		idCounters.set(prefix, n);
		return `${prefix}_test_${String(n).padStart(4, "0")}`;
	},
};

type Db = Awaited<ReturnType<typeof createDb>>;

/** Build ST JSONL for ONE assistant message with the given swipes + chosen index. */
function jsonl(swipes: string[], swipeId: number): string {
	const chosen = swipes[swipeId] ?? swipes[0]!;
	return serializeSillyTavernChat({
		userName: "User",
		characterName: "Bot",
		messages: [
			{
				name: "Bot",
				isUser: false,
				isSystem: false,
				content: chosen,
				sendDate: "1000",
				swipes: swipes.length > 1 ? swipes : undefined,
				swipeId: swipes.length > 1 ? swipeId : undefined,
			},
		],
	});
}

let db: Db;
let messages: MessageStore;
let chatStore: ChatStore;

beforeEach(async () => {
	db = await createDb(":memory:");
	clockTick = 0;
	idCounters = new Map();
	chatStore = new ChatStore(db, { clock: testClock, idGenerator: testIdGen });
	messages = new MessageStore(db, { clock: testClock, idGenerator: testIdGen });
	db.insert(characters).values({
		id: "char_1", name: "Bot", description: "",
		alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
		status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
	}).run();
});

/**
 * Real MessageStore + minimal stub deps. `chatStore` is real so sourceChat
 * resolves; `chatApp.createChat` returns an ALREADY-CREATED target chat so the
 * branch the messages land on satisfies the FK (mirrors what the real
 * ChatApplicationService does).
 */
async function importInto(jsonlText: string) {
	const sourceChat = await chatStore.createChat({ characterId: "char_1", title: "source", promptPresetId: null });
	const targetChat = await chatStore.createChat({ characterId: "char_1", title: "target", promptPresetId: null });

	const deps = {
		stores: { chats: chatStore, messages },
		chatApp: { createChat: mock(() => Promise.resolve(targetChat)) },
		chatOrder: { add: mock(() => {}) },
		resolveDefaultPersonaId: mock(() => Promise.resolve("persona_default" as never)),
		resolveDefaultPromptPresetId: mock(() => Promise.resolve("preset_default" as never)),
		getSnapshot: mock(() => Promise.resolve({ chats: [], messages: [] } as never)),
		seedImportedOpening: mock(() => Promise.resolve()),
		resolver: {},
		fileStore: {},
	} as unknown as ImportExportModuleDeps;

	await importJson(deps, { fileName: "chat.jsonl", jsonText: jsonlText, chatId: sourceChat.id, lean: true });

	const imported = await messages.getMessages(targetChat.activeBranchId);
	expect(imported).toHaveLength(1);
	const variants = await messages.getVariants(imported[0]!.id);
	const selected = await messages.getSelectedVariant(imported[0]!.id);
	return { variants, selected };
}

describe("importJson (.jsonl) — chosen swipe survives the round-trip", () => {
	test("the FIRST swipe stays selected when it was the chosen one", async () => {
		const { variants, selected } = await importInto(jsonl(["Reply A", "Reply B", "Reply C"], 0));
		expect(variants).toHaveLength(3);
		expect(variants.map((v) => v.content)).toEqual(["Reply A", "Reply B", "Reply C"]);
		expect(selected?.variantIndex).toBe(0);
		expect(selected?.content).toBe("Reply A");
	});

	test("the MIDDLE swipe stays selected when it was the chosen one", async () => {
		const { selected } = await importInto(jsonl(["Reply A", "Reply B", "Reply C"], 1));
		expect(selected?.variantIndex).toBe(1);
		expect(selected?.content).toBe("Reply B");
	});

	test("the LAST swipe stays selected when it was the chosen one", async () => {
		const { selected } = await importInto(jsonl(["Reply A", "Reply B", "Reply C"], 2));
		expect(selected?.variantIndex).toBe(2);
		expect(selected?.content).toBe("Reply C");
	});

	test("preserves reasoning on the chosen variant 0 (lost via the old addMessage path)", async () => {
		const { variants, selected } = await importInto(
			jsonl(["<thinking>chain-of-thought</thinking>Reply A", "Reply B"], 0),
		);
		expect(selected?.variantIndex).toBe(0);
		expect(variants[0]?.reasoning).toBe("chain-of-thought");
	});

	test("resolves by position, not by text, when two swipes share content", async () => {
		// Two identical swipes; the chosen one is index 1. A text-based lookup
		// resolves the first match and — combined with the `> 0` gate — left the
		// wrong one (or the last) selected.
		const { selected } = await importInto(jsonl(["Same", "Same"], 1));
		expect(selected?.variantIndex).toBe(1);
	});
});
