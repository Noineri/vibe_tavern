import { describe, expect, it } from "bun:test";
import {
	LoreDraftState,
	defaultLoreDraftIdGen,
	type LoreDraftIdGen,
} from "../src/domain/coauthor/lore/lore-draft-state.js";
import type { CoauthorLoreBundle } from "@vibe-tavern/api-contracts";
import { LOREBOOK_DEFAULTS } from "@vibe-tavern/domain";

/** Deterministic id generator for assertions: lorebook_1, lore_entry_1, ... */
function deterministicIdGen(): LoreDraftIdGen {
	const counters = new Map<string, number>();
	return (prefix) => {
		const n = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, n);
		return `${prefix}_${n}`;
	};
}

function makeDraft() {
	return new LoreDraftState({ idGen: deterministicIdGen() });
}

describe("LoreDraftState — proposal-only draft engine (CTX-L1)", () => {
	it("starts empty (Cancel / abandoned turn leaves no rows)", () => {
		const draft = makeDraft();
		expect(draft.isEmpty()).toBe(true);
		expect(draft.snapshot()).toEqual({ lorebooks: [], entries: [] });
	});

	it("createLorebook rejects an empty name and leaves the draft empty", async () => {
		const draft = makeDraft();
		await expect(draft.createLorebook({ name: "   " })).rejects.toThrow(/name must not be empty/);
		expect(draft.isEmpty()).toBe(true);
	});

	it("applies lorebook defaults (scopeType=character, enabled, empty description)", async () => {
		const draft = makeDraft();
		const bundle = await draft.createLorebook({ name: "World Lore" });
		expect(bundle.lorebooks).toHaveLength(1);
		expect(bundle.lorebooks[0]).toEqual({
			id: "lorebook_1",
			name: "World Lore",
			description: "",
			scopeType: "character",
			enabled: true,
			scanDepth: LOREBOOK_DEFAULTS.scanDepth,
			tokenBudget: LOREBOOK_DEFAULTS.tokenBudget,
			recursiveScanning: LOREBOOK_DEFAULTS.recursiveScanning,
		});
	});

	it("createLorebook honors explicitly-passed activation params (CE-A1)", async () => {
		const draft = makeDraft();
		const bundle = await draft.createLorebook({ name: "Tuned", scanDepth: 25, tokenBudget: 2048, recursiveScanning: true });
		expect(bundle.lorebooks[0]).toMatchObject({
			scanDepth: 25,
			tokenBudget: 2048,
			recursiveScanning: true,
		});
	});

	it("applies entry defaults (before_char / depth 4 / keys [] / constant false)", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "Book" });
		const bundle = await draft.createLoreEntry({ lorebookId: "lorebook_1" });
		expect(bundle.entries).toHaveLength(1);
		expect(bundle.entries[0]).toMatchObject({
			id: "lore_entry_1",
			lorebookId: "lorebook_1",
			title: "",
			content: "",
			keys: [],
			secondaryKeys: [],
			constant: false,
			position: "before_char",
			depth: 4,
			logic: "and_any",
			enabled: true,
		});
	});

	it("returns the COMPLETE cumulative bundle from every mutation", async () => {
		const draft = makeDraft();
		const b1 = await draft.createLorebook({ name: "Book A" });
		expect(b1.lorebooks).toHaveLength(1);
		expect(b1.entries).toHaveLength(0);

		const b2 = await draft.createLoreEntry({ lorebookId: "lorebook_1", title: "Entry 1" });
		// The entry bundle still carries the lorebook from the earlier call —
		// aggregation can never discard earlier entries or fields.
		expect(b2.lorebooks).toHaveLength(1);
		expect(b2.entries).toHaveLength(1);
		expect(b2.lorebooks[0].name).toBe("Book A");

		const b3 = await draft.createLorebook({ name: "Book B" });
		expect(b3.lorebooks).toHaveLength(2);
		expect(b3.entries).toHaveLength(1);
	});

	it("rejects create_lore_entry with a missing parent lorebook (missing-parent)", async () => {
		const draft = makeDraft();
		await expect(draft.createLoreEntry({ lorebookId: "nope", title: "X" })).rejects.toThrow(
			/parent lorebook 'nope' does not exist/,
		);
		expect(draft.snapshot().entries).toHaveLength(0);
	});

	it("dependent calls compose: entry resolves the lorebook drafted earlier in the turn", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "Book" });
		// lorebook_1 was allocated by the prior call; the entry depends on it.
		const bundle = await draft.createLoreEntry({ lorebookId: "lorebook_1" });
		expect(bundle.entries[0].lorebookId).toBe("lorebook_1");
	});

	it("a failed call does NOT poison the queue or corrupt prior state (failed-call rollback)", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "Book" });
		// This fails (missing parent) — it must be discarded, not poison the chain.
		await expect(draft.createLoreEntry({ lorebookId: "ghost" })).rejects.toThrow();
		// A subsequent valid call must still succeed against the last good state.
		const bundle = await draft.createLoreEntry({ lorebookId: "lorebook_1", title: "After fail" });
		expect(bundle.lorebooks).toHaveLength(1);
		expect(bundle.entries).toHaveLength(1);
		expect(bundle.entries[0].title).toBe("After fail");
	});

	it("same-step mutations serialize in call order (non-poisoning queue)", async () => {
		const draft = makeDraft();
		// Issue two lorebook creations WITHOUT awaiting between them. Both must
		// commit (the queue composes them), and ids are allocated in call order.
		const [b1, b2] = await Promise.all([
			draft.createLorebook({ name: "First" }),
			draft.createLorebook({ name: "Second" }),
		]);
		expect(b1.lorebooks).toHaveLength(1);
		// The second call's snapshot reflects BOTH creations (it ran after the
		// first on the serialized queue), so it sees the cumulative state.
		expect(b2.lorebooks).toHaveLength(2);
		// Final state has both books, in insertion order.
		const names = draft.snapshot().lorebooks.map((lb) => lb.name);
		expect(names).toEqual(["First", "Second"]);
	});

	it("setLoreActivation updates activation fields and rejects a missing entry", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "Book" });
		await draft.createLoreEntry({ lorebookId: "lorebook_1" });
		const bundle = await draft.setLoreActivation({ entryId: "lore_entry_1", constant: true });
		expect(bundle.entries[0].constant).toBe(true);
		await expect(draft.setLoreActivation({ entryId: "ghost" })).rejects.toThrow(
			/entry 'ghost' does not exist/,
		);
	});

	it("snapshots are stable: an earlier snapshot is unchanged after a later mutation (immutable replace)", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "Book" });
		await draft.createLoreEntry({ lorebookId: "lorebook_1" });
		const before: CoauthorLoreBundle = draft.snapshot();
		expect(before.entries[0].constant).toBe(false);
		// Mutate activation AFTER capturing the snapshot.
		await draft.setLoreActivation({ entryId: "lore_entry_1", constant: true });
		// The earlier snapshot must NOT have been retroactively mutated.
		expect(before.entries[0].constant).toBe(false);
		expect(draft.snapshot().entries[0].constant).toBe(true);
	});

	it("defaultLoreDraftIdGen produces prefix-tagged unique ids", () => {
		const gen = defaultLoreDraftIdGen();
		const lb = gen("lorebook");
		const le = gen("lore_entry");
		expect(lb).toMatch(/^lorebook_[0-9a-f]{12}$/);
		expect(le).toMatch(/^lore_entry_[0-9a-f]{12}$/);
		expect(lb).not.toBe(le);
	});
});

describe("LoreDraftState — AI-delegation updates (CTX-L2b)", () => {
	it("setLoreEntryContent replaces an entry's content (immutable replace)", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "LB" });
		await draft.createLoreEntry({ lorebookId: "lorebook_1", title: "T" });
		const snap1 = draft.snapshot();

		const snap2 = await draft.setLoreEntryContent({ entryId: "lore_entry_1", content: "AI-generated prose." });
		expect(snap2.entries[0]!.content).toBe("AI-generated prose.");
		// Immutable replace: the earlier snapshot is unaffected (skeleton started empty).
		expect(snap1.entries[0]!.content).toBe("");
	});

	it("setLoreEntryContent rejects a missing entry", async () => {
		const draft = makeDraft();
		await expect(draft.setLoreEntryContent({ entryId: "ghost", content: "x" })).rejects.toThrow(
			/entry 'ghost' does not exist/,
		);
	});

	it("setLoreEntryKeys replaces primary keys and optional secondary keys", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "LB" });
		await draft.createLoreEntry({ lorebookId: "lorebook_1" });

		const snap = await draft.setLoreEntryKeys({
			entryId: "lore_entry_1",
			keys: ["Vex", "commander"],
			secondaryKeys: ["fleet", "rank"],
		});
		expect(snap.entries[0]!.keys).toEqual(["Vex", "commander"]);
		expect(snap.entries[0]!.secondaryKeys).toEqual(["fleet", "rank"]);
	});

	it("setLoreEntryKeys without secondaryKeys leaves secondaryKeys untouched", async () => {
		const draft = makeDraft();
		await draft.createLorebook({ name: "LB" });
		await draft.createLoreEntry({ lorebookId: "lorebook_1" });
		// Seed existing secondary keys via setLoreEntryKeys itself (createLoreEntry is a skeleton now).
		await draft.setLoreEntryKeys({ entryId: "lore_entry_1", keys: [], secondaryKeys: ["keep"] });
		const snap = await draft.setLoreEntryKeys({ entryId: "lore_entry_1", keys: ["a"] });
		expect(snap.entries[0]!.keys).toEqual(["a"]);
		expect(snap.entries[0]!.secondaryKeys).toEqual(["keep"]);
	});

	it("setLoreEntryKeys rejects a missing entry", async () => {
		const draft = makeDraft();
		await expect(draft.setLoreEntryKeys({ entryId: "ghost", keys: [] })).rejects.toThrow(
			/entry 'ghost' does not exist/,
		);
	});
});
