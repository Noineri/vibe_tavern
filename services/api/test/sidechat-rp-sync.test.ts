import { describe, it, expect } from "bun:test";
import type { AgentThreadRpFrontier } from "@vibe-tavern/db";
import type { RpBranchViewMessage } from "../src/domain/sidechat/rp-branch-view.js";
import {
	computeRpSync,
	type FrozenVariantTextLookup,
	type RpSyncPayload,
	type RpSyncPlannedEvent,
	type SelectionChangedPayload,
} from "../src/domain/sidechat/rp-sync.js";

/**
 * SC-2b — computeRpSync: the PURE RP sync diff (no DB, no container — T0
 * plain fixtures). New messages are detected by id, never by position: a
 * new message takes max(position) + 1 and deletes do not renumber, so
 * delete-last-then-new REUSES the deleted position — the scenario that
 * makes a position frontier silently lose the message. Pins the unit's
 * seven scenarios (first sync freezes the whole view; advance → delta
 * only; swipe → selection_changed with the FROZEN previous; edit →
 * nothing; delete-last-then-new → the new message syncs; a deleted
 * message → nothing; empty view → no events) plus the three rules this
 * unit owns: the frozen-text seam (a needed-but-missing lookup throws —
 * previous text is never silently omitted), event order (rp_sync first,
 * then selection_changed in position order), and the never-regressing
 * lastPosition marker.
 */

function viewMessage(id: string, position: number, text: string, variantId = `${id}-v1`): RpBranchViewMessage {
	return { id, position, role: "user", authorName: "Sable", variantId, text };
}

/** The standard three-message view all frontier fixtures below assume was
 *  already synced (m1..m3 at their -v1 variants, positions 0..2). */
function baseView(): RpBranchViewMessage[] {
	return [
		{ ...viewMessage("m1", 0, "The tavern door swings open."), role: "assistant", authorName: "Theron" },
		viewMessage("m2", 1, "I step inside."),
		{ ...viewMessage("m3", 2, "Welcome, traveler."), role: "assistant", authorName: "Theron" },
	];
}

/** The frontier after baseView() was synced once. */
function syncedFrontier(): AgentThreadRpFrontier {
	return {
		lastPosition: 2,
		selected: { m1: "m1-v1", m2: "m2-v1", m3: "m3-v1" },
	};
}

/** A frozen-text lookup over a plain `"<messageId>/<variantId>"` table —
 *  the stand-in for SC-2c's lookup built from stored event payloads. */
function frozenTable(entries: Record<string, string>): FrozenVariantTextLookup {
	return (messageId, variantId) => entries[`${messageId}/${variantId}`] ?? null;
}

/** Narrow a planned event to its payload (test-side narrowing guards). */
function asRpSync(event: RpSyncPlannedEvent | undefined): RpSyncPayload {
	if (!event || event.kind !== "rp_sync") throw new Error(`expected an rp_sync event, got ${event?.kind ?? "none"}`);
	return event.payload;
}

function asSelectionChanged(event: RpSyncPlannedEvent | undefined): SelectionChangedPayload {
	if (!event || event.kind !== "selection_changed") {
		throw new Error(`expected a selection_changed event, got ${event?.kind ?? "none"}`);
	}
	return event.payload;
}

describe("computeRpSync (SC-2b)", () => {
	it("first sync freezes the whole view — one rp_sync event, exact payload, full frontier", () => {
		const diff = computeRpSync({ lastPosition: -1, selected: {} }, baseView(), frozenTable({}));

		expect(diff.events).toHaveLength(1);
		const payload = asRpSync(diff.events[0]);
		expect(payload.fromPosition).toBe(0);
		expect(payload.toPosition).toBe(2);
		// Exactly these fields, no extras — the payload is SC-3a's contract.
		expect(payload.messages).toEqual([
			{ id: "m1", position: 0, role: "assistant", authorName: "Theron", variantId: "m1-v1", text: "The tavern door swings open." },
			{ id: "m2", position: 1, role: "user", authorName: "Sable", variantId: "m2-v1", text: "I step inside." },
			{ id: "m3", position: 2, role: "assistant", authorName: "Theron", variantId: "m3-v1", text: "Welcome, traveler." },
		]);
		expect(diff.frontier).toEqual({
			lastPosition: 2,
			selected: { m1: "m1-v1", m2: "m2-v1", m3: "m3-v1" },
		});
		// Payloads are plain JSON-safe values (SC-2c writes payload_json).
		expect(JSON.parse(JSON.stringify(diff.events))).toEqual(diff.events);
	});

	it("an advance → only the delta: one rp_sync carrying just the new message", () => {
		const view = [...baseView(), viewMessage("m4", 3, "A new turn arrives.")];

		const diff = computeRpSync(syncedFrontier(), view, frozenTable({}));

		expect(diff.events).toHaveLength(1);
		const payload = asRpSync(diff.events[0]);
		expect(payload.fromPosition).toBe(3);
		expect(payload.toPosition).toBe(3);
		expect(payload.messages).toEqual([
			{ id: "m4", position: 3, role: "user", authorName: "Sable", variantId: "m4-v1", text: "A new turn arrives." },
		]);
		expect(diff.frontier).toEqual({
			lastPosition: 3,
			selected: { m1: "m1-v1", m2: "m2-v1", m3: "m3-v1", m4: "m4-v1" },
		});
	});

	it("a swipe change → one selection_changed whose previous is the FROZEN pair", () => {
		const view = baseView();
		view[1] = { ...view[1]!, variantId: "m2-v2", text: "I slip inside, quietly." };

		const diff = computeRpSync(syncedFrontier(), view, frozenTable({ "m2/m2-v1": "I step inside." }));

		expect(diff.events).toHaveLength(1);
		expect(asSelectionChanged(diff.events[0])).toEqual({
			messageId: "m2",
			position: 1,
			previous: { variantId: "m2-v1", text: "I step inside." },
			current: { variantId: "m2-v2", text: "I slip inside, quietly." },
		});
		// The frontier now freezes the NEW variant — no re-fire next sync;
		// lastPosition is untouched (no new message).
		expect(diff.frontier).toEqual({
			lastPosition: 2,
			selected: { m1: "m1-v1", m2: "m2-v2", m3: "m3-v1" },
		});
	});

	it("an edit (text changed, same variant) → no events, frontier unchanged", () => {
		const view = baseView();
		view[1] = { ...view[1]!, text: "I step inside. (edited)" };

		const diff = computeRpSync(syncedFrontier(), view, frozenTable({}));

		// Frozen history is never re-contextualized: the edited text is not
		// recorded anywhere — not even the frontier's frozen mapping moves.
		expect(diff.events).toEqual([]);
		expect(diff.frontier).toEqual(syncedFrontier());
	});

	it("delete-last-then-new → the new message syncs despite the REUSED position", () => {
		// m3 (position 2, the last synced message) is deleted and a new
		// message takes max(position) + 1 = 2 — the id-based detection case.
		const view = [...baseView().slice(0, 2), viewMessage("m4", 2, "A reply after the delete.")];

		const diff = computeRpSync(syncedFrontier(), view, frozenTable({}));

		expect(diff.events).toHaveLength(1);
		const payload = asRpSync(diff.events[0]);
		expect(payload.fromPosition).toBe(2);
		expect(payload.toPosition).toBe(2);
		expect(payload.messages.map((message) => message.id)).toEqual(["m4"]);
		// The deleted m3 stays selected (the id set only grows); m4 freezes.
		expect(diff.frontier).toEqual({
			lastPosition: 2,
			selected: { m1: "m1-v1", m2: "m2-v1", m3: "m3-v1", m4: "m4-v1" },
		});
	});

	it("a message deleted after sync → no event, stays in the new frontier's selected", () => {
		const view = [baseView()[0]!, baseView()[2]!]; // m2 gone from the view

		const diff = computeRpSync(syncedFrontier(), view, frozenTable({}));

		expect(diff.events).toEqual([]);
		expect(diff.frontier).toEqual(syncedFrontier());
	});

	it("an empty view → no events, frontier kept (lastPosition never regresses)", () => {
		const diff = computeRpSync(syncedFrontier(), [], frozenTable({}));

		expect(diff.events).toEqual([]);
		expect(diff.frontier).toEqual(syncedFrontier());

		// The never-synced thread's empty view is equally inert.
		const first = computeRpSync({ lastPosition: -1, selected: {} }, [], frozenTable({}));
		expect(first.events).toEqual([]);
		expect(first.frontier).toEqual({ lastPosition: -1, selected: {} });
	});

	it("a selection change whose frozen text the lookup cannot supply → throws, never omits previous", () => {
		const view = baseView();
		view[1] = { ...view[1]!, variantId: "m2-v2", text: "I slip inside, quietly." };

		// The frontier claims m2/m2-v1 was synced; an empty frozen table is
		// frozen-history corruption — the diff refuses rather than emit an
		// event with a silently omitted previous.
		expect(() => computeRpSync(syncedFrontier(), view, frozenTable({}))).toThrow(
			/frozen text missing for message m2 variant m2-v1/,
		);
	});

	it("event order: rp_sync first, then selection_changed entries in ascending message position", () => {
		const view = baseView();
		view[0] = { ...view[0]!, variantId: "m1-v2", text: "The door creaks open instead." };
		view[2] = { ...view[2]!, variantId: "m3-v2", text: "Welcome, wary traveler." };
		view.push(viewMessage("m4", 3, "A new turn arrives."));

		const diff = computeRpSync(
			syncedFrontier(),
			view,
			frozenTable({ "m1/m1-v1": "The tavern door swings open.", "m3/m3-v1": "Welcome, traveler." }),
		);

		expect(diff.events.map((event) => event.kind)).toEqual(["rp_sync", "selection_changed", "selection_changed"]);
		expect(asSelectionChanged(diff.events[1]).messageId).toBe("m1");
		expect(asSelectionChanged(diff.events[2]).messageId).toBe("m3");
	});

	it("a late-appearing message BELOW the marker syncs without pulling lastPosition back", () => {
		// E.g. a summary range lifted after an earlier sync: m9 was always at
		// position 3 but only now enters the view. The marker stays at 5.
		const frontier: AgentThreadRpFrontier = { lastPosition: 5, selected: { m1: "m1-v1" } };
		const view = [viewMessage("m1", 0, "Old turn."), viewMessage("m9", 3, "Late-appearing turn.")];

		const diff = computeRpSync(frontier, view, frozenTable({}));

		expect(diff.events).toHaveLength(1);
		const payload = asRpSync(diff.events[0]);
		expect(payload.fromPosition).toBe(3);
		expect(payload.toPosition).toBe(3);
		expect(payload.messages.map((message) => message.id)).toEqual(["m9"]);
		expect(diff.frontier).toEqual({ lastPosition: 5, selected: { m1: "m1-v1", m9: "m9-v1" } });
	});
});
