import type { AgentThreadEventWire } from "@vibe-tavern/api-contracts";

/**
 * AgentMessageList's SC-19b event anchoring (extracted under the
 * file-size ratchet — pure, verbatim): frozen thread events interleave as
 * separators BEFORE their anchor message; a null anchor — or an anchor
 * naming no visible row — trails at the end, after the persisted rows
 * (before the live pending rows, which only exist mid-turn and are cleared
 * on the settle+refetch that refreshes these events).
 */
export function agentEventAnchors(
	events: readonly AgentThreadEventWire[],
	visibleMessageIds: ReadonlySet<string>,
): {
	eventAnchors: Map<string, AgentThreadEventWire[]>;
	trailingEvents: AgentThreadEventWire[];
} {
	const anchors = new Map<string, AgentThreadEventWire[]>();
	const trailing: AgentThreadEventWire[] = [];
	if (events.length === 0) return { eventAnchors: anchors, trailingEvents: trailing };
	for (const event of events) {
		const anchor = event.beforeMessageId;
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
