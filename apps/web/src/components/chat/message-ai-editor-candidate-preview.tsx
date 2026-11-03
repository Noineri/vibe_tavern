/**
 * The AI editor's plain-candidate preview block (CNR-8p).
 *
 * Extracted from `MessageAiEditorModal.tsx` for the architecture line
 * ratchet: the modal is baselined over the 800-line cap and the two call
 * sites (edit fallback when the word/line diffs bail, and merge mode's full
 * candidate) rendered this markup verbatim twice. One component now owns it.
 *
 * CNR-8p: the capped pre rides the shared thin vertical lane (3px rest /
 * 5px hover) instead of the native `overflow-auto` fallback — the 8c
 * TextDiffPreview idiom: the max-h cap moves onto the ScrollArea root and
 * the `pre` stays the semantic content inside the viewport. A long candidate
 * is the normal case (whole-message rewrites), so the strip truly overflows.
 */
import type { ReactNode } from "react";
import { ScrollArea } from "../shared/scroll-area.js";

export function MessageAiEditorCandidatePreview({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3 rounded-md border border-border bg-bg p-3">
      <div className="mb-2 text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.06em] text-t3">{label}</div>
      <ScrollArea scrollbarSize="thin" className="max-h-[280px]">
        <pre className="whitespace-pre-wrap font-mono text-[calc(var(--ui-fs)-2px)] leading-[1.5] text-t1">{children}</pre>
      </ScrollArea>
    </div>
  );
}
