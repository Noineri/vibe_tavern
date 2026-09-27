/**
 * Fly Tribunal — FT-18R synthetic declared-defect corpus generator (step 3).
 *
 * Builds a deterministic, fully-labeled synthetic corpus for the nose
 * discrimination experiment (see vibe_tavern_plan/reports/
 * FLY_TRIBUNAL_LEARNABILITY_RESEARCH.md, "Dataset-first calibration program").
 *
 * Design (owner-approved 2026-09-27):
 * - BASES are the owner's real accepted assistant replies (read-only DB
 *   snapshot via VACUUM INTO — the live DB is never written). Bases are
 *   English-dominant texts; all injected defect material is English.
 * - 7 mechanical defect transforms (verbose monologue, paragraph duplication,
 *   truncation, tag leak, repetition of earlier chat content,
 *   description-instead-of-reply, length bloat) + 3 near-miss variants
 *   (mild monologue, mild bloat, mild duplication).
 * - 5 artificial preference profiles whose DECLARED rules produce clean
 *   labels: terse, technician, reader, voice, switcher (terse→reader flip
 *   inside the train zone to test unlearning). Tolerated defects are
 *   sometimes SELECTED over the clean base — the anti-generic-defector
 *   signal: the same surface pattern carries opposite valence per profile.
 * - Batches carry the exact FlyCalibrationBatch shape (plus profile/defect
 *   annotations), so the calibration harness runs them unchanged: per-profile
 *   chronological 70/15/15 splits, prequential scoring, decay clock.
 * - Holdout bases (15% of the pool) appear ONLY in each profile's test zone.
 *
 * Determinism: one mulberry32 RNG threaded through everything, bases read in
 * stable (chat_id, position) order — same seed + same DB snapshot ⇒ identical
 * corpus JSON (byte-for-byte apart from `generatedAtUtc`).
 *
 * Usage:
 *   bun scripts/generate-fly-synthetic-corpus.ts
 *     [--db data/vibe-tavern.db] [--seed 42] [--target-events 3200]
 *     [--pool-cap 1400] [--max-base-uses 6]
 *     [--out <corpus.json>]   (default: %TEMP%/fly-synthetic-corpus-v1.json)
 */

import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mulberry32, type FlyCalibrationBatch, type FlyCalibrationVariant } from "./calibrate-fly-tribunal.js";

// ─── Defect taxonomy ─────────────────────────────────────────────────────────

/** Full-amplitude defect classes (rejected when the active profile says so). */
export const FLY_SYNTHETIC_DEFECTS = [
	"monologue",
	"duplication",
	"truncation",
	"tag-leak",
	"history-repetition",
	"description",
	"bloat",
] as const;
export type FlySyntheticDefect = (typeof FLY_SYNTHETIC_DEFECTS)[number];

/** Small-amplitude near-misses — acceptable to every profile by construction. */
export const FLY_SYNTHETIC_NEAR_MISSES = ["monologue-mild", "duplication-mild", "bloat-mild"] as const;
export type FlySyntheticNearMiss = (typeof FLY_SYNTHETIC_NEAR_MISSES)[number];

export type FlySyntheticVariantKind = FlySyntheticDefect | FlySyntheticNearMiss;

/** Tag artifacts observed in real generations. */
const TAG_ARTIFACTS = ["\n</reasoning_", "\n[End of Response]", "\n</think>", "\n[end of message]"] as const;

/** Inner-monologue injection templates (italic thought paragraphs, EN). */
const MONOLOGUE_TEMPLATES = [
	"*He turned her words over slowly, weighing each one against the silence that followed. Was that caution in her voice, or something older and more deliberate? The question settled somewhere behind his ribs and refused to leave.*",
	"*A dozen replies assembled themselves and were dismissed one by one. The right words mattered here — the wrong ones had cost him before, and he could still remember exactly how that had felt.*",
	"*She watched the pause stretch, cataloguing every flicker of expression that crossed his face. Doubt, maybe. Or arithmetic. With him the two looked uncomfortably similar.*",
	"*He considered lying. The thought arrived fully formed, almost comfortable, and he set it down again with the careful distaste of a man handling something he had sworn off.*",
	"*Something in the cadence of her voice reminded him of another room, another year, another version of this exact conversation. He filed the thought away for later, where it would wait, patient as rot.*",
	"*The calculation was simple enough: how much of the truth could he spend today and still afford the fare tomorrow? He had never been good at that kind of arithmetic.*",
	"*For a moment he simply listened — to the room, to her breathing, to the small dishonest noises a house makes when it is pretending to be empty.*",
	"*She wondered, distantly, whether he rehearsed these silences. They landed too well to be accidental. Nobody was accidentally this difficult to read.*",
] as const;

/** Neutral setting/description sentences for length bloat (EN, style-neutral). */
const BLOAT_SENTENCES = [
	"The light in the room shifted as a cloud passed over the window, softening every edge it touched.",
	"Somewhere below, a door closed, and the sound carried up through the floorboards like a rumor.",
	"The air between them held the particular stillness of a moment that knew it was being watched.",
	"Dust moved in the lamplight, slow and purposeful, as if it had somewhere to be.",
	"The clock on the mantel ticked once, twice, and then seemed to think better of it.",
	"Outside, the street went about its business — footsteps, a distant engine, the ordinary music of an ordinary evening.",
	"The wallpaper, faded in long stripes where the sun reached it, remembered a brighter decade.",
	"Her reflection ghosted in the darkened window, half-present, the way people are in rooms they mean to leave.",
] as const;

/** Narration frames for the description-instead-of-reply transform. */
const NARRATION_FRAMES = [
	(content: string) => `He said that ${content}.`,
	(content: string) => `She answered that ${content}.`,
	(content: string) => `He replied that ${content}, voice level and unhurried.`,
	(content: string) => `She murmured that ${content}.`,
] as const;

/** Short italic thought for the mild-monologue near-miss (one sentence). */
const MILD_MONOLOGUE = "*Not for the first time, he wondered whether this was progress.*" as const;

// ─── Bases ───────────────────────────────────────────────────────────────────

export interface FlySyntheticBase {
	/** Stable synthetic id (`b-000123`) — referenced by every variant. */
	id: string;
	/** Accepted reply text (edited final content when she edited before saving). */
	text: string;
	/** Source chat (for reproducibility audits only). */
	chatId: string;
	/** Paragraphs lifted from EARLIER assistant messages of the same chat —
	 *  the raw material for the history-repetition defect. */
	earlierParagraphs: readonly string[];
	/** Transforms applicable to this specific base. */
	applicable: ReadonlySet<FlySyntheticDefect>;
}

function splitParagraphsOf(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

/** Share of Latin letters among all Unicode letters — the EN-dominance filter. */
export function latinLetterShare(text: string): number {
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length === 0) return 0;
	let latin = 0;
	for (const letter of letters) {
		if (/[a-z]/i.test(letter)) latin += 1;
	}
	return latin / letters.length;
}

export function applicableTransforms(text: string, earlierParagraphs: readonly string[]): Set<FlySyntheticDefect> {
	const paragraphs = splitParagraphsOf(text);
	const lines = text.split(/\n/).map((line) => line.trim());
	const hasDialogue = lines.some((line) => /^[—–]\s/.test(line)) || /"[^"\n]{3,}"|«[^»\n]{3,}»/.test(text);
	const applicable = new Set<FlySyntheticDefect>(["tag-leak", "bloat", "monologue"]);
	if (paragraphs.length >= 1) applicable.add("duplication");
	if (text.length >= 300) applicable.add("truncation");
	if (earlierParagraphs.length > 0) applicable.add("history-repetition");
	if (hasDialogue) applicable.add("description");
	return applicable;
}

// ─── Defect transforms (pure, deterministic given rng) ───────────────────────

function pick<T>(items: readonly T[], rng: () => number): T {
	return items[Math.floor(rng() * items.length)]!;
}

function pickMonologueTemplate(rng: () => number, used: Set<string>): string {
	const fresh = MONOLOGUE_TEMPLATES.filter((template) => !used.has(template));
	return fresh.length > 0 ? pick(fresh, rng) : pick(MONOLOGUE_TEMPLATES, rng);
}

/**
 * Apply one transform to a base. Returns the defected text, or null when the
 * transform is not applicable to this base (caller must consult
 * `base.applicable` first; this is the second line of defense).
 */
export function applySyntheticTransform(
	base: FlySyntheticBase,
	kind: FlySyntheticVariantKind,
	rng: () => number,
	usedMonologues: Set<string> = new Set(),
): string | null {
	const paragraphs = splitParagraphsOf(base.text);
	switch (kind) {
		case "monologue": {
			const template = pickMonologueTemplate(rng, usedMonologues);
			usedMonologues.add(template);
			const at = Math.min(1, paragraphs.length - 1);
			return [...paragraphs.slice(0, at), template, ...paragraphs.slice(at)].join("\n\n");
		}
		case "monologue-mild":
			return `${base.text}\n\n${MILD_MONOLOGUE}`;
		case "duplication": {
			if (paragraphs.length === 0) return null;
			let longest = paragraphs[0]!;
			for (const paragraph of paragraphs) {
				if (paragraph.length > longest.length) longest = paragraph;
			}
			const at = Math.max(1, paragraphs.indexOf(longest));
			return [...paragraphs.slice(0, at + 1), longest, ...paragraphs.slice(at + 1)].join("\n\n");
		}
		case "duplication-mild": {
			if (paragraphs.length === 0) return null;
			let shortest = paragraphs[0]!;
			for (const paragraph of paragraphs) {
				if (paragraph.length < shortest.length) shortest = paragraph;
			}
			if (shortest.length > 140) return null; // nothing mild to repeat
			const at = paragraphs.indexOf(shortest);
			return [...paragraphs.slice(0, at), shortest, shortest, ...paragraphs.slice(at + 1)].join("\n\n");
		}
		case "truncation": {
			if (base.text.length < 300) return null;
			const cut = Math.floor(base.text.length * (0.62 + rng() * 0.18));
			const slice = base.text.slice(0, cut);
			const lastSpace = slice.lastIndexOf(" ");
			return lastSpace > base.text.length * 0.4 ? slice.slice(0, Math.max(0, lastSpace - 1)) : slice;
		}
		case "tag-leak":
			return `${base.text}${pick(TAG_ARTIFACTS, rng)}`;
		case "history-repetition": {
			const chunk = base.earlierParagraphs[Math.floor(rng() * base.earlierParagraphs.length)];
			if (chunk === undefined) return null;
			return `${base.text}\n\n${chunk}`;
		}
		case "description": {
			const lines = base.text.split(/\n/);
			let converted = false;
			const frame = pick(NARRATION_FRAMES, rng);
			const out = lines.map((line) => {
				const trimmed = line.trim();
				const dash = trimmed.match(/^[—–]\s+(.+)$/);
				if (dash !== null) {
					converted = true;
					const content = dash[1]!.replace(/^[«"“]|^[«"“](.*)»"”$/g, (full) => full).replace(/^["«“]|["»”]$/g, "");
					return frame(decapitalizeKeepNames(content));
				}
				const quoted = trimmed.match(/^["«“](.+)["»”]$/);
				if (quoted !== null && quoted[1]!.length >= 3) {
					converted = true;
					return frame(decapitalizeKeepNames(quoted[1]!));
				}
				return line;
			});
			return converted ? out.join("\n") : null;
		}
		case "bloat": {
			const count = 2 + Math.floor(rng() * 2); // 2–3 sentences
			const sentences: string[] = [];
			while (sentences.length < count) {
				const sentence = pick(BLOAT_SENTENCES, rng);
				if (!sentences.includes(sentence)) sentences.push(sentence);
			}
			return `${base.text}\n\n${sentences.join(" ")}`;
		}
		case "bloat-mild":
			return `${base.text} ${pick(BLOAT_SENTENCES, rng)}`;
	}
}

/** Lowercase the first letter unless the first word looks like a name/all-caps. */
function decapitalizeKeepNames(content: string): string {
	const firstWord = content.match(/^[\p{L}]+/u)?.[0] ?? "";
	if (firstWord.length === 0 || firstWord === firstWord.toUpperCase()) return content;
	if (firstWord.length > 1 && firstWord[1]! === firstWord[1]!.toUpperCase() && firstWord[1]! !== firstWord[1]!.toLowerCase()) {
		return content; // "McSomething"/"McDonald"-ish — leave alone
	}
	return firstWord[0]!.toLowerCase() + content.slice(1);
}

/** Benign surface variant for clean-vs-clean batches (must CHANGE the text). */
export function benignReformat(text: string): string {
	const options: Array<() => string> = [
		() => (text.includes("...") ? text.replace("...", "…") : text),
		() => (text.includes("\n\n") ? text.replace("\n\n", "\n") : text),
		() => (text.includes(" — ") ? text.replace(" — ", " - ") : text),
	];
	for (const option of options) {
		const candidate = option();
		if (candidate !== text) return candidate;
	}
	return `${text}\n`;
}

// ─── Preference profiles ─────────────────────────────────────────────────────

export type FlySyntheticProfileId = "terse" | "technician" | "reader" | "voice" | "switcher";

export interface FlySyntheticProfileRules {
	/** Defects this profile rejects in its active phase. */
	rejects: ReadonlySet<FlySyntheticDefect>;
	/** Defects this profile actively PREFERS over the clean base. */
	prefers: ReadonlySet<FlySyntheticDefect>;
}

const TERSE_RULES: FlySyntheticProfileRules = {
	rejects: new Set(["monologue", "bloat"]),
	prefers: new Set(),
};
const READER_RULES: FlySyntheticProfileRules = {
	rejects: new Set(["duplication", "history-repetition"]),
	prefers: new Set(["bloat"]),
};

export const FLY_SYNTHETIC_PROFILES: ReadonlyArray<{
	id: FlySyntheticProfileId;
	/** The switcher changes rules inside the train zone at this fraction. */
	switchAtTrainFraction: number | null;
	rulesAt: (phase: "A" | "B") => FlySyntheticProfileRules;
}> = [
	{ id: "terse", switchAtTrainFraction: null, rulesAt: () => TERSE_RULES },
	{ id: "technician", switchAtTrainFraction: null, rulesAt: () => ({ rejects: new Set(["tag-leak", "truncation"]), prefers: new Set() }) },
	{ id: "reader", switchAtTrainFraction: null, rulesAt: () => READER_RULES },
	{ id: "voice", switchAtTrainFraction: null, rulesAt: () => ({ rejects: new Set(["description"]), prefers: new Set() }) },
	{ id: "switcher", switchAtTrainFraction: 0.55, rulesAt: (phase) => (phase === "A" ? TERSE_RULES : READER_RULES) },
];

/** Near-misses are acceptable to EVERY profile — they are the FP control. */

// ─── Batch assembly ──────────────────────────────────────────────────────────

export interface FlySyntheticVariantMeta extends FlyCalibrationVariant {
	defect: FlySyntheticVariantKind | null;
	baseId: string;
}

export interface FlySyntheticBatch extends FlyCalibrationBatch {
	profileId: FlySyntheticProfileId;
	phase: "A" | "B";
	/** True when at least one variant is built on a holdout base. */
	holdout: boolean;
	variants: FlySyntheticVariantMeta[];
}

/** Type guard: full-amplitude defect (near-misses are never in rule sets). */
export function isFullDefect(kind: FlySyntheticVariantKind): kind is FlySyntheticDefect {
	return (FLY_SYNTHETIC_DEFECTS as readonly string[]).includes(kind);
}

/**
 * Decide which variant is selected given the active rules — deterministic
 * label purity is the whole point of the synthetic corpus:
 * - a REJECTED-class defect is never selected (skipped entirely);
 * - a PREFERS defect wins over everything else;
 * - any tolerated defect or near-miss wins over the clean base (a tolerated
 *   pattern must never collect a negative label by losing a coin flip);
 * - all-clean batches fall back to a seeded coin flip.
 * Consequently every negative label in the corpus is a full-amplitude defect
 * from the active profile's reject set, by construction.
 */
export function selectVariantIndex(
	kinds: readonly (FlySyntheticVariantKind | null)[],
	rules: FlySyntheticProfileRules,
	rng: () => number,
): number {
	const nonRejected = kinds
		.map((kind, index) => ({ kind, index }))
		.filter((entry) => entry.kind === null || !(isFullDefect(entry.kind) && rules.rejects.has(entry.kind)));
	if (nonRejected.length === 0) throw new Error("Synthetic labeling produced an all-rejected batch.");
	for (const entry of nonRejected) {
		if (entry.kind !== null && isFullDefect(entry.kind) && rules.prefers.has(entry.kind)) return entry.index;
	}
	const tolerated = nonRejected.filter((entry) => entry.kind !== null);
	if (tolerated.length > 0) {
		// Multiple tolerated kinds: seeded pick among them.
		return tolerated[Math.floor(rng() * tolerated.length)]!.index;
	}
	return nonRejected[Math.floor(rng() * nonRejected.length)]!.index;
}

function buildBatch(
	profileId: FlySyntheticProfileId,
	phase: "A" | "B",
	seq: number,
	entries: ReadonlyArray<{ kind: FlySyntheticVariantKind | null; text: string; baseId: string; holdout: boolean }>,
	rules: FlySyntheticProfileRules,
	rng: () => number,
	createdAtMs: number,
): FlySyntheticBatch {
	const kinds = entries.map((entry) => entry.kind);
	const selectedIndex = entries.length > 1 ? selectVariantIndex(kinds, rules, rng) : 0;
	return {
		messageId: `synthetic-${profileId}-${seq}`,
		chatId: `synthetic/${profileId}`,
		position: seq,
		createdAt: new Date(createdAtMs).toISOString(),
		kind: entries.length > 1 ? "choice" : "implicit",
		variants: entries.map((entry, index) => ({
			index,
			content: entry.text,
			selected: index === selectedIndex,
			defect: entry.kind,
			baseId: entry.baseId,
		})),
		finalContent: null,
		excludedReason: null,
		profileId,
		phase,
		holdout: entries.some((entry) => entry.holdout),
	};
}

// ─── Event plan (per profile) ────────────────────────────────────────────────

/** Event archetypes and their share of a zone (shares sum to 1 per zone). */
export const FLY_SYNTHETIC_EVENT_MIX = [
	{ archetype: "clean-vs-defect", share: 0.45 },
	{ archetype: "defect-vs-defect", share: 0.15 },
	{ archetype: "clean-vs-nearmiss", share: 0.1 },
	{ archetype: "clean-vs-clean", share: 0.1 },
	{ archetype: "implicit", share: 0.2 },
] as const;
export type FlySyntheticArchetype = (typeof FLY_SYNTHETIC_EVENT_MIX)[number]["archetype"];

interface BasePool {
	train: FlySyntheticBase[];
	holdout: FlySyntheticBase[];
}

/** Sample a defect class from the active rules, restricted to what the base allows. */
function sampleRejectedDefect(base: FlySyntheticBase, rules: FlySyntheticProfileRules, rng: () => number): FlySyntheticDefect | null {
	const pool = [...rules.rejects].filter((defect) => base.applicable.has(defect));
	if (pool.length === 0) return null;
	return pool[Math.floor(rng() * pool.length)]!;
}

/** Sample a tolerated defect (not rejected, not near-miss), base-applicable. */
function sampleToleratedDefect(base: FlySyntheticBase, rules: FlySyntheticProfileRules, rng: () => number): FlySyntheticDefect | null {
	const pool = FLY_SYNTHETIC_DEFECTS.filter(
		(defect) => !rules.rejects.has(defect) && base.applicable.has(defect),
	);
	if (pool.length === 0) return null;
	return pool[Math.floor(rng() * pool.length)]!;
}

function sampleNearMiss(base: FlySyntheticBase, rng: () => number): FlySyntheticNearMiss | null {
	const pool = FLY_SYNTHETIC_NEAR_MISSES.filter((kind) => {
		const probe = kind === "duplication-mild" ? "duplication" : kind === "monologue-mild" ? "monologue" : "bloat";
		return base.applicable.has(probe as FlySyntheticDefect);
	});
	if (pool.length === 0) return null;
	return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Build one profile's full event list: train zone (70%), validation zone
 * (15%), test zone (15%; half of its events use holdout bases when the pool
 * allows). `seq` continues monotonically; timestamps are assigned later.
 */
export function buildProfileEvents(
	profileId: FlySyntheticProfileId,
	pool: BasePool,
	rng: () => number,
	options: { events: number; maxBaseUses?: number },
): FlySyntheticBatch[] {
	const profile = FLY_SYNTHETIC_PROFILES.find((entry) => entry.id === profileId)!;
	const maxUses = options.maxBaseUses ?? 6;
	const uses = new Map<string, number>();
	const usedMonologues = new Set<string>();
	const trainEvents = Math.floor(options.events * 0.7);
	const validationEvents = Math.floor(options.events * 0.15);
	const testEvents = options.events - trainEvents - validationEvents;
	const events: FlySyntheticBatch[] = [];

	const drawBase = (allowHoldout: boolean): FlySyntheticBase | null => {
		if (allowHoldout) {
			// Test-zone events flagged for holdout draw EXCLUSIVELY from the
			// holdout pool — generalization must be measured on unseen bases.
			const holdoutCandidates = pool.holdout.filter((base) => (uses.get(base.id) ?? 0) < maxUses);
			if (holdoutCandidates.length > 0) {
				return holdoutCandidates[Math.floor(rng() * holdoutCandidates.length)]!;
			}
		}
		const candidates = pool.train.filter((base) => (uses.get(base.id) ?? 0) < maxUses);
		if (candidates.length === 0) return null;
		return candidates[Math.floor(rng() * candidates.length)]!;
	};

	const makeEvent = (seq: number, zone: "train" | "validation" | "test", rules: FlySyntheticProfileRules, allowHoldout: boolean): FlySyntheticBatch | null => {
		const base = drawBase(allowHoldout && zone === "test");
		if (base === null) return null;
		uses.set(base.id, (uses.get(base.id) ?? 0) + 1);
		const archetypeRoll = rng();
		let cumulative = 0;
		let archetype: FlySyntheticArchetype = "clean-vs-defect";
		for (const mixEntry of FLY_SYNTHETIC_EVENT_MIX) {
			cumulative += mixEntry.share;
			if (archetypeRoll < cumulative) {
				archetype = mixEntry.archetype;
				break;
			}
		}
		const entries: Array<{ kind: FlySyntheticVariantKind | null; text: string; baseId: string; holdout: boolean }> = [];
		const mark = (kind: FlySyntheticVariantKind | null, text: string | null) => {
			if (text === null) return false;
			entries.push({ kind, text, baseId: base.id, holdout: pool.holdout.some((candidate) => candidate.id === base.id) });
			return true;
		};
		switch (archetype) {
			case "clean-vs-defect": {
				const defect = sampleRejectedDefect(base, rules, rng) ?? sampleToleratedDefect(base, rules, rng);
				mark(defect, defect === null ? null : applySyntheticTransform(base, defect, rng, usedMonologues));
				break;
			}
			case "defect-vs-defect": {
				const rejectedDefect = sampleRejectedDefect(base, rules, rng);
				const toleratedDefect = sampleToleratedDefect(base, rules, rng);
				if (rejectedDefect !== null && rejectedDefect !== toleratedDefect) {
					mark(rejectedDefect, applySyntheticTransform(base, rejectedDefect, rng, usedMonologues));
				}
				mark(toleratedDefect, toleratedDefect === null ? null : applySyntheticTransform(base, toleratedDefect, rng, usedMonologues));
				break;
			}
			case "clean-vs-nearmiss": {
				const nearMiss = sampleNearMiss(base, rng);
				mark(nearMiss, nearMiss === null ? null : applySyntheticTransform(base, nearMiss, rng, usedMonologues));
				break;
			}
			case "clean-vs-clean":
				mark(null, benignReformat(base.text));
				break;
			case "implicit": {
				// Implicit keeps never carry a rejected-class defect; tolerated
				// defects appear sometimes (positive signal for tolerated kinds).
				const tolerated = rng() < 0.3 ? sampleToleratedDefect(base, rules, rng) : null;
				if (tolerated === null) {
					entries.push({ kind: null, text: base.text, baseId: base.id, holdout: pool.holdout.some((candidate) => candidate.id === base.id) });
				} else {
					mark(tolerated, applySyntheticTransform(base, tolerated, rng, usedMonologues));
				}
				break;
			}
		}
		if (archetype !== "implicit") {
			// Clean base always sits at variant index 0 by construction.
			const cleanBase = {
				kind: null,
				text: base.text,
				baseId: base.id,
				holdout: pool.holdout.some((candidate) => candidate.id === base.id),
			};
			entries.unshift(cleanBase);
		}
		if (entries.length < 1) return null;
		return buildBatch(profileId, phase, seq, entries, rules, rng, 0);
	};

	// Zone loop with the switcher's phase change inside train.
	let phase: "A" | "B" = "A";
	const switchAt = profile.switchAtTrainFraction === null ? null : Math.floor(trainEvents * profile.switchAtTrainFraction);
	let seq = 0;
	const zones: Array<{ count: number; zone: "train" | "validation" | "test" }> = [
		{ count: trainEvents, zone: "train" },
		{ count: validationEvents, zone: "validation" },
		{ count: testEvents, zone: "test" },
	];
	for (const { count, zone } of zones) {
		for (let index = 0; index < count; index += 1) {
			if (switchAt !== null && seq === switchAt) phase = "B";
			const rules = profile.rulesAt(phase);
			const batch = makeEvent(seq, zone, rules, zone === "test" && index % 2 === 0);
			if (batch !== null) {
				events.push(batch);
				seq += 1;
			}
		}
	}
	// Timestamps: assign after assembly so zone order is authoritative.
	return assignProfileTimestamps(events);
}

function assignProfileTimestamps(events: FlySyntheticBatch[]): FlySyntheticBatch[] {
	// Deterministic synthetic clock: 3–153 s gaps within a session of ~14
	// events, then a 2–40 h session break. Zone order is authoritative — the
	// harness re-derives the 70/15/15 zones chronologically from these stamps.
	let ms = Date.UTC(2024, 0, 1, 0, 0, 0);
	let inSession = 0;
	const rng = mulberry32(20240101);
	for (const event of events) {
		const gap = inSession === 0 ? 0 : (3 + Math.floor(rng() * 150)) * 1000;
		ms += gap;
		inSession += 1;
		if (inSession >= 14) {
			ms += (2 + Math.floor(rng() * 38)) * 3_600_000;
			inSession = 0;
		}
		event.createdAt = new Date(ms).toISOString();
	}
	return events;
}

// ─── Interleave profiles into one timeline ──────────────────────────────────

/**
 * Merge per-profile event lists into one global timeline: each step takes the
 * next event from a seeded-random non-empty profile, preserving per-profile
 * order. Cross-profile gaps of 1–20 min separate events (profiles are
 * parallel "users", so sessions may overlap in wall-clock time).
 */
export function interleaveProfiles(
	eventsByProfile: ReadonlyArray<readonly FlySyntheticBatch[]>,
	rng: () => number,
): FlySyntheticBatch[] {
	const cursors = eventsByProfile.map((events) => [...events]);
	const merged: FlySyntheticBatch[] = [];
	let ms = Date.UTC(2024, 0, 1, 0, 0, 0);
	const remaining = () => cursors.filter((queue) => queue.length > 0).length;
	while (remaining() > 0) {
		const queue = cursors[Math.floor(rng() * cursors.length)]!;
		if (queue.length === 0) continue;
		const event = queue.shift()!;
		ms += (60 + Math.floor(rng() * 1200)) * 1000; // 1–21 min between events
		merged.push({ ...event, createdAt: new Date(ms).toISOString() });
	}
	return merged;
}

// ─── Base pool extraction (read-only DB) ─────────────────────────────────────

interface KeptRow {
	message_id: string;
	chat_id: string;
	position: number;
	final_content: string | null;
	variant_content: string;
}

const LATIN_SHARE_MIN = 0.85;
const BASE_MIN_CHARS = 150;
const BASE_MAX_CHARS = 2600;

/**
 * Extract accepted-reply bases from a DB snapshot: kept variants (edited
 * final content wins), English-dominant, 150–2600 chars, deduplicated,
 * capped per chat, with earlier-assistant paragraphs for the repetition
 * defect. Deterministic: rows come back in (chat_id, position) order.
 */
export function extractBasePool(db: Database, options: { poolCap?: number; perChatCap?: number } = {}): FlySyntheticBase[] {
	const poolCap = options.poolCap ?? 1400;
	const perChatCap = options.perChatCap ?? 60;
	const rows = db
		.query(
			`SELECT m.id AS message_id, m.chat_id, m.position, m.content AS final_content, v.content AS variant_content
			 FROM messages m JOIN message_variants v ON v.message_id = m.id
			 WHERE m.role = 'assistant' AND v.is_selected = 1
			 ORDER BY m.chat_id, m.position`,
		)
		.all() as unknown as KeptRow[];
	const seen = new Set<string>();
	const perChat = new Map<string, number>();
	const bases: FlySyntheticBase[] = [];
	const earlierByChat = new Map<string, string[]>();
	for (const row of rows) {
		const earlier = earlierByChat.get(row.chat_id) ?? [];
		const accepted = row.final_content !== null && row.final_content.length > 0 && row.final_content !== row.variant_content
			? row.final_content
			: row.variant_content;
		if (accepted.length >= 60) earlier.push(accepted);
		earlierByChat.set(row.chat_id, earlier.slice(-5));
		if (accepted.length < BASE_MIN_CHARS || accepted.length > BASE_MAX_CHARS) continue;
		if (latinLetterShare(accepted) < LATIN_SHARE_MIN) continue;
		const dedupeKey = accepted.toLowerCase().replace(/\s+/g, " ");
		if (seen.has(dedupeKey)) continue;
		if ((perChat.get(row.chat_id) ?? 0) >= perChatCap) continue;
		const earlierParagraphs = (earlierByChat.get(row.chat_id) ?? [])
			.flatMap((text) => splitParagraphsOf(text))
			.filter((paragraph) => paragraph.length >= 80 && paragraph.length <= 250)
			.slice(-6);
		seen.add(dedupeKey);
		perChat.set(row.chat_id, (perChat.get(row.chat_id) ?? 0) + 1);
		bases.push({
			id: `b-${String(bases.length).padStart(6, "0")}`,
			text: accepted,
			chatId: row.chat_id,
			earlierParagraphs,
			applicable: applicableTransforms(accepted, earlierParagraphs),
		});
	}
	if (bases.length > poolCap) {
		const rng = mulberry32(20260927);
		const shuffled = [...bases];
		for (let index = shuffled.length - 1; index > 0; index -= 1) {
			const swap = Math.floor(rng() * (index + 1));
			[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
		}
		const selected = shuffled.slice(0, poolCap).sort((a, b) => a.id.localeCompare(b.id));
		for (let index = 0; index < selected.length; index += 1) {
			selected[index] = { ...selected[index]!, id: `b-${String(index).padStart(6, "0")}` };
		}
		return selected;
	}
	return bases;
}

/** Deterministic 85/15 split of the pool into train vs holdout bases. */
export function splitPoolHoldout(bases: readonly FlySyntheticBase[], rng: () => number): BasePool {
	const shuffled = [...bases];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(rng() * (index + 1));
		[shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
	}
	const holdoutCount = Math.max(1, Math.floor(shuffled.length * 0.15));
	return {
		holdout: shuffled.slice(0, holdoutCount).sort((a, b) => a.id.localeCompare(b.id)),
		train: shuffled.slice(holdoutCount).sort((a, b) => a.id.localeCompare(b.id)),
	};
}

// ─── Corpus assembly ─────────────────────────────────────────────────────────

export interface FlySyntheticCorpus {
	meta: {
		version: 1;
		seed: number;
		generatedAtUtc: string;
		basePoolSize: number;
		holdoutBaseCount: number;
		targetEvents: number;
		profiles: Array<{ id: FlySyntheticProfileId; events: number; switchAtTrainFraction: number | null }>;
		transformAvailability: Record<string, number>;
		caveats: string[];
	};
	batches: FlySyntheticBatch[];
}

/**
 * Assemble the full corpus from a base pool (pure — tests drive this with
 * handcrafted pools; the CLI drives it with the DB-extracted pool).
 */
export function buildSyntheticCorpus(
	bases: readonly FlySyntheticBase[],
	options: { seed?: number; targetEvents?: number; maxBaseUses?: number } = {},
): FlySyntheticCorpus {
	const seed = options.seed ?? 42;
	const targetEvents = options.targetEvents ?? 3200;
	const rng = mulberry32(seed);
	const pool = splitPoolHoldout(bases, rng);
	const perProfile = Math.max(40, Math.floor(targetEvents / FLY_SYNTHETIC_PROFILES.length));
	const byProfile: FlySyntheticBatch[][] = [];
	for (const profile of FLY_SYNTHETIC_PROFILES) {
		const events = buildProfileEvents(profile.id, pool, rng, { events: perProfile, maxBaseUses: options.maxBaseUses });
		byProfile.push(events);
	}
	const batches = interleaveProfiles(byProfile, rng);
	const availability: Record<string, number> = {};
	for (const defect of FLY_SYNTHETIC_DEFECTS) {
		availability[defect] = bases.filter((base) => base.applicable.has(defect)).length;
	}
	return {
		meta: {
			version: 1,
			seed,
			generatedAtUtc: new Date().toISOString(),
			basePoolSize: bases.length,
			holdoutBaseCount: pool.holdout.length,
			targetEvents,
			profiles: FLY_SYNTHETIC_PROFILES.map((profile) => ({
				id: profile.id,
				events: byProfile.find((events) => events.length > 0 && events[0]!.profileId === profile.id)?.length ?? 0,
				switchAtTrainFraction: profile.switchAtTrainFraction,
			})),
			transformAvailability: availability,
			caveats: [
				"Synthetic declared-defect corpus: labels come from declared profile rules, not human judgment.",
				"Holdout bases appear only in each profile's test zone; the harness re-derives zones chronologically.",
			],
		},
		batches,
	};
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
	db: string;
	seed: number;
	targetEvents: number;
	poolCap: number;
	maxBaseUses: number;
	out: string;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		db: "data/vibe-tavern.db",
		seed: 42,
		targetEvents: 3200,
		poolCap: 1400,
		maxBaseUses: 6,
		out: join(tmpdir(), "fly-synthetic-corpus-v1.json"),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--db") args.db = argv[++index] ?? args.db;
		else if (arg === "--seed") args.seed = Number(argv[++index] ?? args.seed);
		else if (arg === "--target-events") args.targetEvents = Number(argv[++index] ?? args.targetEvents);
		else if (arg === "--pool-cap") args.poolCap = Number(argv[++index] ?? args.poolCap);
		else if (arg === "--max-base-uses") args.maxBaseUses = Number(argv[++index] ?? args.maxBaseUses);
		else if (arg === "--out") args.out = argv[++index] ?? args.out;
		else throw new Error(`Unknown corpus-generator argument: ${arg}`);
	}
	return args;
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	const repoRoot = resolve(import.meta.dir, "..");
	const dbPath = resolve(repoRoot, args.db);
	const workDir = join(tmpdir(), `fly-synth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(workDir, { recursive: true });
	const copyPath = join(workDir, "copy.db");
	try {
		const source = new Database(dbPath, { readonly: true });
		source.run(`VACUUM INTO '${copyPath.replaceAll("\\", "/")}'`);
		source.close();
		const db = new Database(copyPath, { readonly: true });
		const bases = extractBasePool(db, { poolCap: args.poolCap });
		db.close();
		if (bases.length < 200) {
			throw new Error(`Base pool too small: ${bases.length} bases (need ≥ 200 for a meaningful corpus).`);
		}
		console.log(`base pool: ${bases.length} English accepted replies`);
		const corpus = buildSyntheticCorpus(bases, {
			seed: args.seed,
			targetEvents: args.targetEvents,
			maxBaseUses: args.maxBaseUses,
		});
		const byProfile = new Map<string, number>();
		for (const batch of corpus.batches) byProfile.set(batch.profileId, (byProfile.get(batch.profileId) ?? 0) + 1);
		console.log(`events: ${corpus.batches.length} total — ${[...byProfile].map(([id, count]) => `${id}:${count}`).join(" ")}`);
		const holdoutEvents = corpus.batches.filter((batch) => batch.holdout).length;
		const defectCounts = new Map<string, number>();
		for (const batch of corpus.batches) {
			for (const variant of batch.variants) {
				if (variant.defect !== null) defectCounts.set(variant.defect, (defectCounts.get(variant.defect) ?? 0) + 1);
			}
		}
		console.log(`holdout-base events: ${holdoutEvents}`);
		console.log(`variant kinds: ${[...defectCounts].sort().map(([kind, count]) => `${kind}:${count}`).join(" ")}`);
		const outPath = resolve(args.out);
		await mkdir(dirname(outPath), { recursive: true });
		await writeFile(outPath, JSON.stringify(corpus));
		console.log(`wrote ${outPath} (${(JSON.stringify(corpus).length / 1_000_000).toFixed(1)} MB)`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
