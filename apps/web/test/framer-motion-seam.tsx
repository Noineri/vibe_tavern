/**
 * The ONE shared `framer-motion` seam for every apps/web test file that mocks
 * the animation boundary (the MessageBlock harness trio:
 * message-block-isolation, message-block-regex-display,
 * message-block-image-slot).
 *
 * CO-LOAD CONTRACT (same discipline as test/react-markdown-seam.ts,
 * test/agent-message-markdown-seam.tsx and test/i18n-context-seam.ts):
 * `mock.module` is process-global and last-write-wins, and a hand-bundled run
 * shares the module registry — so a file-private framer-motion mock stays
 * live for EVERY later file in the process. The trio's former inline
 * `motion.div` override rendered `<div>{children}</div>` and DROPPED EVERY
 * PROP, including `className`. AgentMessageList's graph renders through the
 * same framer-motion (MessageReasoning `inline` preset → AnimatedDisclosure →
 * `motion.div className="basis-full pt-1"`), so co-loading the image-slot
 * harness made the AP-29 caption EXPANSION pins fail
 * (`body.closest(".basis-full")` → null) while each file was green alone.
 * Probe-bisected 2026-10-25: the framer-motion mock ALONE reproduces both
 * failures; the image-slot file with only that registration disabled
 * co-loads 105/105 green. Every file that mocks framer-motion now registers
 * THIS seam, so whichever registration is live — in any discovery order —
 * the behavior is identical.
 *
 * The factory is the superset the trio needs, in the mandatory R4 shape
 * (spread the real namespace, override exactly the animation boundary):
 *  - `AnimatePresence` renders its children directly — no exit animation,
 *    collapsed content unmounts immediately (the deterministic harness
 *    behavior every former inline copy relied on);
 *  - `motion.div` renders a plain `<div>` that FORWARDS every DOM prop
 *    (className, style, data-testid, aria-*, inert, handlers, ref) after
 *    stripping framer-motion's own props. Prop preservation IS the co-load
 *    fix: consumers' class pins survive whichever registration is live.
 *    The strip list below is typed against the REAL `motion.div` props (one
 *    derivation — typecheck fails on a name the library does not have). A
 *    future motion prop missing from it leaks through to the div as a React
 *    unknown-prop WARNING — loud, never a silent class drop like the
 *    incident this seam fixes.
 *  - the mount `initial` value is recorded as `data-motion-initial`
 *    (message-block-isolation pins WHICH initial a mount used: `"false"` at
 *    rest vs `"40,0"` for the variant slide-in; objects join their scalar
 *    values in declaration order).
 *
 * The DELEGATION CAPTURE RULE does not bite: the factory never calls through
 * the captured namespace (no re-entry path); only plain data (the `motion`
 * prop map) is spread at registration. Call `installFramerMotionSeam()` in
 * the test-file body BEFORE importing the component under test (same
 * ordering rule as the other seams).
 */
import { mock } from "bun:test";
import type { ComponentProps, ReactNode } from "react";

const realFramerMotion = await import("framer-motion");

/** The real `motion.div` props — the one derivation, from the live module. */
type MotionDivProps = ComponentProps<typeof realFramerMotion.motion.div>;
/** What a plain `<div>` takes — the forwarding target after the strip. */
type DivProps = ComponentProps<"div">;

/** `data-motion-initial` serialization: `false`/absent → `"false"`, an object → its scalar values joined. */
function serializeInitial(initial: MotionDivProps["initial"]): string {
	if (initial === undefined || initial === false) return "false";
	if (initial !== null && typeof initial === "object") {
		const values = Object.values(initial).filter(
			(value): value is number | string => typeof value === "number" || typeof value === "string",
		);
		return values.length > 0 ? values.join(",") : String(true);
	}
	return String(initial);
}

/** Register the shared framer-motion seam (idempotent: same shape on re-registration). */
export function installFramerMotionSeam(): void {
	mock.module("framer-motion", () => ({
		...realFramerMotion,
		AnimatePresence: function FramerMotionSeamAnimatePresence({ children }: { children?: ReactNode }) {
			return children ?? null;
		},
		motion: {
			...realFramerMotion.motion,
			div: function FramerMotionSeamMotionDiv(props: MotionDivProps) {
				const {
					// Animation targets & orchestration.
					initial,
					animate,
					exit,
					transition,
					variants,
					// Gesture states.
					whileHover,
					whileTap,
					whileDrag,
					whileFocus,
					whileInView,
					// Drag.
					drag,
					dragConstraints,
					dragControls,
					dragDirectionLock,
					dragElastic,
					dragListener,
					dragMomentum,
					dragPropagation,
					dragSnapToOrigin,
					dragTransition,
					// Gesture handlers (framer-only names; `onDrag*` would also
					// be valid DOM handlers, but the drag state above never runs).
					onTap,
					onTapStart,
					onTapCancel,
					onPan,
					onPanStart,
					onPanEnd,
					onDrag,
					onDragStart,
					onDragEnd,
					onHoverStart,
					onHoverEnd,
					onMeasureDragConstraints,
					// Layout projection.
					layout,
					layoutId,
					layoutDependency,
					layoutScroll,
					layoutRoot,
					layoutAnchor,
					layoutCrossfade,
					// Viewport & animation callbacks.
					onViewportEnter,
					onViewportLeave,
					viewport,
					onUpdate,
					onAnimationStart,
					onAnimationComplete,
					// Advanced.
					custom,
					inherit,
					transformTemplate,
					values,
					ignoreStrict,
					globalTapTarget,
					// Everything else is a DOM prop and MUST reach the div
					// (className, style, data-*, aria-*, inert, handlers, ref).
					...forwarded
				} = props;
				// The remainder is DOM props modulo MotionValue unions (style /
				// children accept MotionValues only when a caller passes them —
				// no repo call site does); one honest narrowing, never `any`.
				const domProps = forwarded as DivProps;
				return <div {...domProps} data-motion-initial={serializeInitial(initial)} />;
			},
		},
	}));
}
