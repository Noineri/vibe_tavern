/**
 * CA-15 — coauthor-draft persistence (cross-session proposal survival).
 *
 * Splits into two layers:
 *  - PURE: finalizeForPersistence / serializeDraft / parseDraft — the
 *    load-bearing contract (what persists, how it's versioned, how corruption
 *    / version-skew is rejected). No DOM, no localStorage.
 *  - I/O: saveDraft / loadDraft / clearDraft / loadAllDrafts / rehydrate —
 *    guarded localStorage round-trips. These need a DOM (happy-dom), so the
 *    file uses useDomEnv; the pure tests are unaffected by its presence.
 *
 * Plus an integration check that the store actions (upsertActivity /
 * clearTurn) drive persistence end-to-end — the wiring that makes a reload
 * rehydrate the in-review diff.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	finalizeForPersistence,
	serializeDraft,
	parseDraft,
	saveDraft,
	loadDraft,
	clearDraft,
	loadAllDrafts,
	rehydrateCoauthorDrafts,
} from "./coauthor-draft.js";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";

function profileActivity(toolCallId: string, proposed: string, summary = "Made personality assertive."): CoauthorToolActivity {
	return { toolCallId, toolName: "write_profile", status: "done", target: "profile", proposed, summary };
}

function greetingActivity(toolCallId: string, index: number, proposed: string): CoauthorToolActivity {
	return { toolCallId, toolName: "edit_greeting", status: "done", target: "greeting", proposed, greetingIndex: index };
}

const PROFILE_A = "---\nname: A\n---\n# PERSONALITY\nBold.";
const PROFILE_B = "---\nname: A\n---\n# PERSONALITY\nBolder.";

describe("coauthor-draft — pure serialization", () => {
	it("finalizeForPersistence keeps only done + proposed activities, dedupes by toolCallId in order", () => {
		const activities: CoauthorToolActivity[] = [
			{ toolCallId: "c1", toolName: "write_profile", status: "streaming" }, // transient → dropped
			profileActivity("c2", PROFILE_A),
			{ toolCallId: "c3", toolName: "write_profile", status: "error" }, // error → dropped
			greetingActivity("c4", 0, "Hi."),
			profileActivity("c2", PROFILE_B), // duplicate id, later wins
		];
		const out = finalizeForPersistence(activities);
		expect(out.map((a) => a.toolCallId)).toEqual(["c2", "c4"]);
		expect(out[0].proposed).toBe(PROFILE_B); // later duplicate wins
	});

	it("finalizeForPersistence drops a done activity missing target/proposed", () => {
		const activities = [
			{ toolCallId: "c1", toolName: "write_profile", status: "done" }, // no target/proposed
			profileActivity("c2", PROFILE_A),
		] as CoauthorToolActivity[];
		expect(finalizeForPersistence(activities).map((a) => a.toolCallId)).toEqual(["c2"]);
	});

	it("serializeDraft returns null when there is nothing to persist", () => {
		expect(serializeDraft([])).toBeNull();
		expect(serializeDraft([{ toolCallId: "c1", toolName: "write_profile", status: "streaming" }])).toBeNull();
	});

	it("serializeDraft → parseDraft round-trips finalized activities", () => {
		const activities = [profileActivity("c1", PROFILE_A, "s1"), greetingActivity("c2", 1, "Hello.")];
		const json = serializeDraft(activities);
		expect(json).not.toBeNull();
		const back = parseDraft(json);
		expect(back).toEqual(activities);
	});

	it("parseDraft returns null for malformed JSON", () => {
		expect(parseDraft("{not json")).toBeNull();
	});

	it("parseDraft returns null for a wrong-version envelope (version skew → discard)", () => {
		const future = JSON.stringify({ _v: 999, activities: [profileActivity("c1", PROFILE_A)] });
		expect(parseDraft(future)).toBeNull();
	});

	it("parseDraft returns null for a non-array activities field", () => {
		expect(parseDraft(JSON.stringify({ _v: 1, activities: "nope" }))).toBeNull();
	});

	it("parseDraft defensively filters entries failing the shape guard (partial corruption)", () => {
		const envelope = JSON.stringify({
			_v: 1,
			activities: [
				profileActivity("c1", PROFILE_A),
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

describe("coauthor-draft — localStorage I/O", () => {

	beforeEach(() => {
		localStorage.clear();
		useCoauthorTurnStore.setState({ turnsByChat: {} });
	});

	it("saveDraft → loadDraft round-trips a finalized proposal", () => {
		const activities = [profileActivity("c1", PROFILE_A)];
		saveDraft("chat_1", activities);
		expect(loadDraft("chat_1")).toEqual(activities);
	});

	it("saveDraft with no finalized activities removes the key", () => {
		saveDraft("chat_1", [profileActivity("c1", PROFILE_A)]);
		expect(loadDraft("chat_1")).not.toBeNull();
		// A subsequent save with only transient activities clears it.
		saveDraft("chat_1", [{ toolCallId: "c1", toolName: "write_profile", status: "streaming" }]);
		expect(loadDraft("chat_1")).toBeNull();
	});

	it("clearDraft removes the key", () => {
		saveDraft("chat_1", [profileActivity("c1", PROFILE_A)]);
		clearDraft("chat_1");
		expect(loadDraft("chat_1")).toBeNull();
	});

	it("loadDraft returns null for an unknown chat", () => {
		expect(loadDraft("never")).toBeNull();
	});

	it("loadAllDrafts returns a chatId→activities map and prunes invalid entries", () => {
		saveDraft("chat_a", [profileActivity("c1", PROFILE_A)]);
		// Write a corrupt entry directly — loadAllDrafts must skip+prune it.
		localStorage.setItem("vt:coauthor-draft:chat_b", "{corrupt");
		// And a wrong-version entry.
		localStorage.setItem("vt:coauthor-draft:chat_c", JSON.stringify({ _v: 999, activities: [] }));
		const all = loadAllDrafts();
		expect(Object.keys(all).sort()).toEqual(["chat_a"]);
		// Pruned in place:
		expect(localStorage.getItem("vt:coauthor-draft:chat_b")).toBeNull();
		expect(localStorage.getItem("vt:coauthor-draft:chat_c")).toBeNull();
	});

	it("loadAllDrafts ignores unrelated localStorage keys", () => {
		localStorage.setItem("vt:other", "x");
		saveDraft("chat_a", [profileActivity("c1", PROFILE_A)]);
		const all = loadAllDrafts();
		expect(Object.keys(all)).toEqual(["chat_a"]);
	});
});

describe("coauthor-draft — store integration (the reload contract)", () => {

	beforeEach(() => {
		localStorage.clear();
		useCoauthorTurnStore.setState({ turnsByChat: {} });
	});

	it("upsertActivity of a finalized proposal persists it to localStorage", () => {
		useCoauthorTurnStore.getState().upsertActivity("chat_1", profileActivity("c1", PROFILE_A));
		expect(loadDraft("chat_1")).toEqual([profileActivity("c1", PROFILE_A)]);
	});

	it("upsertActivity of a streaming placeholder does NOT persist (no finalized)", () => {
		useCoauthorTurnStore.getState().upsertActivity("chat_1", { toolCallId: "c1", toolName: "write_profile", status: "streaming" });
		expect(loadDraft("chat_1")).toBeNull();
	});

	it("clearTurn drops the persisted draft (Apply / Reject / turn-start)", () => {
		useCoauthorTurnStore.getState().upsertActivity("chat_1", profileActivity("c1", PROFILE_A));
		expect(loadDraft("chat_1")).not.toBeNull();
		useCoauthorTurnStore.getState().clearTurn("chat_1");
		expect(loadDraft("chat_1")).toBeNull();
	});

	it("rehydrateCoauthorDrafts seeds the store from localStorage (the reload)", () => {
		// Simulate a previous session having persisted a proposal.
		saveDraft("chat_1", [profileActivity("c1", PROFILE_A), greetingActivity("c2", 0, "Hi.")]);
		// Fresh page load: store starts empty.
		useCoauthorTurnStore.setState({ turnsByChat: {} });
		rehydrateCoauthorDrafts();
		const acts = useCoauthorTurnStore.getState().getActivities("chat_1");
		expect(acts.map((a) => a.toolCallId)).toEqual(["c1", "c2"]);
		expect(acts[0].proposed).toBe(PROFILE_A);
	});

	it("rehydrateCoauthorDrafts is a no-op when nothing is persisted", () => {
		useCoauthorTurnStore.setState({ turnsByChat: { chat_x: [profileActivity("c9", PROFILE_A)] } });
		const before = useCoauthorTurnStore.getState().turnsByChat;
		rehydrateCoauthorDrafts();
		// Merge of {} is a no-op → dict reference unchanged.
		expect(useCoauthorTurnStore.getState().turnsByChat).toBe(before);
	});

	it("full reload cycle: persist → clear store → rehydrate → proposal is back, then Apply clears it", () => {
		// Turn produces a proposal.
		useCoauthorTurnStore.getState().upsertActivity("chat_1", profileActivity("c1", PROFILE_A));
		// Page reloads: store resets, but localStorage survives.
		useCoauthorTurnStore.setState({ turnsByChat: {} });
		// Boot rehydrates the in-review proposal.
		rehydrateCoauthorDrafts();
		expect(useCoauthorTurnStore.getState().getActivities("chat_1")).toHaveLength(1);
		// The user Applies → clearTurn wipes both store and persisted draft.
		useCoauthorTurnStore.getState().clearTurn("chat_1");
		expect(useCoauthorTurnStore.getState().getActivities("chat_1")).toEqual([]);
		expect(loadDraft("chat_1")).toBeNull();
	});
});
