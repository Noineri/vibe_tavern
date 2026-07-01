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
import { aggregateCoauthorProposal } from "./coauthor-apply-aggregate.js";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { draftToBody } from "../components/build/editors/vibe-md-sync.js";

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
