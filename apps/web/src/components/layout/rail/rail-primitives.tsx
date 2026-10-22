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

/** An avatar in a row's leading slot (the persona launcher): image, or `fallback` text (initials) without one. */
export interface NavRowAvatar {
  readonly src: string | null;
  readonly fallback: string;
}

/**
 * A bottom-panel quick-action row. The leading slot is an `icon` (16 px, dimmed)
 * or, for the persona launcher, an `avatar` (24 px round). The avatar is wider than
 * the icon slot, so it takes -mx-1 inside the 16 px slot: the label stays on the
 * same left edge as its icon-row neighbors and the row keeps its h-9.
 */
export function NavRow({ icon, avatar, label, onClick }: { icon?: ReactNode; avatar?: NavRowAvatar; label: string; onClick: () => void }) {
  return (
    <div
      className="flex h-9 cursor-pointer items-center rounded-md transition-colors duration-100 active:bg-s3 gap-3 px-2.5 w-full"
      onClick={onClick}
    >
      {avatar ? (
        <div className="flex h-4 w-4 shrink-0 items-center justify-center">
          <span className="-mx-1 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-s3 font-ui text-[calc(var(--ui-fs)-3px)] not-italic text-t2">
            {avatar.src ? <img src={avatar.src} alt="" className="h-full w-full object-cover" /> : avatar.fallback}
          </span>
        </div>
      ) : (
        <div className="flex h-4 w-4 shrink-0 items-center justify-center opacity-80">{icon}</div>
      )}
      <span className="min-w-0 truncate font-ui text-[clamp(11px,calc(var(--ui-fs)-2px),15px)] font-medium tracking-wide text-t2">{label}</span>
    </div>
  );
}
