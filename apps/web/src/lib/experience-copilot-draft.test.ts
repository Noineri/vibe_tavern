/**
 * ER-10a — experience-copilot-draft persistence (cross-session proposal survival).
 *
 * Splits into two layers:
 *  - PURE: isFinalizedActivity / finalizeForPersistence / serializeDraft /
 *    parseDraft — the load-bearing contract (what persists, how it's versioned,
 *    how corruption / version-skew is rejected). No DOM, no localStorage.
 *  - I/O: saveDraft / loadDraft / clearDraft / loadAllDrafts — guarded
 *    localStorage round-trips. These need a DOM (happy-dom), so the file uses
 *    useDomEnv; the pure tests are unaffected by its presence.
 *
 * Plus an integration check that `rehydrateExperienceCopilotDrafts` seeds the
 * turn store from localStorage — the reload half of the contract. The
 * store→persistence half (`upsertActivity`/`clearTurn` → `saveDraft`/`clearDraft`)
 * is WIRED IN WAVE 4 and intentionally not tested here.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
	isFinalizedActivity,
	finalizeForPersistence,
	serializeDraft,
	parseDraft,
	saveDraft,
	loadDraft,
	clearDraft,
	loadAllDrafts,
	rehydrateExperienceCopilotDrafts,
} from "./experience-copilot-draft.js";
import { useExperienceCopilotTurnStore } from "../stores/experience-copilot-turn-store.js";
import type { ExperienceCopilotToolActivity } from "../stores/experience-copilot-turn-store.js";

useDomEnv();

function rulesActivity(toolCallId: string, proposed: string, summary = "Made rules assertive."): ExperienceCopilotToolActivity {
	return { toolCallId, toolName: "write_buffer", status: "done", target: "rules", proposed, summary };
}

function visualActivity(toolCallId: string, proposed: string, summary = "Made visual bold."): ExperienceCopilotToolActivity {
	return { toolCallId, toolName: "edit_buffer", status: "done", target: "visual", proposed, summary };
}

const RULES_A = "# RULES\nBold.";
const RULES_B = "# RULES\nBolder.";
const VISUAL_A = "visual: bold.";

describe("experience-copilot-draft — isFinalizedActivity", () => {
	it("accepts a done rules activity with non-empty proposed", () => {
		expect(isFinalizedActivity(rulesActivity("c1", RULES_A))).toBe(true);
	});

	it("accepts a done visual activity with non-empty proposed", () => {
		expect(isFinalizedActivity(visualActivity("c1", VISUAL_A))).toBe(true);
	});

	it("rejects streaming and error statuses", () => {
		expect(isFinalizedActivity({ toolCallId: "c1", toolName: "write_buffer", status: "streaming", target: "rules", proposed: RULES_A })).toBe(false);
		expect(isFinalizedActivity({ toolCallId: "c2", toolName: "write_buffer", status: "error", target: "rules", proposed: RULES_A })).toBe(false);
	});

	it("rejects a done activity without a valid target/proposed (read-only / summary-only tools)", () => {
		expect(isFinalizedActivity({ toolCallId: "c1", toolName: "read_skill_file", status: "done", readPath: "/skills/x.md" })).toBe(false);
		expect(isFinalizedActivity({ toolCallId: "c2", toolName: "run_test", status: "done", summary: "Tests pass." })).toBe(false);
		// A target with an empty proposed is not a proposal.
		expect(isFinalizedActivity({ toolCallId: "c3", toolName: "write_buffer", status: "done", target: "rules", proposed: "" })).toBe(false);
		// A non-string proposed is rejected defensively.
		expect(isFinalizedActivity({ toolCallId: "c4", toolName: "write_buffer", status: "done", target: "rules", proposed: 42 })).toBe(false);
	});

	it("rejects a non-object", () => {
		expect(isFinalizedActivity(null)).toBe(false);
		expect(isFinalizedActivity("nope")).toBe(false);
		expect(isFinalizedActivity(42)).toBe(false);
	});
});

describe("experience-copilot-draft — pure serialization", () => {
	it("finalizeForPersistence keeps only done + proposed activities, dedupes by toolCallId in order", () => {
		const activities: ExperienceCopilotToolActivity[] = [
			{ toolCallId: "c1", toolName: "write_buffer", status: "streaming" }, // transient → dropped
			rulesActivity("c2", RULES_A),
			{ toolCallId: "c3", toolName: "write_buffer", status: "error" }, // error → dropped
			visualActivity("c4", VISUAL_A),
			rulesActivity("c2", RULES_B), // duplicate id, later wins
		];
		const out = finalizeForPersistence(activities);
		expect(out.map((a) => a.toolCallId)).toEqual(["c2", "c4"]);
		expect(out[0].proposed).toBe(RULES_B); // later duplicate wins
	});

	it("finalizeForPersistence drops a done activity missing target/proposed", () => {
		const activities = [
			{ toolCallId: "c1", toolName: "run_test", status: "done", summary: "Tests pass." }, // no target/proposed
			rulesActivity("c2", RULES_A),
		] as ExperienceCopilotToolActivity[];
		expect(finalizeForPersistence(activities).map((a) => a.toolCallId)).toEqual(["c2"]);
	});

	it("serializeDraft returns null when there is nothing to persist", () => {
		expect(serializeDraft([])).toBeNull();
		expect(serializeDraft([{ toolCallId: "c1", toolName: "write_buffer", status: "streaming" }])).toBeNull();
	});

	it("serializeDraft → parseDraft round-trips finalized activities", () => {
		const activities = [rulesActivity("c1", RULES_A, "s1"), visualActivity("c2", VISUAL_A)];
		const json = serializeDraft(activities);
		expect(json).not.toBeNull();
		const back = parseDraft(json);
		expect(back).toEqual(activities);
	});

	it("parseDraft returns null for malformed JSON", () => {
		expect(parseDraft("{not json")).toBeNull();
	});

	it("parseDraft returns null for a wrong-version envelope (version skew → discard)", () => {
		const future = JSON.stringify({ _v: 999, activities: [rulesActivity("c1", RULES_A)] });
		expect(parseDraft(future)).toBeNull();
	});

	it("parseDraft returns null for a non-array activities field", () => {
		expect(parseDraft(JSON.stringify({ _v: 1, activities: "nope" }))).toBeNull();
	});

	it("parseDraft defensively filters entries failing the shape guard (partial corruption)", () => {
		const envelope = JSON.stringify({
			_v: 1,
			activities: [
				rulesActivity("c1", RULES_A),
				{ toolCallId: "c2", status: "done" }, // missing target/proposed
				"garbage",
				null,
			],
		});
		const back = parseDraft(envelope);
		expect(back?.map((a) => a.toolCallId)).toEqual(["c1"]);
	});

	it("parseDraft returns null when all entries are filtered out", () => {
		const envelope = JSON.stringify({ _v: 1, activities: [{ toolCallId: "c1", status: "done" }] });
		expect(parseDraft(envelope)).toBeNull();
	});

	it("parseDraft returns null for null/absent input", () => {
		expect(parseDraft(null)).toBeNull();
	});
});

describe("experience-copilot-draft — localStorage I/O", () => {

	beforeEach(() => {
		localStorage.clear();
		useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
	});

	it("saveDraft → loadDraft round-trips a finalized proposal", () => {
		const activities = [rulesActivity("c1", RULES_A)];
		saveDraft("thread_1", activities);
		expect(loadDraft("thread_1")).toEqual(activities);
	});

	it("saveDraft with no finalized activities removes the key", () => {
		saveDraft("thread_1", [rulesActivity("c1", RULES_A)]);
		expect(loadDraft("thread_1")).not.toBeNull();
		// A subsequent save with only transient activities clears it.
		saveDraft("thread_1", [{ toolCallId: "c1", toolName: "write_buffer", status: "streaming" }]);
		expect(loadDraft("thread_1")).toBeNull();
	});

	it("clearDraft removes the key", () => {
		saveDraft("thread_1", [rulesActivity("c1", RULES_A)]);
		clearDraft("thread_1");
		expect(loadDraft("thread_1")).toBeNull();
	});

	it("loadDraft returns null for an unknown thread", () => {
		expect(loadDraft("never")).toBeNull();
	});

	it("loadAllDrafts returns a threadId→activities map and prunes invalid entries", () => {
		saveDraft("thread_a", [rulesActivity("c1", RULES_A)]);
		// Write a corrupt entry directly — loadAllDrafts must skip+prune it.
		localStorage.setItem("vt:experience-copilot-draft:thread_b", "{corrupt");
		// And a wrong-version entry.
		localStorage.setItem("vt:experience-copilot-draft:thread_c", JSON.stringify({ _v: 999, activities: [] }));
		const all = loadAllDrafts();
		expect(Object.keys(all).sort()).toEqual(["thread_a"]);
		// Pruned in place:
		expect(localStorage.getItem("vt:experience-copilot-draft:thread_b")).toBeNull();
		expect(localStorage.getItem("vt:experience-copilot-draft:thread_c")).toBeNull();
	});

	it("loadAllDrafts ignores unrelated localStorage keys", () => {
		localStorage.setItem("vt:other", "x");
		saveDraft("thread_a", [rulesActivity("c1", RULES_A)]);
		const all = loadAllDrafts();
		expect(Object.keys(all)).toEqual(["thread_a"]);
	});
});

describe("experience-copilot-draft — store rehydration (the reload contract)", () => {

	beforeEach(() => {
		localStorage.clear();
		useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
	});

	it("rehydrateExperienceCopilotDrafts seeds the store from localStorage (the reload)", () => {
		// Simulate a previous session having persisted a proposal.
		saveDraft("thread_1", [rulesActivity("c1", RULES_A), visualActivity("c2", VISUAL_A)]);
		// Fresh page load: store starts empty.
		useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
		rehydrateExperienceCopilotDrafts();
		const acts = useExperienceCopilotTurnStore.getState().getActivities("thread_1");
		expect(acts.map((a) => a.toolCallId)).toEqual(["c1", "c2"]);
		expect(acts[0].proposed).toBe(RULES_A);
	});

	it("rehydrateExperienceCopilotDrafts is a no-op when nothing is persisted", () => {
		useExperienceCopilotTurnStore.setState({ turnsByThread: { thread_x: [rulesActivity("c9", RULES_A)] } });
		const before = useExperienceCopilotTurnStore.getState().turnsByThread;
		rehydrateExperienceCopilotDrafts();
		// Merge of {} is a no-op → dict reference unchanged.
		expect(useExperienceCopilotTurnStore.getState().turnsByThread).toBe(before);
	});
});
