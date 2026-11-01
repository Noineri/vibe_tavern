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
 * Integration also drives real stores and RPC/fetch: server reload, legacy
 * upload, degraded anchors and store→PUT/DELETE synchronization (BR-2c).
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
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
	isReviewRound,
	syncPersistedCopilotRound,
} from "./experience-copilot-draft.js";
import { useAgentTurnStore } from "../stores/agent-turn-store.js";
import { EMPTY_REVIEW_ROUND, useAgentReviewRoundStore, type AgentReviewRound } from "../stores/agent-review-store.js";
import type { AgentToolActivity } from "../stores/agent-turn-store.js";

useDomEnv();
const originalFetch = globalThis.fetch;
const originalTurns = useAgentTurnStore.getState();
const originalRounds = useAgentReviewRoundStore.getState();
afterAll(() => {
  globalThis.fetch = originalFetch;
  useAgentTurnStore.setState(originalTurns, true);
  useAgentReviewRoundStore.setState(originalRounds, true);
});

function rulesActivity(toolCallId: string, proposed: string, summary = "Made rules assertive."): AgentToolActivity {
	return { toolCallId, toolName: "write_buffer", status: "done", target: "rules", proposed, summary };
}

function visualActivity(toolCallId: string, proposed: string, summary = "Made visual bold."): AgentToolActivity {
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
		const activities: AgentToolActivity[] = [
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
		] as AgentToolActivity[];
		expect(finalizeForPersistence(activities).map((a) => a.toolCallId)).toEqual(["c2"]);
	});

	it("serializeDraft returns null when there is nothing reviewable", () => {
		expect(serializeDraft([], null)).toBeNull();
		expect(serializeDraft([{ toolCallId: "c1", toolName: "write_buffer", status: "streaming" }], null)).toBeNull();
		// Snapshots alone rehydrate nothing without a proposal source (no
		// activities, no dangling) — a resolved round clears the key.
		expect(serializeDraft([], { ...EMPTY_REVIEW_ROUND, snapshots: [{ id: 1, rules: RULES_A, visual: VISUAL_A }] })).toBeNull();
	});

	it("serializeDraft keeps the key alive for a dangling-only round (CD-8 capture)", () => {
		const round: AgentReviewRound = {
			...EMPTY_REVIEW_ROUND,
			dangling: { rules: RULES_B, baseRules: RULES_A, baseVisual: VISUAL_A },
		};
		const json = serializeDraft([], round);
		expect(json).not.toBeNull();
		const back = parseDraft(json);
		expect(back?.activities).toEqual([]);
		expect(back?.round?.dangling?.rules).toBe(RULES_B);
	});

	it("serializeDraft → parseDraft round-trips finalized activities + the round", () => {
		const activities = [rulesActivity("c1", RULES_A, "s1"), visualActivity("c2", VISUAL_A)];
		const round: AgentReviewRound = {
			snapshots: [{ id: 3, rules: RULES_A, visual: VISUAL_A }],
			nextSnapshotId: 4,
			acceptedRules: [0],
			acceptedVisual: [],
			dismissedRules: [1],
			dismissedVisual: [],
			rulesKey: "k",
			visualKey: null,
			dangling: null,
		};
		const json = serializeDraft(activities, round);
		expect(json).not.toBeNull();
		const back = parseDraft(json);
		expect(back?.activities).toEqual(activities);
		expect(back?.round).toEqual(round);
	});

	it("parseDraft loads a V1 envelope degraded (activities only, round null)", () => {
		const v1 = JSON.stringify({ _v: 1, activities: [rulesActivity("c1", RULES_A)] });
		const back = parseDraft(v1);
		expect(back?.activities.map((a) => a.toolCallId)).toEqual(["c1"]);
		expect(back?.round).toBeNull();
	});

	it("parseDraft degrades a malformed V2 round to null while keeping the activities", () => {
		const envelope = JSON.stringify({ _v: 2, activities: [rulesActivity("c1", RULES_A)], round: { snapshots: "nope" } });
		const back = parseDraft(envelope);
		expect(back?.activities.map((a) => a.toolCallId)).toEqual(["c1"]);
		expect(back?.round).toBeNull();
	});

	it("isReviewRound validates the round shape field by field", () => {
		expect(isReviewRound(EMPTY_REVIEW_ROUND)).toBe(true);
		expect(isReviewRound({ ...EMPTY_REVIEW_ROUND, nextSnapshotId: "3" })).toBe(false);
		expect(isReviewRound({ ...EMPTY_REVIEW_ROUND, acceptedRules: [0.5] })).toBe(false);
		expect(isReviewRound({ ...EMPTY_REVIEW_ROUND, rulesKey: 7 })).toBe(false);
		expect(isReviewRound({ ...EMPTY_REVIEW_ROUND, dangling: { baseRules: RULES_A } })).toBe(false);
		expect(isReviewRound(null)).toBe(false);
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
			_v: 2,
			activities: [
				rulesActivity("c1", RULES_A),
				{ toolCallId: "c2", status: "done" }, // missing target/proposed
				"garbage",
				null,
			],
			round: null,
		});
		const back = parseDraft(envelope);
		expect(back?.activities.map((a) => a.toolCallId)).toEqual(["c1"]);
	});

	it("parseDraft returns null when all entries are filtered out", () => {
		const envelope = JSON.stringify({ _v: 2, activities: [{ toolCallId: "c1", status: "done" }], round: null });
		expect(parseDraft(envelope)).toBeNull();
	});

	it("parseDraft returns null for null/absent input", () => {
		expect(parseDraft(null)).toBeNull();
	});
});

describe("experience-copilot-draft — localStorage I/O", () => {

	beforeEach(() => {
		localStorage.clear();
		useAgentTurnStore.setState({ turnsByThread: {} });
	});

	it("saveDraft → loadDraft round-trips a finalized proposal", () => {
		const activities = [rulesActivity("c1", RULES_A)];
		saveDraft("thread_1", activities, null);
		expect(loadDraft("thread_1")?.activities).toEqual(activities);
		expect(loadDraft("thread_1")?.round).toBeNull();
	});

	it("saveDraft with no finalized activities removes the key", () => {
		saveDraft("thread_1", [rulesActivity("c1", RULES_A)], null);
		expect(loadDraft("thread_1")).not.toBeNull();
		// A subsequent save with only transient activities clears it.
		saveDraft("thread_1", [{ toolCallId: "c1", toolName: "write_buffer", status: "streaming" }], null);
		expect(loadDraft("thread_1")).toBeNull();
	});

	it("clearDraft removes the key", () => {
		saveDraft("thread_1", [rulesActivity("c1", RULES_A)], null);
		clearDraft("thread_1");
		expect(loadDraft("thread_1")).toBeNull();
	});

	it("loadDraft returns null for an unknown thread", () => {
		expect(loadDraft("never")).toBeNull();
	});

	it("loadAllDrafts returns a threadId→draft map and prunes invalid entries", () => {
		saveDraft("thread_a", [rulesActivity("c1", RULES_A)], null);
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
		saveDraft("thread_a", [rulesActivity("c1", RULES_A)], null);
		const all = loadAllDrafts();
		expect(Object.keys(all)).toEqual(["thread_a"]);
	});
});

describe("experience-copilot-draft — store rehydration (the reload contract)", () => {
  let reviews: Map<string, AgentReviewEnvelope>;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
    reviews = new Map();
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input), "http://gateway.test").pathname;
      if (path.endsWith("/api/agent-runs")) return Response.json([]);
      const id = path.match(/\/experience-copilot\/([^/]+)\/review$/)?.[1];
      if (!id) throw new Error(`Unexpected draft request: ${path}`);
      if (init?.method === "PUT") reviews.set(id, JSON.parse(String(init.body)));
      if (init?.method === "DELETE") { reviews.delete(id); return Response.json({ ok: true }); }
      return Response.json(reviews.get(id) ?? null);
    }) as typeof fetch;
		localStorage.clear();
		useAgentTurnStore.setState({ turnsByThread: {} });
		useAgentReviewRoundStore.setState({ roundsByThread: {} });
	});

  it("rehydrateExperienceCopilotDrafts uploads legacy data and seeds BOTH stores", async () => {
		// Simulate a previous session having persisted a proposal + review round.
		const round: AgentReviewRound = {
			snapshots: [{ id: 1, rules: RULES_A, visual: VISUAL_A }],
			nextSnapshotId: 2,
			acceptedRules: [],
			acceptedVisual: [],
			dismissedRules: [1],
			dismissedVisual: [],
			rulesKey: "k",
			visualKey: null,
			dangling: null,
		};
		saveDraft("thread_1", [rulesActivity("c1", RULES_A), visualActivity("c2", VISUAL_A)], round);
		// Fresh page load: both stores start empty.
		useAgentTurnStore.setState({ turnsByThread: {} });
		useAgentReviewRoundStore.setState({ roundsByThread: {} });
    await rehydrateExperienceCopilotDrafts("thread_1");
		const acts = useAgentTurnStore.getState().getActivities("experience", "thread_1");
		expect(acts.map((a) => a.toolCallId)).toEqual(["c1", "c2"]);
		expect(acts[0].proposed).toBe(RULES_A);
    expect(useAgentReviewRoundStore.getState().roundsByThread["thread_1"]).toEqual(round);
    expect(reviews.get("thread_1")!.round).toEqual(round);
    expect(loadDraft("thread_1")).toBeNull();
  });

  it("rehydrateExperienceCopilotDrafts is a no-op for other threads when nothing is persisted", async () => {
		useAgentTurnStore.setState({ turnsByThread: { thread_x: [rulesActivity("c9", RULES_A)] } });
		const before = useAgentTurnStore.getState().turnsByThread;
    await rehydrateExperienceCopilotDrafts("empty_thread");
		// Merge of {} is a no-op → dict reference unchanged.
		expect(useAgentTurnStore.getState().turnsByThread).toBe(before);
	});

  it("syncPersistedCopilotRound mirrors both stores into the API and deletes a cleared round", async () => {
    await rehydrateExperienceCopilotDrafts("write_thread");
		// A pending proposal + a half-reviewed round in the stores.
		useAgentTurnStore.setState({
      turnsByThread: { write_thread: [rulesActivity("c1", RULES_A)] },
		});
    useAgentReviewRoundStore.getState().pushSnapshot("experience", "write_thread", { rules: RULES_A, visual: VISUAL_A });
    useAgentReviewRoundStore.getState().setAcceptedHunks("experience", "write_thread", "rules", [0]);
    await syncPersistedCopilotRound("write_thread");
    const back = reviews.get("write_thread");
		expect(back?.activities.map((a) => a.toolCallId)).toEqual(["c1"]);
		expect(back?.round?.snapshots).toHaveLength(1);
		expect(back?.round?.acceptedRules).toEqual([0]);

		// Once both sides resolve (activities cleared, no dangling), the key goes.
		useAgentTurnStore.setState({ turnsByThread: {} });
    useAgentReviewRoundStore.getState().resetRound("experience", "write_thread");
    await syncPersistedCopilotRound("write_thread");
    expect(reviews.has("write_thread")).toBe(false);
  });

  it("reload recovers a server-only round after both browser stores were discarded", async () => {
    const round: AgentReviewRound = { ...EMPTY_REVIEW_ROUND, snapshots: [{ id: 1, rules: RULES_A, visual: VISUAL_A }], nextSnapshotId: 2, acceptedRules: [0], dismissedVisual: [1], rulesKey: `${RULES_A}\0${RULES_B}`, dangling: { visual: "Pending", baseRules: RULES_A, baseVisual: VISUAL_A } };
    const saved: AgentReviewEnvelope = { _v: 2, activities: [rulesActivity("reload", RULES_B)], round };
    reviews.set("server_only", saved);
    await rehydrateExperienceCopilotDrafts("server_only");
    useAgentTurnStore.setState({ turnsByThread: {} });
    useAgentReviewRoundStore.setState({ roundsByThread: {} });
    await rehydrateExperienceCopilotDrafts("server_only");
    expect(useAgentTurnStore.getState().getActivities("experience", "server_only")).toEqual(saved.activities);
    expect(useAgentReviewRoundStore.getState().roundsByThread.server_only).toEqual(round);
    expect(localStorage.length).toBe(0);
  });

  for (const version of ["v1", "malformed-round"] as const) {
    it(`migrates ${version} without inventing a review anchor`, async () => {
      const id = `legacy_${version}`;
      localStorage.setItem(`vt:experience-copilot-draft:${id}`, JSON.stringify({ _v: version === "v1" ? 1 : 2, activities: [rulesActivity("legacy", RULES_A)], round: { snapshots: "bad" } }));
      await rehydrateExperienceCopilotDrafts(id);
      expect(reviews.get(id)!.round).toBeNull();
      expect(useAgentTurnStore.getState().getActivities("experience", id)).toHaveLength(1);
      expect(useAgentReviewRoundStore.getState().roundsByThread[id]?.snapshots ?? []).toEqual([]);
      expect(loadDraft(id)).toBeNull();
    });
  }
});
