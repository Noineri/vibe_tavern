import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtuoso } from "react-virtuoso";
import type { Components, ContextProp, VirtuosoHandle } from "react-virtuoso";
import { cn } from "../../lib/cn.js";
import type { ScrollMetrics } from "../../lib/stick-to-bottom.js";
import { useStickToBottom, type CompleteExplicitNavigation } from "./use-stick-to-bottom.js";
import { partitionMessageRenderWindow, type MessageRenderWindow } from "./message-render-window.js";
import type { RevealMessageStart } from "./message-scroll-context.js";
import { jumpToMessage } from "./message-jump.js";

/**
 * The store-free virtualized list core (AFP-2, AGENT_FEED_PERFORMANCE_PLAN
 * Wave 1 step 2), extracted from `MessageScroller.tsx` so the agent feed can
 * virtualize without inheriting RP chat-store subscriptions.
 *
 * The core owns: the Virtuoso instance (virtualized older prefix + mounted
 * stable-tail footer), the stick-to-bottom scroll invariant, the jump-to-item
 * navigation, and the inverse-scroll seams (`firstItemIndex` passthrough +
 * `onStartReached`) that history paging drives. Everything environment-specific
 * arrives through explicit props: identity/reset (`resetKey`), suppression
 * (`suppressFollow`), the id window and its partition, and the chrome slots
 * (`className`, `overlay`, `renderJumpToBottom`, `wrap`).
 *
 * `MessageScroller.tsx` remains the RP/co-author adapter on top of this core:
 * it derives `resetKey` from the snapshot store, raises `suppressFollow` for
 * in-flight image-gen runs, and mounts the RP chrome (ChatScrollRail, the
 * story-rail layout classes, the bottom-button pair, the translate recovery
 * boundary and the reveal-start context provider). Adapter-level store reads
 * never move down into the core — that boundary is the point of the split.
 */
export interface MessageScrollerCoreApi {
  /** Whether bottom-follow is currently active (drives the jump chrome). */
  pinned: boolean;
  /** Re-attach and drive to the bottom (the "to the end" affordance). */
  scrollToBottom: () => void;
  /** Explicit reading navigation (variant starts); wins over bottom-follow. */
  revealStart: RevealMessageStart;
  /** Detach until the virtualizer completes; optionally align a mounted row. */
  beginExplicitNavigation: () => CompleteExplicitNavigation;
  /** Anchor the first visible row for a pending prepend; the returned
   *  restore realigns it after the prepend commits. Optional retention keeps
   *  that core-owned anchor through delayed measurements until reader input. */
  beginPrependAnchor: (retainThroughLayout?: boolean) => () => void;
  /** Jump to a display index (stable-tail shortcut or virtualizer seek). */
  scrollToItem: (index: number, onLand?: (target: HTMLElement) => void) => void;
  /** The live scroller element (rail/thumb chrome needs it). Null pre-attach. */
  scrollerElement: HTMLElement | null;
  /** Global index of the first stable-tail row (jump math). */
  stableTailStartIndex: number;
}

export interface MessageScrollerCoreProps {
  /** Preserve an adapter's existing pin boundary; omitted = RP's 2px rule. */
  isAtBottom?: (metrics: ScrollMetrics) => boolean;
  /** Notify overlay chrome when virtual content changes without resizing its
   * viewport or normal-flow content wrapper. Does not own scroll writes. */
  onViewportLayoutChange?: (viewport: HTMLElement) => void;
  /** Identity for scroll-state reset: changing this re-pins to the bottom
   *  (the adapter derives it from its own stores, e.g. `chat:branch`). */
  resetKey: string;
  /** While true, content growth does NOT drag a pinned view down (the
   *  adapter raises this for in-flight image-gen runs; the core only reads
   *  the flag — it never derives it). Default false. */
  suppressFollow?: boolean;
  /** Ordered item ids: virtualized older prefix + stable recent suffix,
   *  split by `partition`. Indices passed to `renderItem` are positions in
   *  THIS array (plus the `firstItemIndex` offset when inverse scrolling). */
  displayIds: string[];
  /** Render one item at the given index. Mode-specific derivations live in
   *  the caller — the core is render-agnostic. */
  renderItem: (index: number, messageId: string) => ReactNode;
  /** Extra scroll room (px) below the stable tail (floating chrome clearance). */
  bottomInset?: number;
  /** Window partition (default: the RP page split — 20-row pages, 5-page
   *  stable tail). Paged feeds with different suffix semantics pass their
   *  own; the core only consumes the three fields. */
  partition?: (displayIds: string[]) => MessageRenderWindow;
  /** Inverse-scroll passthrough (Virtuoso 4.x): the virtualizer keeps the
   *  scroll position when older pages prepend, as long as this number drops
   *  by exactly the count of prepended VIRTUAL rows. Owned by the data
   *  source (the paging state), never derived here. Undefined = no inverse
   *  scrolling (the RP feed mounts full history). */
  firstItemIndex?: number;
  /** History paging seam: fired when the virtualized start scrolls into
   *  view. Absent = nothing loads older history (today's RP behavior). */
  onStartReached?: () => void;
  /** Root column classes (composed by `cn` onto the core's own layout
   *  baseline — `relative flex-1 flex flex-col min-h-0`). The RP adapter
   *  adds `chat-rail-layout` here; other feeds pass their lane chrome. */
  className?: string;
  /** The Virtuoso scroll-surface classes (default `flex-1 scrollbar-hide`).
   *  Feeds that own their scrollbar chrome (a thin overlay lane) override
   *  here instead of wrapping the virtualizer in a second scroll container. */
  scrollerClassName?: string;
  /** Hoisted viewport adapter. Forward its ref/props to the ONE real native
   * scroller; the context's onScrollIntent bridges sibling overlay tracks. */
  scrollerComponent?: Components<string, MessageScrollerCoreContext>["Scroller"];
  /** Height of the hoisted structural header spacer (default 28 — the RP
   *  feed's top breathing room). */
  topSpacerHeight?: number;
  /** Overlay chrome rendered inside the root column after the virtualizer
   *  (rails, banners). Receives the navigation API per render. */
  overlay?: (api: MessageScrollerCoreApi) => ReactNode;
  /** Jump-to-bottom chrome, rendered while detached and rows exist. Absent =
   *  no affordance (the feed owns its own or none). */
  renderJumpToBottom?: (scrollToBottom: () => void) => ReactNode;
  /** Wraps the virtualizer subtree (context providers for row-level
   *  services, e.g. the RP reveal-start context). The core stays generic;
   *  the adapter decides which contexts its rows see. */
  wrap?: (scroller: ReactNode, api: MessageScrollerCoreApi) => ReactNode;
}

export interface MessageScrollerCoreContext {
  renderItem: (index: number, messageId: string) => ReactNode;
  stableTailIds: string[];
  stableTailStartIndex: number;
  /** Global offset added to every caller-visible index (inverse-scroll
   *  feeds shift the space via `firstItemIndex`); 0 for array positions. */
  indexBase: number;
  stableTailRef: (node: HTMLElement | null) => void;
  bottomInset: number;
  topSpacerHeight: number;
  onScrollIntent: () => void;
}

// Hoisted to module scope: fresh component identities make Virtuoso remount its
// structural elements and restart height measurement.
const Header = () => <div style={{ height: 28 }} />;

function StableTail({ context }: ContextProp<MessageScrollerCoreContext>) {
  const { renderItem, stableTailIds, stableTailStartIndex, indexBase, stableTailRef, bottomInset } = context;

  return (
    <div ref={stableTailRef} data-message-stable-tail style={{ display: "flow-root" }}>
      {stableTailIds.map((messageId, offset) => (
        <div key={messageId} data-scroller-message-id={messageId} style={{ display: "flow-root" }}>
          {renderItem(indexBase + stableTailStartIndex + offset, messageId)}
        </div>
      ))}
      {/* Base 12px breathing room + the caller's bottomInset (MUI step 14:
          scroll clearance for the floating add-on launcher bar above the
          input dock). The spacer sits inside the observed stable tail, so an
          inset change while pinned is followed before paint (same settle path
          as streaming growth). */}
      <div style={{ height: 12 + bottomInset }} />
    </div>
  );
}

/**
 * Item wrapper. Identical to the default one except for `display: flow-root`,
 * and that one property is load-bearing.
 *
 * Message blocks space themselves with vertical margins. A plain block wrapper
 * lets a child's margin escape its box, so the wrapper's measured height — which
 * is what Virtuoso records — comes out ~8px short per item, while the DOM
 * carries the full gap. The virtualizer's model of the content then sits below
 * the real scrollHeight (measured in Firefox: 323px across 18 items), it places
 * "the bottom" that much too high, and it drags the position back there every
 * time we drive to the real bottom. That tug-of-war is what made a reload land
 * anywhere between "fine" and "half a message hidden behind the composer",
 * depending on which side moved last.
 *
 * `flow-root` gives the wrapper its own block formatting context, so the margins
 * stay inside and the measured height matches what the DOM lays out. Measured
 * after the change: item gaps 0, distance-to-bottom 0 in both engines.
 */
const Item: NonNullable<Components<string, MessageScrollerCoreContext>["Item"]> = ({ children, style, item, context: _context, ...rest }) => (
  <div {...rest} data-scroller-message-id={item} style={{ ...style, display: "flow-root" }}>
    {children}
  </div>
);

const components: Components<string, MessageScrollerCoreContext> = {
  Header,
  Footer: StableTail,
  Item,
};

export function MessageScrollerCore({
  isAtBottom,
  onViewportLayoutChange,
  resetKey,
  suppressFollow = false,
  displayIds,
  renderItem,
  bottomInset = 0,
  partition = partitionMessageRenderWindow,
  firstItemIndex,
  onStartReached,
  className,
  scrollerClassName = "flex-1 scrollbar-hide",
  scrollerComponent,
  topSpacerHeight = 28,
  overlay,
  renderJumpToBottom,
  wrap,
}: MessageScrollerCoreProps) {
  const { virtualizedIds, stableTailIds, stableTailStartIndex } = useMemo(
    () => partition(displayIds),
    [displayIds, partition],
  );
  const {
    scrollerRef,
    onScrollIntent,
    stableTailRef,
    onVirtualizedHeightChanged,
    pinned,
    scrollToBottom,
    revealStart,
    beginExplicitNavigation,
    beginPrependAnchor,
  } = useStickToBottom(resetKey, suppressFollow, { isAtBottom, onViewportLayoutChange });
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollId = useId();
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const attachScroller = useCallback((node: HTMLElement | Window | null) => {
    scrollerRef(node);
    setScrollerElement(node instanceof HTMLElement ? node : null);
  }, [scrollerRef]);

  const scrollToItem = useCallback((index: number, onLand?: (target: HTMLElement) => void) => {
    jumpToMessage({
      index,
      displayIds,
      stableTailStartIndex,
      virtualIndexBase: firstItemIndex ?? 0,
      scroller: scrollerElement,
      virtualizer: virtuosoRef.current,
      beginExplicitNavigation,
      onLand,
    });
  }, [displayIds, stableTailStartIndex, firstItemIndex, scrollerElement, beginExplicitNavigation]);

  const context = useMemo<MessageScrollerCoreContext>(() => ({
    renderItem,
    stableTailIds,
    stableTailStartIndex,
    indexBase: firstItemIndex ?? 0,
    stableTailRef,
    bottomInset,
    topSpacerHeight,
    onScrollIntent,
  }), [renderItem, stableTailIds, stableTailStartIndex, firstItemIndex, stableTailRef, bottomInset, topSpacerHeight, onScrollIntent]);

  const api = useMemo<MessageScrollerCoreApi>(() => ({
    pinned,
    scrollToBottom,
    revealStart,
    beginExplicitNavigation,
    beginPrependAnchor,
    scrollToItem,
    scrollerElement,
    stableTailStartIndex,
  }), [pinned, scrollToBottom, revealStart, beginExplicitNavigation, beginPrependAnchor, scrollToItem, scrollerElement, stableTailStartIndex]);

  const headerHeightStyle = useMemo(() => ({ height: topSpacerHeight }) as React.CSSProperties, [topSpacerHeight]);
  const headerComponent = useMemo(() => () => <div style={headerHeightStyle} />, [headerHeightStyle]);
  const structuralComponents = useMemo<Components<string, MessageScrollerCoreContext>>(
    () => ({
      ...components,
      ...(topSpacerHeight === 28 ? {} : { Header: headerComponent }),
      ...(scrollerComponent ? { Scroller: scrollerComponent } : {}),
    }),
    [topSpacerHeight, headerComponent, scrollerComponent],
  );

  const virtuoso = (
    <Virtuoso<string, MessageScrollerCoreContext>
      id={scrollId}
      ref={virtuosoRef}
      scrollerRef={attachScroller}
      data={virtualizedIds}
      context={context}
      computeItemKey={(_index, messageId) => messageId}
      totalListHeightChanged={onVirtualizedHeightChanged}
      overscan={{ main: 4000, reverse: 4000 }}
      {...(firstItemIndex !== undefined ? { firstItemIndex } : {})}
      {...(onStartReached !== undefined ? { startReached: () => onStartReached() } : {})}
      itemContent={(index, messageId) => renderItem(index, messageId)}
      components={structuralComponents}
      className={scrollerClassName}
      style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
    />
  );

  return (
    <div className={cn("relative flex-1 flex flex-col min-h-0", className)}>
      {wrap ? wrap(virtuoso, api) : virtuoso}
      {overlay ? overlay(api) : null}
      {!pinned && displayIds.length > 0 && renderJumpToBottom
        ? renderJumpToBottom(scrollToBottom)
        : null}
    </div>
  );
}
