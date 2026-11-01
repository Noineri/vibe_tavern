/**
 * Token-count backfill — TOKEN_COUNT_ONCE_PLAN TC-6.
 *
 * On a seeded temp DB, a full pass must store EXACTLY the expected row set:
 * the cl100k count of every message and variant content (what TC-4 ships on
 * the wire) plus, for a chat whose family tokenizer has a measured separator
 * side, BOTH piece forms (bare + side-glued) of every message and variant
 * piece. Piece texts are verified by FULL-TABLE key equality — the store key
 * is the sha256 of the exact text, so a differently-derived piece (a second
 * trim, a different glue side) cannot match: the expected keys are built in
 * this file through the ONE exported derivations (formatHistoryPiece /
 * buildCoauthorHistoryMessages + formatCoauthorHistoryPieces), and the
 * backfill must have encoded exactly those texts.
 *
 * Also pinned: chats are visited freshest-first (DESC updated_at); no slice
 * exceeds the 15 ms budget (injected clock — never a real sleep); a pass
 * interrupted mid-way (a yield seam that throws — a killed process is a
 * yield that never returns) leaves no marker, and the next pass resumes and
 * completes WITHOUT re-encoding any stored row (encoder spy); with the
 * completion marker present nothing is scanned, read or encoded.
 *
 * Process-sharing (services/api tests share ONE process, files sequential):
 * this file sorts BEFORE tokenizer-service.test.ts, whose fresh-process pins
 * require the web tokenizers to stay UNLOADED — so every model here is a
 * tiktoken rail (gpt-4o → o200k_base, side "after"; gpt-3.5-turbo-0301 →
 * p50k_base, side "before") and this file never warms web tokenizers. The
 * tokenizer-service layer/store globals are restored after every test.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
	TokenCountStore,
	characters,
	createStoreContainer,
	tokenCountKey,
	type Message,
	type StoreContainer,
} from "@vibe-tavern/db";
import { formatHistoryPiece } from "@vibe-tavern/prompt-pipeline";
import {
	countTokens,
	countTokensDefault,
	getTokenCountLayerStatsForTests,
	resetTokenCountLayerForTests,
	resolveTokenizerId,
	setPersistentTokenCountStore,
	tokenCountTextHash,
} from "../src/infrastructure/ai/tokenizer-service.js";
import {
	buildCoauthorHistoryMessages,
	formatCoauthorHistoryPieces,
} from "../src/domain/chat/coauthor-prompt.js";
import {
	runTokenCountBackfill,
	type TokenCountBackfillDeps,
} from "../src/infrastructure/ai/token-count-backfill.js";

const RP_MODEL = "gpt-4o"; // → tiktoken:o200k_base, separator side "after"
const CO_MODEL = "gpt-3.5-turbo-0301"; // → tiktoken:p50k_base, separator side "before"
const CL100K = resolveTokenizerId();
const RP_FAMILY = resolveTokenizerId(RP_MODEL);
const CO_FAMILY = resolveTokenizerId(CO_MODEL);
const MARKER_SQL = "SELECT name FROM app_data_migrations WHERE name = 'token-count-backfill-v1'";

interface World {
	stores: StoreContainer;
	deps: TokenCountBackfillDeps;
	tokenCounts: TokenCountStore;
	rpChatId: string;
	coChatId: string;
	noavChatId: string;
}

async function seedWorld(): Promise<World> {
	const stores = await createStoreContainer(":memory:");
	const now = new Date().toISOString();
	await stores.db
		.insert(characters)
		.values({ id: "char-tc6", name: "TC-6 Fixture", createdAt: now, updatedAt: now })
		.run();

	// ── RP chat: two branches, a system row, multi-variant assistant rows ──
	const rp = await stores.chats.createChat({ characterId: "char-tc6", title: "RP fixture", promptPresetId: null });
	const mainBranch = rp.activeBranchId;
	await stores.messages.addMessage({ chatId: rp.id, branchId: mainBranch, role: "system", authorType: "system", content: "System note: the cafe is warm." });
	await stores.messages.addMessage({ chatId: rp.id, branchId: mainBranch, role: "user", authorType: "user", content: "Alpha user turn one." });
	const assistant = await stores.messages.addMessage({ chatId: rp.id, branchId: mainBranch, role: "assistant", authorType: "character", content: "Beta assistant reply one.", modelId: RP_MODEL });
	await stores.messages.addVariant(assistant.id, "Beta assistant reply two.", undefined, undefined, undefined, RP_MODEL);
	await stores.messages.addMessage({ chatId: rp.id, branchId: mainBranch, role: "user", authorType: "user", content: "Gamma user turn two." });
	await stores.messages.addMessage({ chatId: rp.id, branchId: mainBranch, role: "assistant", authorType: "character", content: "Delta assistant reply.", modelId: RP_MODEL });
	const fork = await stores.chats.forkBranch(rp.id, assistant.id);
	await stores.messages.addMessage({ chatId: rp.id, branchId: fork.id, role: "user", authorType: "user", content: "Forked branch only turn." });

	// ── Co-author chat: flat, tool-call + tool-result rows, a variant swipe ──
	const co = await stores.chats.createChat({ characterId: "char-tc6", title: "Coauthor fixture", promptPresetId: null, mode: "coauthor" });
	const coBranch = co.activeBranchId;
	await stores.messages.addMessage({ chatId: co.id, branchId: coBranch, role: "user", authorType: "user", content: "Editor, make the intro punchier." });
	await stores.messages.addMessage({
		chatId: co.id,
		branchId: coBranch,
		role: "assistant",
		authorType: "character",
		content: "Proposal ready.",
		modelId: CO_MODEL,
		toolCallsJson: JSON.stringify([{ id: "call_1", name: "edit_profile", args: { section: "greeting", text: "Punchier!" } }]),
	});
	await stores.messages.addMessage({ chatId: co.id, branchId: coBranch, role: "tool", authorType: "character", content: "edit queued", toolCallId: "call_1" });
	const closing = await stores.messages.addMessage({ chatId: co.id, branchId: coBranch, role: "assistant", authorType: "character", content: "Done - the intro now lands.", modelId: CO_MODEL });
	await stores.messages.addVariant(closing.id, "Done - the intro lands harder.", undefined, undefined, undefined, CO_MODEL);

	// ── Chat without assistant variants: cl100k rows only, no family pieces ──
	const noav = await stores.chats.createChat({ characterId: "char-tc6", title: "No assistant fixture", promptPresetId: null });
	await stores.messages.addMessage({ chatId: noav.id, branchId: noav.activeBranchId, role: "user", authorType: "user", content: "A quiet solo turn." });
	await stores.messages.addMessage({ chatId: noav.id, branchId: noav.activeBranchId, role: "user", authorType: "user", content: "Another quiet solo turn." });

	// Freshest-first pin: RP (2026-01-03) → co-author (2026-01-02) → noav (2026-01-01).
	for (const [chatId, stamp] of [
		[rp.id, "2026-01-03T00:00:00.000Z"],
		[co.id, "2026-01-02T00:00:00.000Z"],
		[noav.id, "2026-01-01T00:00:00.000Z"],
	] as const) {
		stores.db.$client.run("UPDATE chats SET updated_at = ? WHERE id = ?", stamp, chatId);
	}

	const tokenCounts = new TokenCountStore(stores.db);
	return {
		stores,
		deps: { chats: stores.chats, messages: stores.messages, tokenCounts, db: stores.db },
		tokenCounts,
		rpChatId: rp.id,
		coChatId: co.id,
		noavChatId: noav.id,
	};
}

/**
 * The expected token_counts key→count map, built ONLY from the seeded data
 * through the exported one-derivation helpers. Counts are computed with the
 * memory-only layer (no persistent store injected), then the layer is reset
 * by the caller before the backfill runs.
 */
async function expectedRows(world: World): Promise<Map<string, number>> {
	const { stores } = world;
	const expected = new Map<string, number>();
	const expectRow = (text: string, tokenizerId: string, count: number): void => {
		const hash = tokenCountTextHash(text);
		if (hash === null) throw new Error("fixture text over the persistence cutoff");
		expected.set(tokenCountKey(hash, tokenizerId), count);
	};

	// RP — every branch, every message and variant: cl100k content rows plus
	// both piece forms in the family tokenizer ("after": piece + "\n\n").
	for (const branch of await stores.chats.getBranches(world.rpChatId)) {
		const messages = await stores.messages.getMessages(branch.id);
		const variants = await stores.messages.getVariantsByBranch(branch.id);
		for (const message of messages) {
			const contents = [message.content, ...(variants.get(message.id) ?? []).map((v) => v.content)];
			for (const content of contents) {
				expectRow(content, CL100K, countTokensDefault(content));
				const piece = formatHistoryPiece(message.role, content);
				expectRow(piece, RP_FAMILY, countTokens(piece, RP_MODEL));
				expectRow(`${piece}\n\n`, RP_FAMILY, countTokens(`${piece}\n\n`, RP_MODEL));
			}
		}
	}

	// Co-author — the active branch through the shared mapping: cl100k content
	// rows plus both piece forms ("before": "\n\n" + piece). A VARIANT's piece
	// is the same mapping with that variant's content injected.
	const coChat = await stores.chats.getById(world.coChatId);
	if (coChat === null) throw new Error("co-author fixture chat missing");
	const coMessages = await stores.messages.getMessages(coChat.activeBranchId);
	const coVariants = await stores.messages.getVariantsByBranch(coChat.activeBranchId);
	const addCoPieces = (rows: ReadonlyArray<Message>): void => {
		for (const piece of formatCoauthorHistoryPieces(buildCoauthorHistoryMessages(rows))) {
			expectRow(piece, CO_FAMILY, countTokens(piece, CO_MODEL));
			expectRow(`\n\n${piece}`, CO_FAMILY, countTokens(`\n\n${piece}`, CO_MODEL));
		}
	};
	addCoPieces(coMessages);
	for (const message of coMessages) {
		expectRow(message.content, CL100K, countTokensDefault(message.content));
		for (const variant of coVariants.get(message.id) ?? []) {
			expectRow(variant.content, CL100K, countTokensDefault(variant.content));
			addCoPieces(coMessages.map((m) => (m.id === message.id ? { ...m, content: variant.content } : m)));
		}
	}

	// No-assistant chat: cl100k content rows only — no family pieces at all.
	const noavChat = await stores.chats.getById(world.noavChatId);
	if (noavChat === null) throw new Error("no-assistant fixture chat missing");
	for (const message of await stores.messages.getMessages(noavChat.activeBranchId)) {
		expectRow(message.content, CL100K, countTokensDefault(message.content));
	}
	return expected;
}

interface StoredRow {
	textHash: string;
	tokenizer: string;
	tokenCount: number;
}

async function storedRows(stores: StoreContainer): Promise<Map<string, number>> {
	const rows = stores.db.$client
		.query<StoredRow>("SELECT text_hash AS textHash, tokenizer, token_count AS tokenCount FROM token_counts")
		.all();
	return new Map(rows.map((row) => [tokenCountKey(row.textHash, row.tokenizer), row.tokenCount]));
}

function markerPresent(stores: StoreContainer): boolean {
	return stores.db.$client.query(MARKER_SQL).get() !== null;
}

/** Wires the real store into the counting layer (the TC-2 write-through is
 *  what persists the backfill's encodes) after the expectation phase. */
function wireStoreForBackfill(world: World): void {
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(world.tokenCounts);
}

beforeEach(() => {
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(null);
});

afterEach(() => {
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(null);
});

afterAll(() => {
	resetTokenCountLayerForTests();
	setPersistentTokenCountStore(null);
});

describe("token-count backfill (TC-6)", () => {
	test("a full pass stores exactly the cl100k + family-piece rows, freshest chat first", async () => {
		const world = await seedWorld();
		const expected = await expectedRows(world);
		// The fixture exercises both derivations (RP + co-author incl. tool
		// JSON), both sides ("after" + "before"), a forked branch and both
		// piece forms — ~38 distinct (text, tokenizer) pairs, not a token pass.
		expect(expected.size).toBeGreaterThan(30);

		wireStoreForBackfill(world);
		const stats = await runTokenCountBackfill(world.deps, { yieldToEventLoop: () => Promise.resolve() });

		expect(stats.skippedByMarker).toBe(false);
		expect(stats.markedComplete).toBe(true);
		expect(stats.failedChatIds).toEqual([]);
		// DESC updated_at: the RP chat (2026-01-03) first, noav (2026-01-01) last.
		expect(stats.processedChatIds).toEqual([world.rpChatId, world.coChatId, world.noavChatId]);
		expect(stats.rowsEncoded).toBe(expected.size);
		expect(stats.rowsSkipped).toBe(0);

		const actual = await storedRows(world.stores);
		expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
		for (const [key, count] of expected) expect(actual.get(key)).toBe(count);
		expect(markerPresent(world.stores)).toBe(true);
	});

	test("no slice exceeds the 15 ms budget (injected clock, no sleeps)", async () => {
		const world = await seedWorld();
		const expected = await expectedRows(world);
		wireStoreForBackfill(world);

		let t = 0;
		let yields = 0;
		const stats = await runTokenCountBackfill(world.deps, {
			clock: { now: () => (t += 5) }, // every budget check costs 5 ms of clock time
			yieldToEventLoop: async () => {
				yields += 1;
			},
		});

		expect(stats.markedComplete).toBe(true);
		expect(stats.slices).toBeGreaterThanOrEqual(3); // the mechanism actually trips on this fixture
		expect(stats.sliceDurationsMs.length).toBe(stats.slices);
		expect(yields).toBe(stats.slices);
		// Deterministic ticking clock: at most 3 checks (5+5+5) fit in a slice
		// before it yields — never a 4th, so never 20 ms.
		for (const duration of stats.sliceDurationsMs) expect(duration).toBe(15);
		// The pass still produced the exact full row set under slicing.
		const actual = await storedRows(world.stores);
		expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
	});

	test("a pass interrupted mid-way resumes and completes without re-encoding stored rows", async () => {
		const world = await seedWorld();
		const expected = await expectedRows(world);
		wireStoreForBackfill(world);

		let t = 0;
		let yields = 0;
		await expect(
			runTokenCountBackfill(world.deps, {
				clock: { now: () => (t += 5) },
				yieldToEventLoop: async () => {
					yields += 1;
					if (yields > 2) throw new Error("simulated crash");
				},
			}),
		).rejects.toThrow("simulated crash");

		// Interrupted: rows exist, the marker does not.
		const afterCrash = await storedRows(world.stores);
		expect(afterCrash.size).toBeGreaterThan(0);
		expect(afterCrash.size).toBeLessThan(expected.size);
		expect(markerPresent(world.stores)).toBe(false);

		// Simulated restart: memory layer empty, persistent store intact.
		resetTokenCountLayerForTests();
		const encodesBeforeResume = getTokenCountLayerStatsForTests().encodes;
		const stats = await runTokenCountBackfill(world.deps, {
			clock: { now: () => (t += 5) },
			yieldToEventLoop: () => Promise.resolve(),
		});

		expect(stats.markedComplete).toBe(true);
		expect(stats.rowsSkipped).toBe(afterCrash.size);
		expect(stats.rowsEncoded).toBe(expected.size - afterCrash.size);
		// Encoder spy: exactly the missing rows were encoded — none of the
		// already-stored ones paid an encode again.
		expect(getTokenCountLayerStatsForTests().encodes - encodesBeforeResume).toBe(stats.rowsEncoded);
		expect(markerPresent(world.stores)).toBe(true);

		const actual = await storedRows(world.stores);
		expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
		for (const [key, count] of expected) expect(actual.get(key)).toBe(count);
	});

	test("with the completion marker present, nothing is scanned, read or encoded", async () => {
		const world = await seedWorld();
		wireStoreForBackfill(world);
		await runTokenCountBackfill(world.deps, { yieldToEventLoop: () => Promise.resolve() });
		expect(markerPresent(world.stores)).toBe(true);

		resetTokenCountLayerForTests();
		const stats = await runTokenCountBackfill(world.deps, { yieldToEventLoop: () => Promise.resolve() });
		expect(stats.skippedByMarker).toBe(true);
		expect(stats.chatsScanned).toBe(0);
		expect(stats.processedChatIds).toEqual([]);
		expect(stats.textsConsidered).toBe(0);
		expect(stats.rowsEncoded).toBe(0);
		const layer = getTokenCountLayerStatsForTests();
		expect(layer.encodes).toBe(0); // zero encodes…
		expect(layer.storeReads).toBe(0); // …and zero store reads
	});
});
