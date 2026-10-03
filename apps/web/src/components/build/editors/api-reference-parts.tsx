/**
 * Shared API-reference layout parts (SCRIPT_EDITOR_CLEANUP_REPORT steps 1–2).
 * The card shell / section / «code + description» row / code block that
 * script-api-reference, interactive-api-reference and visual-api-reference
 * carried as three hand copies now live here once (the third-occurrence
 * unification point, AGENTS.md §3).
 *
 * This is a LAYOUT fix, not a restyle: the class strings are the ones the
 * three copies rendered before extraction, changed only by the overflow
 * contract — the card root and every grid level carry `min-w-0` so no grid
 * track's min-content can widen the card; `ApiRefCode` scrolls horizontally
 * inside the card (`overflow-x-auto`, code never wraps); `ApiRefRow` keeps
 * the one-line desktop row and stacks below the app-wide mobile breakpoint
 * (Tailwind `md:` = 768px = MOBILE_MQ in use-mobile.ts): code chip on its
 * own line, description under it at full width, wrapping normally. Authored
 * copy is never truncated or ellipsized.
 */
import type { ReactNode } from "react";

/** Card shell: accented container + uppercase title + the section grid. */
export function ApiRefCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-4 min-w-0 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{title}</div>
      <div className="grid min-w-0 gap-3 text-[12px]">{children}</div>
    </div>
  );
}

/** Section: optional uppercase heading + the row/code grid (`gap-1`).
 *  Heading-less sections render the grid alone (the character-fields block
 *  in script-api-reference has no heading). */
export function ApiRefSection({ heading, children }: { heading?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      {heading != null ? (
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{heading}</div>
      ) : null}
      <div className="grid min-w-0 gap-1">{children}</div>
    </div>
  );
}

/** «Code + description» row: one line on desktop; on mobile the code chip
 *  sits on its own line with the description below it at full width. */
export function ApiRefRow({ code, children }: { code?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5 leading-[1.5] md:flex-row md:items-center md:gap-2">
      {code != null ? (
        <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">{code}</code>
      ) : null}
      <span className="min-w-0 text-t3">{children}</span>
    </div>
  );
}

/** Read-only code block: scrolls horizontally inside the card — the longest
 *  line never sets the card's width. */
export function ApiRefCode({ children }: { children: ReactNode }) {
  return (
    <pre className="mt-1 min-w-0 overflow-x-auto rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{children}</pre>
  );
}
