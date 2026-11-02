import { Icons } from "../icons.js";

/**
 * The agent feed's jump-to-bottom affordance — the floating accent circle
 * revealed by `useAgentListScroll` while the view sits away from the bottom
 * (the co-author surface's bottom-pinning intent; the hook and its pinned
 * flag live in `agent-list-scroll.ts`).
 *
 * Extracted from `AgentMessageList.tsx` under the file-size ratchet at
 * CNR-8h: the list sat exactly at the 800-line cap when its scroll surface
 * moved onto the shared thin ScrollArea lane, so the jump button — part of
 * the same scroll mechanism the unit touches — moved out, byte-identical
 * chrome. The caller mounts it inside the feed's `relative` wrapper (the
 * `absolute bottom-4 right-4` pin needs that positioning context) and only
 * while `showJumpToBottom` holds; `onClick` is the hook's `jump`.
 */
export function AgentJumpToBottom({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="absolute bottom-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
      onClick={onClick}
    >
      <Icons.Caret direction="d" />
    </button>
  );
}
