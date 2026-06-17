import { useEffect, useRef } from "react";
import {
	BOOK_PATH,
	MOTION_DEFAULTS,
	STAR_DEFS,
	starPositionAt,
} from "./vt-logo.js";

/**
 * Vibe Tavern logo mark — the `vt_sign` open book with three stars.
 *
 * Static by default (sidebar, branding): renders the recognizable logo pose.
 * With `animated`, runs the inertial "chase-train" orbit — three stars rise
 * from the book, circle it in a tight comet train with a gravity whip at the
 * bottom, and settle back. Used in loading states. Honors
 * `prefers-reduced-motion` (parks in the rest pose, no rAF).
 *
 * Colors derive from the active theme: stars use `--accent` (button color),
 * the book uses `--accent-mid` (mid-lightness accent — subordinate but
 * theme-aware). Sizing is the caller's job via `className`.
 *
 * Motion math is the pure module {@link vt-logo.ts}; the standalone server
 * loading placeholder mirrors it in vanilla JS.
 */
export interface LogoProps {
	/** Run the orbit animation. Default `false` (static mark). */
	readonly animated?: boolean;
	/** Sizing / layout classes applied to the `<svg>` (e.g. `"h-[30px] w-[30px]"`). */
	readonly className?: string;
}

/** Padded viewBox so the full orbit (r=150 around the book) fits inside the box. */
const ANIMATED_VIEWBOX = "-22.5 -52 330 330";
/** Tight viewBox matching the original `vt_sign.svg` mark. */
const STATIC_VIEWBOX = "0 0 286 175";

export function Logo({ animated = false, className }: LogoProps) {
	const gRefs = useRef<(SVGGElement | null)[]>([]);

	useEffect(() => {
		if (!animated) return;
		// Respect reduced-motion: leave stars in the natural rest pose.
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
		if (reduce.matches) return;

		let raf = 0;
		const start = performance.now();
		const tick = (now: number) => {
			const t = ((now - start) % MOTION_DEFAULTS.durationMs) / MOTION_DEFAULTS.durationMs;
			for (let i = 0; i < STAR_DEFS.length; i++) {
				const p = starPositionAt(t, i);
				gRefs.current[i]?.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [animated]);

	return (
		<svg
			viewBox={animated ? ANIMATED_VIEWBOX : STATIC_VIEWBOX}
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			style={{ overflow: "visible" }}
			aria-hidden="true"
		>
			<path d={BOOK_PATH} style={{ fill: "var(--accent-mid)" }} />
			{STAR_DEFS.map((star, i) => (
				<g
					key={i}
					ref={(el) => {
						gRefs.current[i] = el;
					}}
					transform={`translate(${star.cx} ${star.cy})`}
				>
					<path
						d={star.path}
						transform={`translate(${-star.cx} ${-star.cy})`}
						style={{ fill: "var(--accent)" }}
					/>
				</g>
			))}
		</svg>
	);
}
