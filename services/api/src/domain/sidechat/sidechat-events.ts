/**
 * Agent-thread events read (SIDECHAT_PLAN Wave 5 / SC-19a) — the logic
 * behind `GET /api/agent/threads/:threadId/events`: a chat-owned thread's
 * frozen-context events in merged-timeline order, each anchored to the
 * FIRST message row after it so the web can interleave separators (SC-19b)
 * without a `seq` on the message wire.
 *
 * Decisions, all inherited rather than re-derived:
 *
 * - ORDER: `listTimeline` (SC-1) is the single ordering source — messages
 *   and events interleaved by seq, exactly what the context loader walks.
 * - PAYLOAD: `mapTimelineEvent` (sidechat-context.ts) — the SAME parser the
 *   context loader and the compaction service run over frozen rows. One
 *   derivation; its refusal path included: a known kind whose stored
 *   payload does not match its frozen shape THROWS here exactly as it does
 *   for the loader (a corrupt event is surfaced, never silently dropped).
 * - OWNER: a thread that is not chat-owned (script-owned, draft) has no
 *   frozen events to serve — `[]`, not an error (only a MISSING thread is
 *   the 404 `notFound`, the sibling routes' convention).
 *
 * The anchor walk is ONE pass over the timeline (no per-event re-queries):
 * events are collected as they appear; the first message row that follows
 * anchors every still-unanchored event at once; events that never see a
 * following message keep `null` (the event is the newest row).
 */
import type { ExperienceCopilotStore } from "@vibe-tavern/db";
import type { AgentThreadEventWire } from "@vibe-tavern/api-contracts";
import { notFound } from "../../shared/errors.js";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import { mapTimelineEvent } from "./sidechat-context.js";

/** The stores this read touches — a `Pick` so tests and callers pass the
 *  narrow seam instead of a whole container. */
export interface SidechatEventsDeps {
	readonly store: Pick<ExperienceCopilotStore, "getById" | "listTimeline">;
}

/**
 * List one agent thread's frozen events for the events route (SC-19a).
 * Chat-owned: the mapped events in timeline order. Script-owned / draft:
 * `[]`. Missing: the 404 `notFound` DomainError.
 */
export async function listAgentThreadEvents(
	deps: SidechatEventsDeps,
	threadId: string,
): Promise<AgentThreadEventWire[]> {
	const thread = await deps.store.getById(threadId);
	if (thread === null) {
		throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
	}
	// Script-owned and draft rows carry no frozen events (only chat-owned
	// threads ever get context events written) — empty list, never an error.
	if (!isChatOwnedAgentThread(thread)) return [];

	const timeline = await deps.store.listTimeline(threadId);
	const events: AgentThreadEventWire[] = [];
	// Indices into `events` whose anchor is still open (no message row has
	// followed them yet). The first message row that arrives closes ALL of
	// them — consecutive events anchor to the same next message.
	const unanchored: number[] = [];
	for (const entry of timeline) {
		if (entry.rowType === "message") {
			for (const index of unanchored) {
				events[index].beforeMessageId = entry.id;
			}
			unanchored.length = 0;
			continue;
		}
		// The loader's own mapper — the payload/kind derivation and its
		// corrupt-payload refusal are inherited verbatim (one derivation). The
		// per-arm switch below only REPACKS the mapped value onto the wire item
		// (drop `rowType`, add the anchor); TS needs the arm-by-arm narrow to
		// keep kind ↔ payload correlated on the discriminated wire union.
		const mapped = mapTimelineEvent(threadId, entry);
		unanchored.push(events.length);
		switch (mapped.kind) {
			case "rp_sync":
				events.push({ id: entry.id, kind: mapped.kind, payload: mapped.payload, beforeMessageId: null });
				break;
			case "variants_attached":
				events.push({ id: entry.id, kind: mapped.kind, payload: mapped.payload, beforeMessageId: null });
				break;
			case "selection_changed":
				events.push({ id: entry.id, kind: mapped.kind, payload: mapped.payload, beforeMessageId: null });
				break;
			case "branch_forked":
				events.push({ id: entry.id, kind: mapped.kind, payload: mapped.payload, beforeMessageId: null });
				break;
			default:
				// `mapTimelineEvent` is TYPED against the renderer's union, which
				// also carries `rp_summary` — the LIVE summary arm (SC-6 renders
				// summaries from coverage; nothing ever stores one). A stored row
				// can never map there (the kind column's union is closed), so this
				// arm is compile-time-only: reaching it would mean SC-6's
				// never-stored invariant broke, and the route refuses loudly
				// instead of serving a kind the wire does not describe.
				throw new Error(
					`listAgentThreadEvents: thread ${threadId} event ${entry.id} mapped to rp_summary — summary events are never stored (SC-6); refusing to serve a corrupted row`,
				);
		}
	}
	// Whatever never met a following message stays `null` — those events are
	// the thread's newest rows.
	return events;
}
