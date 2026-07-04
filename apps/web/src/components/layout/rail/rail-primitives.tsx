/**
 * Rail primitives — the two tiny helper components shared by the RP `Rail`
 * and `CoauthorRail` (E5a, post-SF-5 dedup). Byte-identical between the two
 * before extraction.
 *
 * `RailRow` is NOT here: it is RP-only (used for the build-panel list that
 * the co-author rail does not render), so it stays inline in `Rail.tsx`.
 */
import type { ReactNode } from "react";
import { cn } from "../../../lib/cn.js";

/* ── Mini icon button (collapsed rail item) ── */
export function Ico({ icon, active, onClick, title }: { icon: ReactNode; active?: boolean; onClick: () => void; title: string }) {
  return (
    <div
      className={cn(
        // Specific properties only (not `transition-all`); scale 0.96 is the
        // tactile-press spec — anything below 0.95 feels exaggerated.
        "flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition-[background-color,color,border-radius,transform] duration-150 ease-out active:bg-s3 active:scale-[0.96]",
        active ? "rounded-xl bg-accent-dim text-accent-t" : "text-t3",
      )}
      onClick={onClick}
      title={title}
    >
      {icon}
    </div>
  );
}

export function NavRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <div
      className="flex h-9 cursor-pointer items-center rounded-md transition-colors duration-100 active:bg-s3 gap-3 px-2.5 w-full"
      onClick={onClick}
    >
      <div className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80">{icon}</div>
      <span className="min-w-0 truncate font-ui text-[clamp(11px,calc(var(--ui-fs)-2px),15px)] font-medium tracking-wide text-t2">{label}</span>
    </div>
  );
}
