/**
 * The sidechat profile-switch separator (DIRECTOR_MODE_PLAN DR-12) — the
 * writer behind the `profile_changed` timeline event (the feed label key
 * `sidechat_event_profile_changed`, the «from → to» pattern of mock §5) in
 * the user's feed, frozen like every stored event, with
 * the from/to profile ids AND display names resolved at WRITE time.
 *
 * SERVER-SIDE UNIFORMITY: the write hangs off the (chat, kind) assignment
 * change itself (`agentChatPatchSettings` — the ONE write behind the chip
 * menu, the settings dropdown, the DR-7 hand-off row and `callDirector`),
 * so every switch surface produces the same separator; the web never
 * appends it on its own. The write fires only when the EFFECTIVE profile
 * actually changed (from ≠ to through the resolver's chain) — re-pinning
 * the same effective profile writes nothing.
 *
 * TWO LANDINGS, one mechanism:
 * - the pair HAS active threads → the event is appended to EVERY active
 *   thread of the pair (the assignment is chat-wide; each branch's live
 *   feed shows the switch at its own timeline point; archived feeds never
 *   move — they are history);
 * - the pair has NO active thread (callDirector on a chat whose sidechat
 *   never opened) → the payload is parked as the pair's PENDING change
 *   (chat_agent_settings.pending_profile_change_json) and materialized
 *   into the feed of the NEXT session created for the pair — the shell's
 *   bootstrap creates that session on open, which is the mock §4 flow.
 *   The marker is consumed by the first session that materializes it; a
 *   later unrelated session shows nothing (bounded — one separator per
 *   switch, landing either in the live feeds at the switch point or in
 *   the next-born feed).
 *
 * MODEL-VISIBILITY: `profile_changed` is user-feed provenance ONLY — the
 * context loader and the compaction service SKIP it (the new profile's own
 * prompt carries the switch to the model; the frozen RP context is about
 * the RP chat). Only the events route serves it to the web.
 */
import { log } from "@vibe-tavern/domain";
import type { ExperienceCopilotStore, ChatAgentSettingsStore } from "@vibe-tavern/db";
import type { CopilotProfile } from "@vibe-tavern/api-contracts";

const logger = log.tag("sidechat-profile-change");

/** One side of the frozen payload: the profile id plus the display name as
 *  resolved at write time (a built-in's server seed name — the WEB
 *  localizes built-in ids itself; a user profile's stored name, frozen
 *  so a later rename never rewrites history). */
export interface ProfileChangedSide {
	readonly id: string;
	readonly name: string;
}

/** The `profile_changed` event payload — the from/to pair, frozen at the
 *  assignment change. Lives HERE (with the writer), like `RpSyncPayload`
 *  lives with the RP sync writer; the timeline parser and the wire schema
 *  mirror this shape. */
export interface ProfileChangedPayload {
	readonly from: ProfileChangedSide;
	readonly to: ProfileChangedSide;
}

/** Freeze one resolved profile into the payload's side shape. */
function freezeSide(profile: CopilotProfile): ProfileChangedSide {
	return { id: profile.id, name: profile.name };
}

/** The stores this writer touches — `Pick`s so tests and callers pass the
 *  narrow seams instead of whole containers. */
export interface SidechatProfileChangeDeps {
	readonly experienceCopilot: Pick<
		ExperienceCopilotStore,
		"listActiveChatThreadsForPair" | "appendContextEvent"
	>;
	readonly chatAgentSettings: Pick<ChatAgentSettingsStore, "setPendingProfileChange" | "getPendingProfileChange">;
}

/**
 * Record one effective-profile change for a (chat, kind) pair: append the
 * frozen `profile_changed` event to every active thread of the pair, or —
 * when the pair has no active thread — park the payload as the pair's
 * pending change for the next session creation (see the module doc).
 * Best-effort by design: the assignment write has already committed when
 * this runs, so a separator failure is logged and never fails the PATCH —
 * the feed keeps working, only the separator is lost.
 */
export async function recordSidechatProfileChange(
	deps: SidechatProfileChangeDeps,
	input: { chatId: string; agentKind: string; from: CopilotProfile; to: CopilotProfile },
): Promise<void> {
	if (input.from.id === input.to.id) return;
	const payload: ProfileChangedPayload = {
		from: freezeSide(input.from),
		to: freezeSide(input.to),
	};
	try {
		const threads = await deps.experienceCopilot.listActiveChatThreadsForPair(input.chatId, input.agentKind);
		if (threads.length > 0) {
			for (const thread of threads) {
				await deps.experienceCopilot.appendContextEvent(thread.id, "profile_changed", payload);
			}
			return;
		}
		// No live feed to land in — park for the next session creation.
		await deps.chatAgentSettings.setPendingProfileChange(input.chatId, input.agentKind, payload);
	} catch (err) {
		logger.warn(
			"profile-change separator for chat %s kind %s (%s → %s) failed to record: %s",
			input.chatId,
			input.agentKind,
			payload.from.id,
			payload.to.id,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Materialize the pair's PENDING profile change (if any) into a freshly
 * created session's feed — the DR-12 landing for switches that happened
 * while the pair had no active thread (callDirector on a sidechat that
 * never opened). The marker is consumed by the first session that lands
 * it; a malformed marker is cleared and skipped (logged, never fatal — a
 * corrupt payload must not break session creation).
 */
export async function materializePendingSidechatProfileChange(
	deps: SidechatProfileChangeDeps,
	input: { chatId: string; agentKind: string; threadId: string },
): Promise<void> {
	try {
		const pending = await deps.chatAgentSettings.getPendingProfileChange(input.chatId, input.agentKind);
		if (pending === null) return;
		if (!isProfileChangedPayload(pending)) {
			logger.warn(
				"pending profile-change marker for chat %s kind %s is not the frozen shape — clearing it",
				input.chatId,
				input.agentKind,
			);
			await deps.chatAgentSettings.setPendingProfileChange(input.chatId, input.agentKind, null);
			return;
		}
		// Consume FIRST (append + clear), so a failure between the two never
		// duplicates the event on a retry: the clear runs before the append.
		await deps.chatAgentSettings.setPendingProfileChange(input.chatId, input.agentKind, null);
		await deps.experienceCopilot.appendContextEvent(input.threadId, "profile_changed", pending);
	} catch (err) {
		logger.warn(
			"pending profile-change materialization for chat %s kind %s thread %s failed: %s",
			input.chatId,
			input.agentKind,
			input.threadId,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/** Structural guard for the parked marker — the same frozen shape the
 *  parser enforces on stored rows, applied BEFORE appending a pending row
 *  (a malformed marker is corruption, not a write error). */
function isProfileChangedPayload(value: unknown): value is ProfileChangedPayload {
	function isSide(side: unknown): side is ProfileChangedSide {
		return (
			typeof side === "object" && side !== null &&
			typeof (side as ProfileChangedSide).id === "string" &&
			typeof (side as ProfileChangedSide).name === "string"
		);
	}
	return typeof value === "object" && value !== null && isSide((value as ProfileChangedPayload).from) && isSide((value as ProfileChangedPayload).to);
}
