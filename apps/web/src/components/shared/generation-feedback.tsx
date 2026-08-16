/**
 * generation-feedback — shared primitives for the AI-generation feedback UX.
 *
 * Extracted verbatim from AvatarDescriptionField so any surface that runs an
 * AI-generation step (vision describe, summarize, etc.) can reuse the same
 * three reinforcing cues without re-rolling them:
 *
 *   1. `useGenerationTask` — owns the AbortController + generating flag,
 *      silences abort errors, funnels non-abort errors to an optional onError.
 *      Fire-and-forget by design: unmount does NOT abort (matches the previous
 *      in-component behavior — the promise continues and the parent decides
 *      what to do with the result).
 *   2. `GenerateCancelButton` — a fixed-height rail that crossfades between a
 *      neutral "generate / regenerate" button and a danger "cancel" button.
 *   3. `GenerationSurface` — wraps a control (usually a textarea) with the
 *      generating overlay (spinner + label, optional backdrop blur when there
 *      is existing content) and the empty→content result-reveal flash.
 *
 * Contract: presentational only. NO i18n, stores, RPC, sonner, or build/field
 * imports — every visible string arrives as a prop, every side-effect is a
 * callback. This is what lets the module be reused across character/persona
 * and, later, summary/script surfaces.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Ic } from "./icons.js";
import { cn } from "../../lib/cn.js";

// ---------------------------------------------------------------------------
// useGenerationTask
// ---------------------------------------------------------------------------

export interface UseGenerationTaskOptions {
	onGenerate: (signal: AbortSignal) => Promise<void>;
	onError?: (error: unknown) => void;
}

export interface UseGenerationTaskResult {
	generating: boolean;
	start: () => void;
	cancel: () => void;
}

/**
 * Owns the generation lifecycle for a presentational surface.
 *
 * - `start` guards re-entry while a generation is in flight (controller ref is
 *   the source of truth, kept in lockstep with the generating flag).
 * - Aborts are silent: if `controller.signal.aborted` is true in the catch,
 *   the error is swallowed (the user cancelled — no toast).
 * - Non-abort rejections are routed to `onError` for the parent to surface
 *   (e.g. `toast.error(message)`).
 *
 * CRITICAL: there is intentionally NO unmount cleanup that aborts. The current
 * contract is fire-and-forget — if the component unmounts mid-generation the
 * promise continues and the parent handles completion. Adding an abort-on-
 * unmount would be a behavior change.
 */
export function useGenerationTask(options: UseGenerationTaskOptions): UseGenerationTaskResult {
	const { onGenerate, onError } = options;
	const [generating, setGenerating] = useState(false);
	const controllerRef = useRef<AbortController | null>(null);
	// Hold the latest callbacks in refs so `start`/`cancel` can be stable
	// (no dependency churn) while still invoking the freshest closures.
	const onGenerateRef = useRef(onGenerate);
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onGenerateRef.current = onGenerate;
		onErrorRef.current = onError;
	});

	const start = useCallback(() => {
		// Re-entry guard: a controller is only non-null while generating.
		if (controllerRef.current) return;
		const controller = new AbortController();
		controllerRef.current = controller;
		setGenerating(true);
		void (async () => {
			try {
				await onGenerateRef.current(controller.signal);
			} catch (err) {
				// User cancelled → silent, mirrors gallery-store.describe.
				if (controller.signal.aborted) return;
				onErrorRef.current?.(err);
			} finally {
				if (controllerRef.current === controller) controllerRef.current = null;
				setGenerating(false);
			}
		})();
	}, []);

	const cancel = useCallback(() => {
		controllerRef.current?.abort();
	}, []);

	return { generating, start, cancel };
}

// ---------------------------------------------------------------------------
// GenerateCancelButton
// ---------------------------------------------------------------------------

/** Spring for the button morph and icon crossfades (bounce must be 0). */
const morphSpring = { duration: 0.15, ease: [0.2, 0, 0, 1] as const };

export interface GenerateCancelButtonProps {
	generating: boolean;
	/** Committed value non-empty → show the "regenerate" label + accent sparkles. */
	hasValue: boolean;
	labels: { generate: string; regenerate: string; cancel: string };
	/** Title attributes. Falls back to the matching label when omitted. */
	titles?: { generate?: string; cancel?: string };
	onGenerate: () => void;
	onCancel: () => void;
	disabled?: boolean;
}

/**
 * Fixed-height rail that crossfades between the generate/regenerate button
 * (idle) and the cancel button (generating). Both states are absolutely
 * positioned so the crossfade never shifts surrounding layout.
 *
 * Class strings are copied verbatim from the original AvatarDescriptionField
 * inline implementation — do NOT tweak the visuals here without a design
 * reason; this is the one source of truth now.
 */
export function GenerateCancelButton({
	generating,
	hasValue,
	labels,
	titles,
	onGenerate,
	onCancel,
	disabled,
}: GenerateCancelButtonProps) {
	return (
		<div className="relative mb-2 h-8">
			<AnimatePresence initial={false}>
				{generating ? (
					<motion.div
						key="cancel"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={morphSpring}
						className="absolute inset-0 flex items-center"
					>
						<button
							type="button"
							className={cn(
								"flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3",
								"font-ui text-[12px] text-danger",
								"transition-[background-color,color] duration-150",
								"hover:bg-danger/20 hover:text-danger-strong",
							)}
							onClick={onCancel}
							title={titles?.cancel ?? labels.cancel}
						>
							<Ic.close />
							<span>{labels.cancel}</span>
						</button>
					</motion.div>
				) : (
					<motion.div
						key="generate"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={morphSpring}
						className="absolute inset-0 flex items-center"
					>
						<button
							type="button"
							className={cn(
								"flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-3",
								"font-ui text-[12px] text-t2",
								"transition-[background-color,color,border-color] duration-150",
								"hover:bg-s2 hover:text-t1 hover:border-accent/40",
							)}
							onClick={onGenerate}
							disabled={disabled}
							title={titles?.generate ?? labels.generate}
						>
							<Ic.sparkles className={hasValue ? "text-accent" : undefined} />
							<span>{hasValue ? labels.regenerate : labels.generate}</span>
						</button>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

// ---------------------------------------------------------------------------
// GeneratingScrim — standalone overlay for any generation surface
// ---------------------------------------------------------------------------

export interface GeneratingScrimProps {
	/**
	 * "blur" — avatar-description style: backdrop-blur when there is existing
	 * content so the locked text reads as frozen.
	 * "dim" — coauthor style: semi-transparent overlay that softly darkens the
	 * surface without blurring text (text stays readable, just clearly frozen).
	 */
	variant: "blur" | "dim";
	/** Visible label rendered next to the spinner. */
	label: string;
	/**
	 * Whether the overlay should intercept pointer events (acting as a
	 * functional guard). DEFAULT: "none" — visual-only. Set "auto" when the
	 * scrim must block clicks to controls rendered underneath (e.g. widget
	 * decorations inside a locked CodeMirror editor).
	 */
	pointerEvents?: "none" | "auto";
	/** Extra class on the overlay (e.g. rounded corners to match the host). */
	className?: string;
	/**
	 * Optional data-testid for tests that pin the scrim's presence (e.g. the
	 * copilot editor's frozen-scrim assertion). Rides on the scrim root.
	 */
	testId?: string;
	/**
	 * When true AND variant="blur", the backdrop-blur is applied so the locked
	 * text reads as frozen. DEFAULT false.
	 */
	hasExistingContent?: boolean;
}

/**
 * Centred spinner + label overlay for any generation surface. Decoupled from
 * `GenerationSurface`'s render-prop contract so it can be dropped into any
 * relative parent without refactoring the host component.
 *
 * - `variant="blur"` + `hasExistingContent` → `backdrop-blur-[4px]` (legacy
 *   avatar-description look).
 * - `variant="dim"` → `bg-surface/55` semi-transparent overlay (coauthor
 *   editor dim). No blur — the user can still read the frozen document.
 * - `pointerEvents="auto"` → overlay intercepts clicks (functional guard for
 *   CodeMirror widget decorations that bypass the `EditorView.editable` facet).
 *   Default "none" keeps the avatar-description path byte-identical.
 */
export function GeneratingScrim({
	variant,
	label,
	pointerEvents,
	className,
	testId,
	hasExistingContent,
}: GeneratingScrimProps) {
	const blur = variant === "blur" && hasExistingContent;
	return (
		<motion.div
			data-testid={testId}
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.2 }}
			className={cn(
				"absolute inset-0 flex items-center justify-center gap-2 rounded-md px-3",
				pointerEvents === "auto" ? "pointer-events-auto" : "pointer-events-none",
				blur && "backdrop-blur-[4px]",
				variant === "dim" && "bg-surface/55",
				className,
			)}
		>
			<span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
			<span className="font-ui text-[16px] text-t2">{label}</span>
		</motion.div>
	);
}

// ---------------------------------------------------------------------------
// GenerationSurface
// ---------------------------------------------------------------------------

export interface GenerationSurfaceProps {
	generating: boolean;
	/** COMMITTED value — drives flash detection + the default blur variant. */
	value: string;
	/** Visible label rendered next to the spinner while generating. */
	generatingLabel: string;
	/** External disable (e.g. no avatar / form saving). OR-merged with generating. */
	disabled?: boolean;
	/**
	 * Override the backdrop-blur trigger. DEFAULT: derived from `value` —
	 * `value.trim().length > 0`. Consumers that want to gate the blur on a
	 * different signal (e.g. a committed prop vs a draft) can pass it here.
	 */
	hasExistingValue?: boolean;
	/** Extra class on the relative wrapper (e.g. layout spacing). */
	className?: string;
	/**
	 * Render prop — receives the computed `disabled` (parent should spread it
	 * onto its control so the surface can lock it during generation) and the
	 * `controlClassName` to merge into the control (carries the transition +
	 * reveal-flash ring).
	 */
	children: (state: { disabled: boolean; controlClassName: string }) => ReactNode;
}

/**
 * Wraps a control with the generating overlay + result-reveal flash.
 *
 * - `disabled` passed to the render prop = `disabled || generating`. The parent
 *   MUST spread this onto its control so the user cannot race the generation.
 * - Detects empty→non-empty transitions of `value` and surfaces a 1.4s accent
 *   flash so a silently-arrived server value is noticed. Mounting with content
 *   does NOT flash (prevValue ref is seeded from the initial prop).
 * - While generating, a `GeneratingScrim (variant="blur")` overlays the control
 *   (pointer-events-none — visual-only, consistent with the original avatar-
 *   description implementation).
 */
export function GenerationSurface({
	generating,
	value,
	generatingLabel,
	disabled,
	hasExistingValue,
	className,
	children,
}: GenerationSurfaceProps) {
	const [justArrived, setJustArrived] = useState(false);
	// Seed from the initial prop so mounting with existing content does NOT
	// trip the empty→content flash — only a real transition does.
	const prevValueRef = useRef(value);

	useEffect(() => {
		const prev = prevValueRef.current;
		const prevEmpty = !prev || prev.trim().length === 0;
		const nextNonEmpty = !!value && value.trim().length > 0;
		if (prevEmpty && nextNonEmpty) {
			setJustArrived(true);
			const id = setTimeout(() => setJustArrived(false), 1400);
			prevValueRef.current = value;
			return () => clearTimeout(id);
		}
		prevValueRef.current = value;
	}, [value]);

	const resolvedHasExisting = hasExistingValue ?? value.trim().length > 0;
	const childDisabled = disabled || generating;
	const controlClassName = cn(
		"transition-[border-color,box-shadow] duration-200",
		justArrived && "border-accent/60 shadow-[0_0_0_2px_var(--accent-dim)]",
	);

	return (
		<div className={cn("relative", className)}>
			{children({ disabled: childDisabled, controlClassName })}

			<AnimatePresence>
				{generating && (
					<GeneratingScrim
						variant="blur"
						label={generatingLabel}
						hasExistingContent={resolvedHasExisting}
					/>
				)}
			</AnimatePresence>

			{/* Result-reveal flash — soft accent tint that fades out over ~1.2s
			    when a fresh description lands. Pure signal, no interaction. */}
			<AnimatePresence>
				{justArrived && !generating && (
					<motion.div
						initial={{ opacity: 0.7 }}
						animate={{ opacity: 0 }}
						transition={{ duration: 1.2, ease: "easeOut" }}
						className="pointer-events-none absolute inset-0 rounded-md bg-accent/10"
					/>
				)}
			</AnimatePresence>
		</div>
	);
}
