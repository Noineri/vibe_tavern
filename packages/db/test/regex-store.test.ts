import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { REGEX_PLACEMENT, REGEX_SUBSTITUTE, brandId, type RegexProfileId } from "@vibe-tavern/domain";

import { createDb } from "../src/db-connection.js";
import { regexPresets, regexProfileLinks } from "../src/db-schema.js";
import { RegexStore } from "../src/stores/regex-store.js";
import type {
  CreateRegexPresetData,
  CreateRegexProfileData,
  CreateRegexBundleRuleData,
  CreateRegexProfileBundleData,
} from "../src/stores/regex-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-08-25T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const db = await createDb(":memory:");
	const store = new RegexStore(db, { clock: fixedClock, idGenerator: idGen });
	return { store, db };
}

let inputCounter = 0;
function baseInput(overrides: Partial<CreateRegexPresetData> = {}): CreateRegexPresetData {
	inputCounter += 1;
	return {
		name: `preset_${inputCounter}`,
		findRegex: "/foo/g",
		replaceString: "bar",
		trimStrings: [],
		substituteRegex: REGEX_SUBSTITUTE.None,
		disabled: false,
		markdownOnly: false,
		promptOnly: false,
		runOnEdit: true,
		minDepth: null,
		maxDepth: null,
		placement: [REGEX_PLACEMENT.AiOutput],
		isGlobal: false,
		sortOrder: 0,
		...overrides,
	};
}

function baseProfile(overrides: Partial<CreateRegexProfileData> = {}): CreateRegexProfileData {
	return { name: `profile_${++inputCounter}`, disabled: false, isGlobal: false, sortOrder: 0, ...overrides };
}

/** Bundle member input — no `profileId`: the bundle owns membership (RXU-12). */
function bundleRule(overrides: Partial<CreateRegexBundleRuleData> = {}): CreateRegexBundleRuleData {
	inputCounter += 1;
	return {
		name: `rule_${inputCounter}`,
		findRegex: "/foo/g",
		replaceString: "bar",
		trimStrings: [],
		substituteRegex: REGEX_SUBSTITUTE.None,
		disabled: false,
		markdownOnly: false,
		promptOnly: false,
		runOnEdit: true,
		minDepth: null,
		maxDepth: null,
		placement: [REGEX_PLACEMENT.AiOutput],
		isGlobal: false,
		sortOrder: 0,
		...overrides,
	};
}

function baseBundle(overrides: Partial<CreateRegexProfileBundleData> = {}): CreateRegexProfileBundleData {
	return {
		name: `bundle_${++inputCounter}`,
		disabled: false,
		isGlobal: false,
		sortOrder: 0,
		links: [],
		rules: [bundleRule()],
		...overrides,
	};
}

describe("RegexStore CRUD", () => {
	test("create → getById round-trips JSON array fields and booleans", async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({
				name: "think-strip",
				findRegex: "/<think>[\\s\\S]*?<\\/think>/g",
				replaceString: "",
				trimStrings: ["\n", "  "],
				substituteRegex: REGEX_SUBSTITUTE.Escaped,
				disabled: true,
				markdownOnly: true,
				promptOnly: false,
				runOnEdit: false,
				minDepth: 0,
				maxDepth: 2,
				placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.WorldInfo],
				isGlobal: true,
				sortOrder: 7,
			}),
		);

		expect(created.id).toStartWith("regex_preset_");
		expect(created.createdAt).toBe(fixedClock.now());
		expect(created.updatedAt).toBe(fixedClock.now());

		const loaded = await store.getById(created.id);
		expect(loaded).toEqual(created);
	});

	test("update patches fields, serializes arrays, bumps updatedAt; unknown id → null", async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ sortOrder: 1 }));

		const updated = await store.update(created.id, {
			name: "renamed",
			trimStrings: ["«", "»"],
			placement: [REGEX_PLACEMENT.Reasoning],
			disabled: true,
			minDepth: 1,
		});
		expect(updated).not.toBeNull();
		expect(updated!.name).toBe("renamed");
		expect(updated!.trimStrings).toEqual(["«", "»"]);
		expect(updated!.placement).toEqual([REGEX_PLACEMENT.Reasoning]);
		expect(updated!.disabled).toBe(true);
		expect(updated!.minDepth).toBe(1);
		expect(updated!.updatedAt).toBe(fixedClock.now()); // fixed clock — bump is a no-op but the write happened

		// Untouched fields survive the patch.
		expect(updated!.findRegex).toBe(created.findRegex);
		expect(updated!.substituteRegex).toBe(REGEX_SUBSTITUTE.None);

		expect(await store.update("regex_preset_missing", { name: "x" })).toBeNull();
	});

	test("listAll sorts by sortOrder then name; delete removes the row", async () => {
		const { store } = await setup();
		await store.create(baseInput({ name: "b", sortOrder: 2 }));
		await store.create(baseInput({ name: "a2", sortOrder: 1 }));
		await store.create(baseInput({ name: "a1", sortOrder: 1 }));

		const all = await store.listAll();
		expect(all.map((p) => p.name)).toEqual(["a1", "a2", "b"]);

		const first = all[0]!;
		await store.delete(first.id);
		expect(await store.getById(first.id)).toBeNull();
		expect((await store.listAll()).map((p) => p.name)).toEqual(["a2", "b"]);
	});
});

describe("RegexStore malformed-JSON hygiene", () => {
	test("malformed trimStringsJson / placementJson degrade to defaults without throwing", async () => {
		const { store, db } = await setup();
		await db.insert(regexPresets).values({
			id: "regex_preset_broken",
			name: "broken",
			findRegex: "/x/g",
			replaceString: "y",
			trimStringsJson: "{{{not json",
			placementJson: "nope",
			substituteRegex: 0,
			disabled: 0,
			markdownOnly: 0,
			promptOnly: 0,
			runOnEdit: 1,
			isGlobal: 0,
			sortOrder: 0,
			createdAt: fixedClock.now(),
			updatedAt: fixedClock.now(),
		});

		const loaded = await store.getById("regex_preset_broken");
		expect(loaded).not.toBeNull();
		expect(loaded!.trimStrings).toEqual([]);
		expect(loaded!.placement).toEqual([REGEX_PLACEMENT.AiOutput]);

		const listed = await store.listAll();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.trimStrings).toEqual([]);
	});
});

describe("RegexStore link API", () => {
	test("setLinks replaces atomically; addLink/removeLink/getLinks behave", async () => {
		const { store } = await setup();
		const preset = await store.create(baseInput());

		await store.addLink(preset.id, "character", "char_1");
		expect((await store.getLinks(preset.id)).map((l) => l.targetId)).toEqual(["char_1"]);

		// Atomic replace: old binding gone, only the new set remains.
		const replaced = await store.setLinks(preset.id, [{ targetType: "preset", targetId: "preset_9" }]);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]).toMatchObject({ regexPresetId: preset.id, targetType: "preset", targetId: "preset_9" });
		expect(await store.getLinks(preset.id)).toEqual(replaced);

		// Duplicate tuples in one replace are normalized (composite PK safety).
		const deduped = await store.setLinks(preset.id, [
			{ targetType: "character", targetId: "char_1" },
			{ targetType: "character", targetId: "char_1" },
		]);
		expect(deduped).toHaveLength(1);

		// addLink is idempotent via onConflictDoNothing.
		await store.addLink(preset.id, "character", "char_1");
		expect(await store.getLinks(preset.id)).toHaveLength(1);

		await store.addLink(preset.id, "preset", "preset_9");
		await store.removeLink(preset.id, "preset", "preset_9");
		const remaining = await store.getLinks(preset.id);
		expect(remaining.map((l) => [l.targetType, l.targetId])).toEqual([["character", "char_1"]]);
	});
});

describe("resolveActiveRegexPresets", () => {
	test("each source is visible alone (global / character-bound / preset-bound)", async () => {
		const { store } = await setup();
		const globalP = await store.create(baseInput({ name: "g", isGlobal: true, sortOrder: 0 }));
		const charP = await store.create(baseInput({ name: "c", sortOrder: 1 }));
		const presetP = await store.create(baseInput({ name: "p", sortOrder: 2 }));
		await store.addLink(charP.id, "character", "char_1");
		await store.addLink(presetP.id, "preset", "preset_9");

		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).map((p) => p.name)).toEqual(["g"]);
		expect((await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).map((p) => p.name)).toEqual(["g", "c"]);
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: "preset_9" })).map((p) => p.name)).toEqual(["g", "p"]);
	});

	test("union of all three sources sorts by sortOrder with id tiebreak, dedups multi-source presets", async () => {
		const { store } = await setup();
		const g = await store.create(baseInput({ name: "global-one", isGlobal: true, sortOrder: 0 }));
		const c = await store.create(baseInput({ name: "char-one", sortOrder: 1 }));
		const p = await store.create(baseInput({ name: "preset-one", sortOrder: 2 }));
		const tieA = await store.create(baseInput({ name: "tie-a", isGlobal: true, sortOrder: 5 }));
		const tieB = await store.create(baseInput({ name: "tie-b", isGlobal: true, sortOrder: 5 }));
		void g;
		await store.addLink(c.id, "character", "char_1");
		await store.addLink(p.id, "preset", "preset_9");

		// Same preset reachable through BOTH junction sources appears once.
		const bothSources = await store.create(baseInput({ name: "both", sortOrder: 3 }));
		await store.addLink(bothSources.id, "character", "char_1");
		await store.addLink(bothSources.id, "preset", "preset_9");

		const resolved = await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: "preset_9" });
		expect(resolved.map((r) => r.name)).toEqual(["global-one", "char-one", "preset-one", "both", tieA.name, tieB.name]);
		// Equal sortOrder resolves by the stable id tiebreak (counter ids ascend
		// with creation order, so the earlier-created tieA sorts first).
		expect(resolved[4]!.id).toBe(tieA.id);
		expect(resolved[5]!.id).toBe(tieB.id);
	});

	test("excludes disabled presets from every source and ignores null ids", async () => {
		const { store } = await setup();
		await store.create(baseInput({ name: "disabled-global", isGlobal: true, disabled: true }));
		const disabledChar = await store.create(baseInput({ name: "disabled-char", disabled: true }));
		await store.addLink(disabledChar.id, "character", "char_1");

		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).toEqual([]);
		expect(await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).toEqual([]);
		expect(await store.resolveActiveRegexPresets({ characterId: "other_char", presetId: "other_preset" })).toEqual([]);
	});
});

describe("RegexStore delete cascades links", () => {
	test("deleting a preset removes its junction rows via FK cascade", async () => {
		const { store } = await setup();
		const preset = await store.create(baseInput());
		await store.addLink(preset.id, "character", "char_1");
		await store.addLink(preset.id, "preset", "preset_9");
		expect(await store.getLinks(preset.id)).toHaveLength(2);

		await store.delete(preset.id);
		expect(await store.getLinks(preset.id)).toEqual([]);
	});
});

// ── R-10 (REGEX_V13_FOLLOWUP): owner's policy B for character deletion ──
// CharacterRuntime.delete calls deleteLinksForTarget("character", id): links
// die with the character (nothing can resolve them again — chats cascade away
// via the characters FK; the R-7 bindings UI would render a ghost row), but
// the PRESETS themselves survive in the manager for manual rebinding.
describe("RegexStore deleteLinksForTarget (R-10 policy B)", () => {
	test("removes every link targeting the entity, keeps presets and other targets", async () => {
		const { store } = await setup();
		const a = await store.create(baseInput({ name: "a" }));
		const b = await store.create(baseInput({ name: "b" }));
		await store.addLink(a.id, "character", "char_doomed");
		await store.addLink(a.id, "character", "char_alive");
		await store.addLink(b.id, "character", "char_doomed");
		await store.addLink(b.id, "preset", "preset_9");

		await store.deleteLinksForTarget("character", "char_doomed");

		// Presets survive (policy B — manual rebinding stays possible).
		expect(await store.getById(a.id)).toBeTruthy();
		expect(await store.getById(b.id)).toBeTruthy();
		// Only the doomed character's links are gone; every other target intact.
		expect(await store.getLinks(a.id)).toHaveLength(1);
		expect((await store.getLinks(a.id))[0]!.targetId).toBe("char_alive");
		expect((await store.getLinks(b.id))[0]!.targetId).toBe("preset_9");
		// Idempotent — deleting an already-clean target is a no-op.
		await store.deleteLinksForTarget("character", "char_doomed");
		expect(await store.getLinks(a.id)).toHaveLength(1);
	});
});

describe("RegexStore profile CRUD + membership (R-13)", () => {
	test("createProfile → getProfileById round-trips; listProfiles sorts by sortOrder then name", async () => {
		const { store } = await setup();
		const a = await store.createProfile(baseProfile({ name: "p-b", sortOrder: 2 }));
		const b = await store.createProfile(baseProfile({ name: "p-a", sortOrder: 1 }));
		expect(a.id).toStartWith("regex_profile_");
		const loaded = await store.getProfileById(a.id);
		expect(loaded).toEqual(a);
		const all = await store.listProfiles();
		expect(all.map((p) => p.name)).toEqual(["p-a", "p-b"]);
	});

	test("updateProfile patches fields + bumps updatedAt; unknown id → null", async () => {
		const { store } = await setup();
		const created = await store.createProfile(baseProfile({ disabled: true }));
		const updated = await store.updateProfile(created.id, { name: "renamed", disabled: false, isGlobal: true, sortOrder: 9 });
		expect(updated).toMatchObject({ name: "renamed", disabled: false, isGlobal: true, sortOrder: 9 });
		expect(updated!.updatedAt).toBe(fixedClock.now());
		expect(await store.updateProfile("missing", { name: "x" })).toBeNull();
	});

	test("attachRule/detachRule move a rule between standalone and a profile; unknown rule → null", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile());
		const rule = await store.create(baseInput({ name: "member" }));
		const attached = await store.attachRule(profile.id, rule.id);
		expect(attached!.profileId).toBe(brandId<RegexProfileId>(profile.id));
		expect(await store.getById(rule.id)).toMatchObject({ profileId: brandId<RegexProfileId>(profile.id) });
		expect(await store.attachRule(profile.id, "missing_rule")).toBeNull();
		const detached = await store.detachRule(rule.id);
		expect(detached!.profileId).toBeNull();
		expect(await store.getById(rule.id)).toMatchObject({ profileId: null });
	});

	test("profile link API round-trips (set/add/remove/get) and replaces atomically", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile());
		const set = await store.setProfileLinks(profile.id, [
			{ targetType: "character", targetId: "char_1" },
			{ targetType: "preset", targetId: "preset_9" },
		]);
		expect(set).toHaveLength(2);
		const replaced = await store.setProfileLinks(profile.id, [{ targetType: "character", targetId: "char_2" }]);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]!.targetId).toBe("char_2");
		await store.addProfileLink(profile.id, "character", "char_1");
		await store.addProfileLink(profile.id, "character", "char_1"); // idempotent
		expect(await store.getProfileLinks(profile.id)).toHaveLength(2);
		await store.removeProfileLink(profile.id, "character", "char_2");
		expect(await store.getProfileLinks(profile.id)).toHaveLength(1);
	});

	test("listProfileMemberIds returns members ordered by sortOrder", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile());
		const r1 = await store.create(baseInput({ name: "r1", sortOrder: 5 }));
		const r2 = await store.create(baseInput({ name: "r2", sortOrder: 1 }));
		await store.attachRule(profile.id, r1.id);
		await store.attachRule(profile.id, r2.id);
		const members = await store.listProfileMemberIds(profile.id);
		expect(members).toEqual([r2.id, r1.id]);
	});

	test("deleteProfile keep → members survive standalone; cascade → members and their links die", async () => {
		const { store } = await setup();
		// keep
		const keepProfile = await store.createProfile(baseProfile({ name: "keep-p" }));
		const keepRule = await store.create(baseInput({ name: "keep-rule", isGlobal: true }));
		await store.addLink(keepRule.id, "character", "char_1");
		await store.attachRule(keepProfile.id, keepRule.id);
		await store.deleteProfile(keepProfile.id, "keep");
		expect(await store.getProfileById(keepProfile.id)).toBeNull();
		const survived = await store.getById(keepRule.id);
		expect(survived!.profileId).toBeNull();
		// Own binding data preserved through membership + survive on detach:
		// isGlobal stays true, its link stays, and now they resolve again.
		expect(survived!.isGlobal).toBe(true);
		expect(await store.getLinks(keepRule.id)).toHaveLength(1);
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).map((p) => p.id)).toContain(keepRule.id);
		// cascade
		const cascadeProfile = await store.createProfile(baseProfile({ name: "cascade-p" }));
		const cascadeRule = await store.create(baseInput({ name: "cascade-rule" }));
		await store.addLink(cascadeRule.id, "character", "char_cascade");
		await store.attachRule(cascadeProfile.id, cascadeRule.id);
		await store.deleteProfile(cascadeProfile.id, "cascade");
		expect(await store.getProfileById(cascadeProfile.id)).toBeNull();
		expect(await store.getById(cascadeRule.id)).toBeNull();
		expect(await store.getLinks(cascadeRule.id)).toHaveLength(0); // link rows were cascade-deleted with the rule FK
	});

	test("deleteProfileLinksForTarget removes profile links to the target, keeps the profile", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile());
		await store.addProfileLink(profile.id, "character", "char_doomed");
		await store.addProfileLink(profile.id, "character", "char_alive");
		await store.deleteProfileLinksForTarget("character", "char_doomed");
		expect(await store.getProfileById(profile.id)).toBeTruthy();
		expect(await store.getProfileLinks(profile.id)).toHaveLength(1);
		expect((await store.getProfileLinks(profile.id))[0]!.targetId).toBe("char_alive");
	});
});

describe("resolveActiveRegexPresets — R-13 profile gating matrix", () => {
	test("member of enabled+global profile fires", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ isGlobal: true }));
		const rule = await store.create(baseInput({ name: "gated-global", isGlobal: false, sortOrder: 0 }));
		await store.attachRule(profile.id, rule.id);
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).map((p) => p.id)).toEqual([rule.id]);
	});

	test("member of disabled profile does NOT fire", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ disabled: true }));
		const rule = await store.create(baseInput({ name: "gated-disabled" }));
		await store.attachRule(profile.id, rule.id);
		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).toEqual([]);
	});

	test("member of profile bound to the active character fires; unbound profile's member does not", async () => {
		const { store } = await setup();
		const boundProfile = await store.createProfile(baseProfile({ name: "bound" }));
		const unboundProfile = await store.createProfile(baseProfile({ name: "unbound" }));
		const boundRule = await store.create(baseInput({ name: "bound-rule" }));
		const unboundRule = await store.create(baseInput({ name: "unbound-rule" }));
		await store.attachRule(boundProfile.id, boundRule.id);
		await store.attachRule(unboundProfile.id, unboundRule.id);
		await store.addProfileLink(boundProfile.id, "character", "char_1");
		const resolved = await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null });
		expect(resolved.map((p) => p.id)).toEqual([boundRule.id]);
		// Not reachable via a different character, and unbound never fires.
		expect(await store.resolveActiveRegexPresets({ characterId: "char_other", presetId: null })).toEqual([]);
	});

	test("member's own isGlobal=1 or own matching links are INERT while it is a member", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ isGlobal: true }));
		// Rule insists on global AND is character-linked, but the profile gate
		// is what decides — the own config must be ignored while a member.
		const member = await store.create(baseInput({ name: "rebel", isGlobal: true, sortOrder: 3 }));
		await store.addLink(member.id, "character", "char_1");
		await store.attachRule(profile.id, member.id);
		const result = await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null });
		// Only profile-gated inclusion (profile global → member active)
		// matters; nothing changes for the bound-char angle either.
		expect(result.map((p) => p.id)).toEqual([member.id]);
	});

	test("standalone rule (profileId null) is never gated by any profile state", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ disabled: true })); // disabled profile exists in the DB
		const standaloneGlobal = await store.create(baseInput({ name: "standalone", isGlobal: true }));
		void profile;
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).map((p) => p.id)).toEqual([standaloneGlobal.id]);
	});

	test("disabled member rule does not fire even through an active profile", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ isGlobal: true }));
		const disabledMember = await store.create(baseInput({ name: "off", disabled: true }));
		await store.attachRule(profile.id, disabledMember.id);
		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).toEqual([]);
	});

	test("detached rule fires through its own links again (gating reactivates on exit)", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ disabled: true }));
		const rule = await store.create(baseInput({ name: "refugee", sortOrder: 2 }));
		await store.addLink(rule.id, "character", "char_1");
		await store.attachRule(profile.id, rule.id);
		// While a member of the disabled profile: inert via own links.
		expect(await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).toEqual([]);
		await store.detachRule(rule.id);
		// Standalone again: its own preserved link resolves.
		const resolved = await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null });
		expect(resolved.map((p) => p.id)).toEqual([rule.id]);
	});

	test("member of profile bound via the prompt preset fires for that preset", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile());
		const rule = await store.create(baseInput({ name: "preset-gated" }));
		await store.attachRule(profile.id, rule.id);
		await store.addProfileLink(profile.id, "preset", "preset_9");
		const resolved = await store.resolveActiveRegexPresets({ characterId: null, presetId: "preset_9" });
		expect(resolved.map((p) => p.id)).toEqual([rule.id]);
		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: "preset_other" })).toEqual([]);
	});

	test("member of a DISABLED profile is inert even if the profile's own link points at the chat", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ disabled: true }));
		const rule = await store.create(baseInput({ name: "dead-link" }));
		await store.attachRule(profile.id, rule.id);
		await store.addProfileLink(profile.id, "character", "char_1");
		expect(await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).toEqual([]);
	});

	test("profile-gated members sort into the flat order with standalone rules (shared sortOrder space)", async () => {
		const { store } = await setup();
		const profile = await store.createProfile(baseProfile({ isGlobal: true, sortOrder: 1 }));
		const before = await store.create(baseInput({ name: "solo-a", isGlobal: true, sortOrder: 0 }));
		const member = await store.create(baseInput({ name: "member", sortOrder: 1 }));
		const after = await store.create(baseInput({ name: "solo-b", isGlobal: true, sortOrder: 2 }));
		await store.attachRule(profile.id, member.id);
		const resolved = await store.resolveActiveRegexPresets({ characterId: null, presetId: null });
		expect(resolved.map((p) => p.name)).toEqual(["solo-a", "member", "solo-b"]);
	});
});

// ── RXU-12 (REGEX_RULE_PROFILE_UX_PORTABILITY): atomic Profile bundles ──
// One transaction creates the Profile + its links + every member rule BORN
// with the profileId on insert, or nothing. Rollback at each write stage is
// proven with the repo's RAISE(ABORT) trigger idiom (reorder-rollback.test.ts):
// a trigger kills exactly one stage's INSERT; the whole bundle must vanish.
describe("RegexStore.createProfileBundle — atomic bundle creation (RXU-12)", () => {
	test("one-rule bundle: profile + rule committed, rule born with the profile id on insert", async () => {
		const { store } = await setup();
		const result = await store.createProfileBundle(baseBundle({ name: "solo" }));
		expect(result.profile.id).toStartWith("regex_profile_");
		expect(result.rules).toHaveLength(1);
		const rule = result.rules[0]!;
		// Born in the profile — the initial INSERT already carries the id.
		expect(rule.profileId).toBe(brandId<RegexProfileId>(result.profile.id));
		// The returned bundle is the committed state, not a pre-commit frame.
		expect(await store.getProfileById(result.profile.id)).toEqual(result.profile);
		expect(await store.getById(rule.id)).toEqual(rule);
		expect(await store.listProfileMemberIds(result.profile.id)).toEqual([rule.id]);
	});

	test("many-rule bundle: order preserved, mixed source states survive insert (no normalization)", async () => {
		const { store } = await setup();
		const result = await store.createProfileBundle(
			baseBundle({
				rules: [
					bundleRule({ name: "on-a", disabled: false, sortOrder: 2 }),
					bundleRule({ name: "off-b", disabled: true, sortOrder: 1 }),
					bundleRule({ name: "on-c", disabled: false, sortOrder: 3 }),
					bundleRule({ name: "off-d", disabled: true, sortOrder: 0 }),
				],
			}),
		);
		expect(result.rules.map((r) => r.name)).toEqual(["on-a", "off-b", "on-c", "off-d"]);
		expect(result.rules.map((r) => r.disabled)).toEqual([false, true, false, true]);
		for (const r of result.rules) {
			// Source state + membership round-trip from the DB, per rule.
			const reloaded = await store.getById(r.id);
			expect(reloaded!.disabled).toBe(r.disabled);
			expect(reloaded!.profileId).toBe(brandId<RegexProfileId>(result.profile.id));
		}
	});

	test("active global bundle: enabled members fire for every chat, disabled members do not", async () => {
		const { store } = await setup();
		await store.createProfileBundle(
			baseBundle({
				name: "active-global",
				disabled: false,
				isGlobal: true,
				rules: [bundleRule({ name: "on" }), bundleRule({ name: "off", disabled: true })],
			}),
		);
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).map((p) => p.name)).toEqual(["on"]);
	});

	test("inactive bundle: master switch off keeps every member inert while rows persist", async () => {
		const { store } = await setup();
		await store.createProfileBundle(
			baseBundle({ disabled: true, isGlobal: true, rules: [bundleRule({ name: "sleepy" })] }),
		);
		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).toEqual([]);
		// Inert, not absent — the bundle committed complete.
		expect((await store.listAll()).map((p) => p.name)).toEqual(["sleepy"]);
		expect(await store.listProfiles()).toHaveLength(1);
	});

	test("character-linked bundle fires for its character only; duplicate links dedup (composite PK)", async () => {
		const { store } = await setup();
		const { profile } = await store.createProfileBundle(
			baseBundle({
				name: "char-scoped",
				links: [
					{ targetType: "character", targetId: "char_1" },
					{ targetType: "character", targetId: "char_1" },
				],
				rules: [bundleRule({ name: "member" })],
			}),
		);
		const links = await store.getProfileLinks(profile.id);
		expect(links).toHaveLength(1); // deduped before insert — a mid-tx PK violation would abort the bundle
		expect(links[0]).toMatchObject({ targetType: "character", targetId: "char_1" });
		expect((await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: null })).map((p) => p.name)).toEqual(["member"]);
		expect(await store.resolveActiveRegexPresets({ characterId: "char_other", presetId: null })).toEqual([]);
	});

	test("preset-linked bundle fires for its prompt preset only", async () => {
		const { store } = await setup();
		await store.createProfileBundle(
			baseBundle({
				name: "preset-scoped",
				links: [{ targetType: "preset", targetId: "preset_9" }],
				rules: [bundleRule({ name: "p-member" })],
			}),
		);
		expect((await store.resolveActiveRegexPresets({ characterId: null, presetId: "preset_9" })).map((p) => p.name)).toEqual(["p-member"]);
		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: "preset_other" })).toEqual([]);
	});

	test("unbound bundle (non-global, no links) never fires anywhere", async () => {
		const { store } = await setup();
		await store.createProfileBundle(baseBundle({ name: "unbound", rules: [bundleRule({ name: "adrift" })] }));
		expect(await store.resolveActiveRegexPresets({ characterId: null, presetId: null })).toEqual([]);
		expect(await store.resolveActiveRegexPresets({ characterId: "char_1", presetId: "preset_9" })).toEqual([]);
	});

	test("rollback at the PROFILE write: zero rows in all three tables", async () => {
		const { store, db } = await setup();
		db.run(
			sql`CREATE TRIGGER fail_bundle_profile BEFORE INSERT ON regex_profiles WHEN NEW.name = 'doomed_bundle' BEGIN SELECT RAISE(ABORT, 'injected profile boom'); END`,
		);
		await expect(
			store.createProfileBundle(
				baseBundle({
					name: "doomed_bundle",
					links: [{ targetType: "character", targetId: "char_1" }],
					rules: [bundleRule({ name: "r1" }), bundleRule({ name: "r2" })],
				}),
			),
		).rejects.toThrow("injected profile boom");
		expect(await store.listProfiles()).toEqual([]);
		expect(await store.listAll()).toEqual([]);
		expect(db.select().from(regexProfileLinks).all()).toEqual([]);
	});

	test("rollback at the LINK write: the already-inserted profile row vanishes too", async () => {
		const { store, db } = await setup();
		db.run(
			sql`CREATE TRIGGER fail_bundle_link BEFORE INSERT ON regex_profile_links WHEN NEW.target_id = 'char_1' BEGIN SELECT RAISE(ABORT, 'injected link boom'); END`,
		);
		await expect(
			store.createProfileBundle(
				baseBundle({
					name: "linked",
					links: [{ targetType: "character", targetId: "char_1" }],
					rules: [bundleRule()],
				}),
			),
		).rejects.toThrow("injected link boom");
		expect(await store.listProfiles()).toEqual([]); // profile write rolled back with the failed link
		expect(await store.listAll()).toEqual([]);
		expect(db.select().from(regexProfileLinks).all()).toEqual([]);
	});

	test("rollback at a LATER-RULE write: profile, links, and earlier rules all vanish", async () => {
		const { store, db } = await setup();
		db.run(
			sql`CREATE TRIGGER fail_bundle_rule BEFORE INSERT ON regex_presets WHEN NEW.name = 'late_bomb' BEGIN SELECT RAISE(ABORT, 'injected rule boom'); END`,
		);
		await expect(
			store.createProfileBundle(
				baseBundle({
					name: "multi",
					links: [{ targetType: "preset", targetId: "preset_9" }],
					rules: [bundleRule({ name: "early_ok" }), bundleRule({ name: "late_bomb" })],
				}),
			),
		).rejects.toThrow("injected rule boom");
		expect((await store.listAll()).map((p) => p.name)).toEqual([]); // early_ok rolled back
		expect(await store.listProfiles()).toEqual([]);
		expect(db.select().from(regexProfileLinks).all()).toEqual([]);
	});
});
