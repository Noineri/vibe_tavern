import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mulberry32 } from "./calibrate-fly-tribunal.js";
import {
	applicableTransforms,
	applySyntheticTransform,
	benignReformat,
	buildSyntheticCorpus,
	extractBasePool,
	isFullDefect,
	latinLetterShare,
	selectVariantIndex,
	splitPoolHoldout,
	FLY_SYNTHETIC_PROFILES,
	type FlySyntheticBase,
} from "./generate-fly-synthetic-corpus.js";

/**
 * FT-18R synthetic corpus generator tests. Pure logic + one in-memory SQLite
 * DB (no files, no fixtures on disk).
 *
 * L1 checklist:
 * 1. Paths: none — the DB is `:memory:`, everything else is pure functions.
 * 2. Restores: no globals, registries, env vars, or mocks are touched.
 * 3. Determinism: every assertion reads a completed seeded computation.
 * 4. Platform: no paths, separators, or OS assumptions.
 * 5. Shared worker pool: scripts tests share one process — no module mocks,
 *    no mutable module-level state is exercised.
 * 6. Stable state: assertions inspect returned structures only.
 */

const SHORT_PARA = "Right.";

const BASE_TEXT = [
	"— Stay exactly where you are, — she said quietly, not turning around. Her voice was calm the way a frozen lake is calm: perfectly even, hiding an unknowable depth beneath.",
	"He stopped in the doorway, one hand still on the frame. The corridor behind him stretched long and dim, and somewhere far below the building settled with a slow metallic sigh, the way old places do when they think nobody is listening anymore.",
	SHORT_PARA,
].join("\n\n");

const EARLIER_PARAGRAPH =
	"The rain had started an hour before dawn and had not stopped since; the windows wept with it, streaking the city lights into long smears of amber that climbed the opposite wall and died at the ceiling.";

function makeBase(overrides: Partial<FlySyntheticBase> = {}): FlySyntheticBase {
	const text = overrides.text ?? BASE_TEXT;
	const earlierParagraphs = overrides.earlierParagraphs ?? [EARLIER_PARAGRAPH];
	return {
		id: overrides.id ?? "b-000001",
		text,
		chatId: overrides.chatId ?? "chat-1",
		earlierParagraphs,
		applicable: applicableTransforms(text, earlierParagraphs),
	};
}

/** A pool of distinct crafted bases (distinct dedupe keys, same shape). */
function craftedPool(count: number): FlySyntheticBase[] {
	return Array.from({ length: count }, (_, index) =>
		makeBase({ id: `b-${String(index).padStart(6, "0")}`, text: `${BASE_TEXT}\n\nVariant number ${index} of the crafted pool.` }),
	);
}

describe("FT-18R corpus generator: transforms", () => {
	test("monologue inserts an italic thought paragraph", () => {
		const base = makeBase();
		const result = applySyntheticTransform(base, "monologue", mulberry32(1))!;
		expect(result).not.toBe(base.text);
		expect(result.split(/\n\s*\n/).length).toBe(base.text.split(/\n\s*\n/).length + 1);
		expect(result).toMatch(/\*[A-Z].*\*$/m);
	});

	test("mild monologue appends the one-line thought", () => {
		const result = applySyntheticTransform(makeBase(), "monologue-mild", mulberry32(1))!;
		expect(result.endsWith("*Not for the first time, he wondered whether this was progress.*")).toBe(true);
	});

	test("duplication repeats the longest paragraph verbatim; mild repeats only short ones", () => {
		const base = makeBase();
		const paragraphs = base.text.split(/\n\s*\n/).map((p) => p.trim());
		const longest = paragraphs.reduce((a, b) => (b.length > a.length ? b : a));
		const duplicated = applySyntheticTransform(base, "duplication", mulberry32(1))!;
		expect(duplicated.split(longest).length).toBe(3); // two occurrences

		const mild = applySyntheticTransform(base, "duplication-mild", mulberry32(1))!;
		expect(mild.split(SHORT_PARA).length).toBe(3);

		const longOnly = makeBase({ text: [longest, longest.slice(0, 200)].join("\n\n") });
		expect(applySyntheticTransform(longOnly, "duplication-mild", mulberry32(1))).toBeNull();
	});

	test("truncation cuts mid-sentence without a terminator", () => {
		const base = makeBase();
		const result = applySyntheticTransform(base, "truncation", mulberry32(3))!;
		expect(result.length).toBeGreaterThan(base.text.length * 0.4);
		expect(result.length).toBeLessThan(base.text.length * 0.82);
		expect(/[.!?…"'»”]$/.test(result.trimEnd())).toBe(false);
		expect(result).not.toBe(base.text);
	});

	test("tag leak appends a real generation artifact", () => {
		const result = applySyntheticTransform(makeBase(), "tag-leak", mulberry32(5))!;
		expect(["</reasoning_", "[End of Response]", "</think>", "[end of message]"].some((artifact) => result.endsWith(artifact))).toBe(true);
	});

	test("history repetition appends an earlier same-chat paragraph", () => {
		const result = applySyntheticTransform(makeBase(), "history-repetition", mulberry32(5))!;
		expect(result.endsWith(EARLIER_PARAGRAPH)).toBe(true);
	});

	test("description converts dialogue lines to narration frames", () => {
		const result = applySyntheticTransform(makeBase(), "description", mulberry32(5))!;
		expect(result.split(/\n/).every((line) => !/^[—–]\s/.test(line.trim()))).toBe(true);
		expect(result).toMatch(/said that|answered that|replied that|murmured that/);
	});

	test("bloat and bloat-mild grow the text", () => {
		const base = makeBase();
		const bloat = applySyntheticTransform(base, "bloat", mulberry32(7))!;
		expect(bloat.length).toBeGreaterThan(base.text.length * 1.4);
		const mild = applySyntheticTransform(base, "bloat-mild", mulberry32(7))!;
		expect(mild.length).toBeGreaterThan(base.text.length);
	});

	test("benign reformat always changes the text", () => {
		const rich = "One... two\n\nthree — four";
		expect(benignReformat(rich)).not.toBe(rich);
		expect(benignReformat("plain text without markup")).toBe("plain text without markup\n");
	});

	test("latin letter share separates EN, RU, and mixed text", () => {
		expect(latinLetterShare("Hello world")).toBe(1);
		expect(latinLetterShare("Привет мир")).toBe(0);
		const mixed = latinLetterShare("Hello Привет");
		expect(mixed).toBeGreaterThan(0.3);
		expect(mixed).toBeLessThan(0.7);
	});
});

describe("FT-18R corpus generator: labeling", () => {
	const terse = FLY_SYNTHETIC_PROFILES.find((profile) => profile.id === "terse")!;
	const reader = FLY_SYNTHETIC_PROFILES.find((profile) => profile.id === "reader")!;

	test("rejected-class defects are never selected", () => {
		expect(selectVariantIndex(["monologue", null], terse.rulesAt("A"), mulberry32(1))).toBe(1);
		expect(selectVariantIndex(["duplication", "history-repetition", null], reader.rulesAt("A"), mulberry32(1))).toBe(2);
	});

	test("preferred defects win; tolerated defects always beat the clean base", () => {
		expect(selectVariantIndex(["bloat", null], reader.rulesAt("A"), mulberry32(1))).toBe(0);
		expect(selectVariantIndex(["tag-leak", null], terse.rulesAt("A"), mulberry32(1))).toBe(0);
	});

	test("tolerated kinds beat rejected kinds in one batch", () => {
		expect(selectVariantIndex(["duplication", "monologue", null], reader.rulesAt("A"), mulberry32(1))).toBe(1);
	});

	test("all-clean batches use the seeded coin", () => {
		expect(selectVariantIndex([null, null], terse.rulesAt("A"), () => 0.1)).toBe(0);
		expect(selectVariantIndex([null, null], terse.rulesAt("A"), () => 0.9)).toBe(1);
	});
});

describe("FT-18R corpus generator: base pool extraction", () => {
	function makeDb(): Database {
		const db = new Database(":memory:");
		db.run("CREATE TABLE messages (id TEXT, chat_id TEXT, position INTEGER, role TEXT, created_at TEXT, content TEXT)");
		db.run("CREATE TABLE message_variants (message_id TEXT, variant_index INTEGER, content TEXT, is_selected INTEGER)");
		return db;
	}

	function insertKept(db: Database, id: string, chatId: string, position: number, variant: string, final: string | null): void {
		db.run("INSERT INTO messages VALUES (?, ?, ?, 'assistant', ?, ?)", [id, chatId, position, "2026-01-01T00:00:00Z", final]);
		db.run("INSERT INTO message_variants VALUES (?, 0, ?, 1)", [id, variant]);
	}

	test("extracts accepted replies with edits, filters, and earlier-chat history", () => {
		const db = makeDb();
		const firstAccepted = `${BASE_TEXT}\n\nExtra filler paragraph to push this over the length window comfortably for the earlier-history check that follows below.`;
		insertKept(db, "m1", "chatA", 1, firstAccepted, null);
		const editedFinal = `${BASE_TEXT}\n\nEdited final content that wins over the raw variant because she saved an edit.`;
		insertKept(db, "m2", "chatA", 2, "raw variant body", editedFinal);
		insertKept(db, "m3", "chatA", 3, "Совершенно русский текст, который должен быть отфильтрован латинским фильтром.", null);
		insertKept(db, "m4", "chatB", 1, firstAccepted, null); // duplicate of m1's text
		insertKept(db, "m5", "chatB", 2, "Too short.", null);

		const bases = extractBasePool(db);
		expect(bases.map((base) => base.text)).toEqual([firstAccepted, editedFinal]);
		expect(bases[0]!.id).toBe("b-000000");
		const second = bases[1]!;
		expect(second.earlierParagraphs.some((paragraph) => firstAccepted.includes(paragraph))).toBe(true);
		db.close();
	});
});

describe("FT-18R corpus generator: corpus assembly", () => {
	test("deterministic for a fixed seed and pool", () => {
		const pool = craftedPool(60);
		const first = buildSyntheticCorpus(pool, { seed: 42, targetEvents: 200 });
		const repeat = buildSyntheticCorpus(pool, { seed: 42, targetEvents: 200 });
		first.meta.generatedAtUtc = "";
		repeat.meta.generatedAtUtc = "";
		expect(JSON.stringify(repeat)).toBe(JSON.stringify(first));

		const other = buildSyntheticCorpus(pool, { seed: 43, targetEvents: 200 });
		expect(JSON.stringify(other.batches.slice(0, 50))).not.toBe(JSON.stringify(first.batches.slice(0, 50)));
	});

	test("label purity: every rejected variant carries an active-phase reject-set defect", () => {
		const pool = craftedPool(60);
		const corpus = buildSyntheticCorpus(pool, { seed: 42, targetEvents: 200 });
		expect(corpus.batches.length).toBeGreaterThan(120);
		for (const batch of corpus.batches) {
			if (batch.kind !== "choice") continue;
			expect(batch.variants.filter((variant) => variant.selected)).toHaveLength(1);
			const rules = FLY_SYNTHETIC_PROFILES.find((profile) => profile.id === batch.profileId)!.rulesAt(batch.phase);
			for (const variant of batch.variants) {
				if (variant.selected || variant.defect === null) continue;
				expect(variant.defect).toBeDefined();
				if (isFullDefect(variant.defect)) {
					expect(rules.rejects.has(variant.defect)).toBe(true);
				} else {
					throw new Error(`Near-miss ${variant.defect} received a negative label — label purity broken.`);
				}
			}
		}
	});

	test("holdout bases appear only in each profile's test zone", () => {
		const pool = craftedPool(60);
		const rng = mulberry32(99);
		const split = splitPoolHoldout(pool, rng);
		expect(split.holdout.length).toBe(9);
		const corpus = buildSyntheticCorpus(pool, { seed: 42, targetEvents: 200 });
		const holdoutIds = new Set(split.holdout.map((base) => base.id));
		// NOTE: the corpus build re-splits the pool with its own rng stream;
		// recompute the split the same way for the audit.
		const auditRng = mulberry32(42);
		const auditSplit = splitPoolHoldout(pool, auditRng);
		const auditHoldout = new Set(auditSplit.holdout.map((base) => base.id));
		expect(auditHoldout.size).toBeGreaterThan(0);

		const byProfile = new Map<string, typeof corpus.batches>();
		for (const batch of corpus.batches) {
			const bucket = byProfile.get(batch.profileId) ?? [];
			bucket.push(batch);
			byProfile.set(batch.profileId, bucket);
		}
		let checked = 0;
		for (const [profileId, batches] of byProfile) {
			batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			const testStart = Math.floor(batches.length * 0.85);
			for (let index = 0; index < batches.length; index += 1) {
				const usesHoldout = batches[index]!.variants.some((variant) => auditHoldout.has(variant.baseId));
				if (!usesHoldout) continue;
				expect(index).toBeGreaterThanOrEqual(testStart);
				checked += 1;
			}
			expect(batches.length).toBeGreaterThan(20);
			void profileId;
		}
		expect(checked).toBeGreaterThan(0);
		void holdoutIds;
	});

	test("switcher flips rules inside train and never rejects phase-B kinds afterwards", () => {
		const corpus = buildSyntheticCorpus(craftedPool(60), { seed: 42, targetEvents: 200 });
		const switcher = corpus.batches.filter((batch) => batch.profileId === "switcher");
		expect(switcher.some((batch) => batch.phase === "A")).toBe(true);
		expect(switcher.some((batch) => batch.phase === "B")).toBe(true);
		const phaseB = switcher.filter((batch) => batch.phase === "B");
		const readerRules = FLY_SYNTHETIC_PROFILES.find((profile) => profile.id === "reader")!;
		for (const batch of phaseB) {
			for (const variant of batch.variants) {
				if (!variant.selected && variant.defect !== null && isFullDefect(variant.defect)) {
					expect(readerRules.rulesAt("A").rejects.has(variant.defect)).toBe(true);
				}
			}
		}
	});

	test("implicit batches are single-variant keeps; timestamps are monotone per profile", () => {
		const corpus = buildSyntheticCorpus(craftedPool(60), { seed: 42, targetEvents: 200 });
		const implicit = corpus.batches.filter((batch) => batch.kind === "implicit");
		expect(implicit.length).toBeGreaterThan(10);
		for (const batch of implicit) {
			expect(batch.variants).toHaveLength(1);
			expect(batch.variants[0]!.selected).toBe(true);
		}
		const byProfile = new Map<string, string[]>();
		for (const batch of corpus.batches) {
			const stamps = byProfile.get(batch.profileId) ?? [];
			stamps.push(batch.createdAt);
			byProfile.set(batch.profileId, stamps);
		}
		for (const stamps of byProfile.values()) {
			for (let index = 1; index < stamps.length; index += 1) {
				expect(stamps[index]! > stamps[index - 1]!).toBe(true);
			}
		}
	});
});
