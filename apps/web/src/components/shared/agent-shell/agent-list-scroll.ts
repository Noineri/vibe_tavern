import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * AgentMessageList's bottom-pinning auto-scroll (extracted under the
 * file-size ratchet — the list's own seam, verbatim): stick to the bottom
 * while the user is already there, and surface a jump-to-bottom affordance
 * once they scroll up (the co-author surface's bottom-pinning intent).
 *
 * The hook owns the scroll element ref, the pinned flag, the near-bottom
 * scroll handler and the content-effect that keeps a pinned view at the
 * bottom; the caller attaches `scrollRef`/`handleScroll` to its scroll
 * container, renders its jump button from `showJumpToBottom`/`jump`, and
 * passes the same three counters the pre-extraction effect keyed on.
 */
export interface AgentListScroll {
	/** Attach to the scrolling container. */
	scrollRef: RefObject<HTMLDivElement | null>;
	/** True while the view is scrolled away from the bottom. */
	showJumpToBottom: boolean;
	/** The container's onScroll — keeps the pinned flag + jump state fresh. */
	handleScroll: () => void;
	/** The jump button's click: re-pin and scroll to the bottom. */
	jump: () => void;
}

export function useAgentListScroll(contentCount: number, pendingText: string, feedLength: number): AgentListScroll {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const pinnedRef = useRef(true);
	const [showJumpToBottom, setShowJumpToBottom] = useState(false);

	const scrollToBottom = () => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	};

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		pinnedRef.current = nearBottom;
		setShowJumpToBottom(!nearBottom);
	};

	const jump = () => {
		pinnedRef.current = true;
		scrollToBottom();
	};

	useLayoutEffect(() => {
		if (pinnedRef.current) scrollToBottom();
	}, [contentCount, pendingText, feedLength]);

	return { scrollRef, showJumpToBottom, handleScroll, jump };
}
