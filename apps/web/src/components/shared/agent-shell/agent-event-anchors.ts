import type { AgentThreadEventWire } from "@vibe-tavern/api-contracts";

/**
 * AgentMessageList's SC-19b event anchoring (extracted under the
 * file-size ratchet — pure, verbatim): frozen thread events interleave as
 * separators BEFORE their anchor message; a null anchor — or an anchor
 * naming no visible row — trails at the end, after the persisted rows
 * (before the live pending rows, which only exist mid-turn and are cleared
 * on the settle+refetch that refreshes these events).
 */
export function agentEventAnchors<T extends Pick<AgentThreadEventWire, "id" | "beforeMessageId">>(
	events: readonly T[],
	visibleMessageIds: ReadonlySet<string>,
	rawMessageIds?: readonly string[],
): {
	eventAnchors: Map<string, T[]>;
	trailingEvents: T[];
} {
	const anchors = new Map<string, T[]>();
	const trailing: T[] = [];
	if (events.length === 0) return { eventAnchors: anchors, trailingEvents: trailing };
	for (const event of events) {
		let anchor = event.beforeMessageId;
		if (anchor !== null && !visibleMessageIds.has(anchor) && rawMessageIds) {
			const index = rawMessageIds.indexOf(anchor);
			if (index >= 0) anchor = rawMessageIds.slice(index + 1).find(id => visibleMessageIds.has(id)) ?? null;
		}
		if (anchor !== null && visibleMessageIds.has(anchor)) {
			const list = anchors.get(anchor);
			if (list) list.push(event);
			else anchors.set(anchor, [event]);
		} else {
			trailing.push(event);
		}
	}
	return { eventAnchors: anchors, trailingEvents: trailing };
}
