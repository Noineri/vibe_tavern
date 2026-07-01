/**
 * CA-11.1 — coauthor-apply-aggregate (pure).
 *
 * Pins the aggregation that turns a co-author turn's tool activities into
 * (a) the proposed editor body (for the reviewing diff) and (b) the Apply
 * request sent to the CA-7 backend. The Apply request shape is the
 * load-bearing contract: the backend never sees AI SDK tool shapes, only the
 * canonical character fields, so a wrong aggregation = a wrong Apply.
 *
 * Covers: profile-only (last edit_profile wins), greeting edit (primary +
 * alternate), add_alt_greeting (append), mixed profile+greetings, sequential
 * dependent greeting calls, no-proposal fallthrough, and the exclusion of
 * streaming/error placeholders.
 */
import { describe, it, expect } from "bun:test";
import type { BuildCharacterDraft } from "@vibe-tavern/api-contracts";
import { parseProfileMd } from "@vibe-tavern/db/codecs";
import { aggregateCoauthorProposal, buildPartialApplyRequest } from "./coauthor-apply-aggregate.js";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { draftToBody } from "../components/build/editors/vibe-md-sync.js";
import { buildLineDiff } from "../components/shared/TextDiffPreview.js";
import { mergeSelectedBody, allHunkIds, groupHunks } from "./coauthor-hunk-merge.js";

function baseDraft(over: Partial<BuildCharacterDraft> = {}): BuildCharacterDraft {
	return {
		name: "Kira",
		description: "Calm weaver.",
		firstMessage: "Hello, fly.",
		mesExample: "{{char}}: *nods*",
		mesExampleMode: "always",
		mesExampleDepth: 4,
		scenario: "A cave.",
		personalitySummary: "",
		systemPrompt: "",
		alternateGreetings: ["Alt one."],
		postHistoryInstructions: "",
		creatorNotes: "",
		depthPrompt: "",
		depthPromptDepth: 4,
		depthPromptRole: "system",
		tags: ["oc"],
		...over,
	};
}

/** A canonical profile.md string (what edit_profile's backend execute returns). */
function profileMd(personality: string, scenario: string, examples: string, name = "Kira"): string {
	return [
		"---",
		`name: ${name}`,
		"tags: [oc]",
		"---",
		"",
		"# PERSONALITY",
		personality,
		"",
		"# SCENARIO",
		scenario,
		"",
		"# EXAMPLES",
		examples,
		"",
	].join("\n");
}

function profileActivity(toolCallId: string, proposed: string, summary = "Made personality assertive."): CoauthorToolActivity {
	return { toolCallId, toolName: "edit_profile", status: "done", target: "profile", proposed, summary };
}

function editGreetingActivity(toolCallId: string, index: number, content: string, summary = "Tweaked greeting."): CoauthorToolActivity {
	return { toolCallId, toolName: "edit_greeting", status: "done", target: "greeting", greetingIndex: index, proposed: content, summary };
}

function addGreetingActivity(toolCallId: string, content: string, summary = "Added an alt."): CoauthorToolActivity {
	return { toolCallId, toolName: "add_alt_greeting", status: "done", target: "greeting", isAdd: true, proposed: content, summary };
}

describe("aggregateCoauthorProposal — no proposal", () => {
	it("returns hasProposal=false and an empty request when there are no finalized activities", () => {
		const draft = baseDraft();
		const result = aggregateCoauthorProposal([], draft);
		expect(result.hasProposal).toBe(false);
		expect(result.applyRequest).toEqual({});
		expect(result.proposedDraft).toBe(draft); // unchanged reference
		expect(result.summaries).toEqual([]);
	});

	it("excludes streaming and error activities (only done+proposed count)", () => {
		const streaming: CoauthorToolActivity = { toolCallId: "t1", toolName: "edit_profile", status: "streaming" };
		const errored: CoauthorToolActivity = { toolCallId: "t2", toolName: "edit_profile", status: "error", target: "profile", proposed: "x" };
		const result = aggregateCoauthorProposal([streaming, errored], baseDraft());
		expect(result.hasProposal).toBe(false);
		expect(result.applyRequest).toEqual({});
	});
});

describe("aggregateCoauthorProposal — profile", () => {
	it("a single edit_profile → profileMd verbatim + parsed prose in proposedDraft", () => {
		const proposed = profileMd("Bold and direct.", "A torchlit cave.", "{{char}}: *grins*");
		const result = aggregateCoauthorProposal([profileActivity("t1", proposed)], baseDraft());
		expect(result.hasProposal).toBe(true);
		expect(result.applyRequest.profileMd).toBe(proposed); // verbatim (backend-canonicalized)
		expect(result.applyRequest.firstMessage).toBeUndefined(); // greetings untouched
		expect(result.applyRequest.alternateGreetings).toBeUndefined();
		expect(result.proposedDraft.description).toBe("Bold and direct.");
		expect(result.proposedDraft.scenario).toBe("A torchlit cave.");
		expect(result.proposedDraft.mesExample).toBe("{{char}}: *grins*");
		expect(result.summaries).toEqual(["Made personality assertive."]);
	});

	it("the LAST edit_profile wins when several revise the profile mid-turn", () => {
		const first = profileMd("First revision.", "S1", "E1");
		const second = profileMd("Second revision.", "S2", "E2");
		const result = aggregateCoauthorProposal(
			[profileActivity("t1", first, "v1"), profileActivity("t2", second, "v2")],
			baseDraft(),
		);
		expect(result.applyRequest.profileMd).toBe(second);
		expect(result.proposedDraft.description).toBe("Second revision.");
		expect(result.summaries).toEqual(["v1", "v2"]); // both summaries preserved in order
	});

	it("proposedDraft body differs from the canonical body on a real edit (diff is non-empty)", () => {
		const draft = baseDraft();
		const proposed = profileMd("Calm weaver.", "A cave.", "{{char}}: *nods*"); // identical prose
		const same = aggregateCoauthorProposal([profileActivity("t1", proposed)], draft);
		// Identical prose → identical bodies (no spurious diff).
		expect(draftToBody(same.proposedDraft)).toBe(draftToBody(draft));

		const changed = profileMd("Bold and direct.", "A cave.", "{{char}}: *nods*");
		const diff = aggregateCoauthorProposal([profileActivity("t2", changed)], draft);
		expect(draftToBody(diff.proposedDraft)).not.toBe(draftToBody(draft));
	});
});

describe("aggregateCoauthorProposal — greetings", () => {
	it("edit_greeting index 0 → firstMessage (applyRequest carries full greeting state)", () => {
		const result = aggregateCoauthorProposal(
			[editGreetingActivity("t1", 0, "Welcome, little morsel.")],
			baseDraft(),
		);
		expect(result.applyRequest.firstMessage).toBe("Welcome, little morsel.");
		expect(result.applyRequest.alternateGreetings).toEqual(["Alt one."]); // unchanged alt preserved
		expect(result.applyRequest.profileMd).toBeUndefined();
		expect(result.proposedDraft.firstMessage).toBe("Welcome, little morsel.");
	});

	it("edit_greeting index 1 → the first alternate greeting", () => {
		const result = aggregateCoauthorProposal(
			[editGreetingActivity("t1", 1, "A stormy night.")],
			baseDraft(),
		);
		expect(result.applyRequest.firstMessage).toBe("Hello, fly."); // primary unchanged
		expect(result.applyRequest.alternateGreetings).toEqual(["A stormy night."]);
	});

	it("add_alt_greeting → appends to the alternates", () => {
		const result = aggregateCoauthorProposal(
			[addGreetingActivity("t1", "A third opening.")],
			baseDraft(),
		);
		expect(result.applyRequest.alternateGreetings).toEqual(["Alt one.", "A third opening."]);
		expect(result.applyRequest.firstMessage).toBe("Hello, fly.");
	});

	it("sequential dependent greeting calls compose in order", () => {
		// Model renames primary, then edits the (now-shifted) alt it just added.
		const result = aggregateCoauthorProposal(
			[
				editGreetingActivity("t1", 0, "New primary."),
				addGreetingActivity("t2", "Fresh alt."),
				editGreetingActivity("t3", 2, "Revised fresh alt."), // index 2 = the just-appended slot
			],
			baseDraft(),
		);
		// greetings array after: ["New primary.", "Alt one.", "Fresh alt."] → t3 revises index 2
		expect(result.applyRequest.firstMessage).toBe("New primary.");
		expect(result.applyRequest.alternateGreetings).toEqual(["Alt one.", "Revised fresh alt."]);
	});
});

describe("aggregateCoauthorProposal — mixed profile + greetings", () => {
	it("profile + greeting in one turn → both fields present in the request", () => {
		const proposed = profileMd("Assertive.", "A cave.", "{{char}}: *grins*");
		const result = aggregateCoauthorProposal(
			[
				profileActivity("t1", proposed, "Rewrote personality."),
				editGreetingActivity("t2", 0, "Welcome, morsel.", "New greeting."),
			],
			baseDraft(),
		);
		expect(result.applyRequest.profileMd).toBe(proposed);
		expect(result.applyRequest.firstMessage).toBe("Welcome, morsel.");
		expect(result.applyRequest.alternateGreetings).toEqual(["Alt one."]); // unchanged
		expect(result.proposedDraft.description).toBe("Assertive.");
		expect(result.proposedDraft.firstMessage).toBe("Welcome, morsel.");
		expect(result.summaries).toEqual(["Rewrote personality.", "New greeting."]);
	});
});

/**
 * CA-12 — buildPartialApplyRequest: rebuild the Apply request from a hunk-level
 * (partial) selection. The merged body is what `mergeSelectedBody` produces
 * from the reviewing diff + the user's selected hunk ids. These tests pin that
 * the rebuilt request carries the model's proposed frontmatter but the MERGED
 * prose/greetings — and that fields the model never touched are omitted.
 */
describe("buildPartialApplyRequest — hunk-level (CA-12)", () => {
	it("ALL hunks selected → rebuilt profileMd is semantically equal to the wholesale proposal (CA-11 parity)", () => {
		const draft = baseDraft();
		const proposed = profileMd("Fierce.", "A cave at dusk.", "{{char}}: *grins*");
		const base = aggregateCoauthorProposal([profileActivity("t1", proposed)], draft);
		const diff = buildLineDiff(draftToBody(draft), draftToBody(base.proposedDraft));
		const merged = mergeSelectedBody(diff, allHunkIds(groupHunks(diff))); // all
		const req = buildPartialApplyRequest(merged, base);
		expect(req.profileMd).toBeDefined();
		// Production edit_profile returns an ALREADY-canonical profileMd
		// (serialize(parse(input))), so rebuild is byte-stable there. The test
		// helper builds a non-canonical string (no vt: block), so compare the
		// PARSED semantics instead — the load-bearing parity: same prose fields.
		const rebuilt = parseProfileMd(req.profileMd!);
		const wholesale = parseProfileMd(base.applyRequest.profileMd!);
		expect(rebuilt.profile.description).toBe(wholesale.profile.description);
		expect(rebuilt.profile.scenario).toBe(wholesale.profile.scenario);
		expect(rebuilt.profile.mesExample).toBe(wholesale.profile.mesExample);
		expect(rebuilt.profile.name).toBe(wholesale.profile.name);
	});

	it("subset: rejecting the personality hunk keeps canonical personality in the rebuilt profileMd", () => {
		const draft = baseDraft(); // personality "Calm weaver."
		const proposed = profileMd("Fierce and bold.", "A cave at dusk.", "{{char}}: *nods*");
		const base = aggregateCoauthorProposal([profileActivity("t1", proposed)], draft);
		const diff = buildLineDiff(draftToBody(draft), draftToBody(base.proposedDraft));
		const hunks = groupHunks(diff);
		// Reject ONLY the personality hunk (hunk id 0); accept the rest.
		const selected = new Set(hunks.filter((h) => h.id !== 0).map((h) => h.id));
		const merged = mergeSelectedBody(diff, selected);
		const req = buildPartialApplyRequest(merged, base);
		expect(req.profileMd).toBeDefined();
		// Personality reverted to canonical ("Calm weaver."); scenario reflects the
		// accepted proposal. The rebuilt profileMd is the arbiter the backend parses.
		expect(req.profileMd).toContain("Calm weaver.");
		expect(req.profileMd).not.toContain("Fierce and bold.");
		expect(req.profileMd).toContain("A cave at dusk.");
	});

	it("preserves the model's proposed FRONTMATTER (rename) regardless of hunk selection", () => {
		const draft = baseDraft();
		// Model renames to "Mira" AND rewrites personality. Frontmatter (name) is
		// NOT in the body diff, so even rejecting every body hunk keeps the rename.
		const proposed = profileMd("Fierce.", "A cave.", "{{char}}: *nods*", "Mira");
		const base = aggregateCoauthorProposal([profileActivity("t1", proposed)], draft);
		const diff = buildLineDiff(draftToBody(draft), draftToBody(base.proposedDraft));
		const merged = mergeSelectedBody(diff, new Set()); // reject ALL body hunks
		const req = buildPartialApplyRequest(merged, base);
		expect(req.profileMd).toContain("name: Mira"); // rename honored wholesale
	});

	it("greetings: merged selection → merged firstMessage/alternateGreetings; omits when no greeting tool fired", () => {
		const draft = baseDraft(); // firstMessage "Hello, fly.", alts ["Alt one."]
		const base = aggregateCoauthorProposal(
			[editGreetingActivity("t1", 0, "Welcome, morsel.", "New primary.")],
			draft,
		);
		const diff = buildLineDiff(draftToBody(draft), draftToBody(base.proposedDraft));
		// Reject the greeting hunk → reverted to canonical greeting.
		const mergedRevert = mergeSelectedBody(diff, new Set());
		const reqRevert = buildPartialApplyRequest(mergedRevert, base);
		expect(reqRevert.firstMessage).toBe("Hello, fly."); // canonical primary
		expect(reqRevert.alternateGreetings).toEqual(["Alt one."]);
		// Accept it → proposed primary.
		const mergedAccept = mergeSelectedBody(diff, allHunkIds(groupHunks(diff)));
		const reqAccept = buildPartialApplyRequest(mergedAccept, base);
		expect(reqAccept.firstMessage).toBe("Welcome, morsel.");
	});

	it("profile-only turn omits greetings from the rebuilt request", () => {
		const draft = baseDraft();
		const proposed = profileMd("Fierce.", "A cave.", "{{char}}: *nods*");
		const base = aggregateCoauthorProposal([profileActivity("t1", proposed)], draft);
		const diff = buildLineDiff(draftToBody(draft), draftToBody(base.proposedDraft));
		const req = buildPartialApplyRequest(mergeSelectedBody(diff), base);
		expect(req.firstMessage).toBeUndefined();
		expect(req.alternateGreetings).toBeUndefined();
		expect(req.profileMd).toBeDefined();
	});

	it("greeting-only turn omits profileMd from the rebuilt request", () => {
		const draft = baseDraft();
		const base = aggregateCoauthorProposal(
			[addGreetingActivity("t1", "A new dawn.")],
			draft,
		);
		const diff = buildLineDiff(draftToBody(draft), draftToBody(base.proposedDraft));
		const req = buildPartialApplyRequest(mergeSelectedBody(diff), base);
		expect(req.profileMd).toBeUndefined();
		expect(req.alternateGreetings).toBeDefined();
	});
});
