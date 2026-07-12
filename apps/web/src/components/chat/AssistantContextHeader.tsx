import { type ReactNode, Fragment } from "react";
import { cn } from "../../lib/cn.js";
import { initials } from "../layout/app-shell-helpers.js";
import { Icons } from "../shared/icons.js";
import {
  resolveMessageSlots,
  type MessageSlotContext,
  type MessageSlotDescriptor,
} from "../../lib/message-slot-registry.js";
import { useAnyHeaderZoneOpen } from "../../stores/header-zone-expansion.js";
import type { MessageShellAuthorInfo } from "./MessageShell.js";

// ────────────────────────────────────────────────────────────────────────────
// AssistantContextHeader — the assistant message's adaptive context header.
// ────────────────────────────────────────────────────────────────────────────
// Replaces the legacy flat "avatar + name" author header for ASSISTANT messages
// only (user messages keep their reversed persona row in MessageShell). It
// resolves the `assistant_header_zone` slot descriptors (Objective / Scene,
// supplied by INSIGHTS_PLAN) and composes them with the identity anchor into:
//
//   • 0 zones resolved  → identity-only, byte-identical to the legacy header.
//   • ≥1 zone, compact  → one horizontal row: [avatar][name] ┊ [zone summaries].
//   • ≥1 zone, expanded → the avatar grows into a portrait and the zones open
//                         into columns (independent per-zone expand controls).
//
// Cross-zone coordination: each zone toggles its own flag in the per-message
// header-zone-expansion store; this header reads the aggregate `anyExpanded` to
// grow the avatar (desktop only), switch to column layout, and show separators.
// See ASSISTANT_CONTEXT_HEADER report + INSIGHTS_PLAN for the full contract.
//
// Render-isolation: the only subscription here is `useAnyHeaderZoneOpen` (a
// primitive boolean keyed by messageId), so a non-target message's header never
// re-renders when another message's zone toggles.
// ────────────────────────────────────────────────────────────────────────────

export interface AssistantContextHeaderProps {
  author: MessageShellAuthorInfo;
  slotCtx: MessageSlotContext;
  greetingControls?: ReactNode;
  isMobile: boolean;
  isEditing: boolean;
  isGenerating: boolean;
  onToggleMobileMenu: () => void;
}

export function AssistantContextHeader(props: AssistantContextHeaderProps) {
  const { author, slotCtx, greetingControls, isMobile, isEditing, isGenerating, onToggleMobileMenu } = props;

  const zones = resolveMessageSlots("assistant_header_zone", slotCtx);
  const anyExpanded = useAnyHeaderZoneOpen(slotCtx.messageId);
  const hasAvatar = !!(author.avatarNode ?? author.avatarSrc);

  // Desktop-only: the avatar grows and zones become columns only on desktop.
  // On mobile a portrait in a narrow stack is awkward, so the avatar stays
  // small and zones stack vertically (report §6: readability governs).
  const expanded = !isMobile && anyExpanded;
  // Avatar-less (initials) character: never grow — avoids a tall empty column.
  const portrait = expanded && hasAvatar;

  const showMobileMenu = isMobile && !isEditing && !isGenerating;

  const nameNode = author.nameNode ?? <span>{author.name}</span>;

  // ── 0 zones → identity-only fallback (visually identical to the legacy row) ──
  if (zones.length === 0) {
    return (
      <div className={cn(
        "mb-[12px] flex items-center gap-[10px] text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3 text-accent-t opacity-85",
        isMobile && "gap-[7px] text-[calc(var(--ui-fs)-3px)] mb-[3px]",
      )}>
        <HeaderAvatar author={author} portrait={false} />
        {nameNode}
        {greetingControls}
        {showMobileMenu && <MobileMenuButton onToggle={onToggleMobileMenu} />}
      </div>
    );
  }

  // ── ≥1 zone → adaptive (desktop: horizontal ↔ columns; mobile: stacked) ──
  if (isMobile) {
    return (
      <div className="mb-[3px] flex flex-col gap-2 text-[calc(var(--ui-fs)-3px)] font-semibold tracking-[0.04em] text-t3 text-accent-t opacity-85">
        <div className="flex items-center gap-[7px]">
          <HeaderAvatar author={author} portrait={false} />
          {nameNode}
          {greetingControls}
          {showMobileMenu && <MobileMenuButton onToggle={onToggleMobileMenu} />}
        </div>
        {zones.map((z) => (
          <Fragment key={z.id}>
            <ZoneDivider vertical={false} />
            <ZoneRenderer descriptor={z} ctx={slotCtx} />
          </Fragment>
        ))}
      </div>
    );
  }

  // Desktop adaptive.
  return (
    <div className={cn(
      "mb-[12px] flex text-[calc(var(--ui-fs)-2px)] font-semibold tracking-[0.04em] text-t3 text-accent-t opacity-85",
      expanded ? "items-start gap-4" : "items-center gap-[10px]",
    )}>
      {/* Identity anchor: avatar + name (+ greeting). Portrait → caption stack. */}
      <div className={cn("min-w-0", expanded ? "flex flex-col items-start gap-1" : "flex items-center gap-[10px]")}>
        <HeaderAvatar author={author} portrait={portrait} />
        <div className="flex items-center gap-[10px]">
          {nameNode}
          {greetingControls}
        </div>
      </div>

      {zones.map((z) => (
        <Fragment key={z.id}>
          <ZoneDivider vertical />
          <div className={cn(expanded && "min-w-0 flex-1")}>
            <ZoneRenderer descriptor={z} ctx={slotCtx} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Identity avatar — a PERSISTENT element whose size transitions smoothly
// between the compact circle (h-11 w-11 rounded-full) and the expanded portrait
// (h-28 w-28 rounded-2xl). Same element across states so the CSS transition
// fires (no unmount/remount). On mobile `portrait` is always false.
// ────────────────────────────────────────────────────────────────────────────

function HeaderAvatar({ author, portrait }: { author: MessageShellAuthorInfo; portrait: boolean }) {
  return (
    <div className={cn(
      "shrink-0 overflow-hidden bg-s3 font-body italic text-t3 transition-all duration-300 ease-out [&_img]:h-full [&_img]:w-full [&_img]:object-cover",
      "flex items-center justify-center",
      portrait
        ? "h-28 w-28 rounded-2xl text-[calc(var(--ui-fs)+5px)]"
        : "h-11 w-11 rounded-full text-[calc(var(--ui-fs)+1px)]",
    )}>
      {author.avatarNode ?? (
        author.avatarSrc
          ? <img src={author.avatarSrc} alt={author.name} className="h-full w-full object-cover" />
          : initials(author.name)
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Mobile three-dot menu trigger (the ActionSheet itself stays in MessageShell,
// shared across both header paths). Assistant row is not reversed, so ml-auto
// pins the dots to the right edge (see the F11 note in MessageShell).
// ────────────────────────────────────────────────────────────────────────────

function MobileMenuButton({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="relative ml-auto">
      <div
        className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded text-t3 transition-colors active:bg-s2"
        onClick={onToggle}
      >
        <Icons.Ellipsis />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Zone pieces
// ────────────────────────────────────────────────────────────────────────────

function ZoneDivider({ vertical }: { vertical: boolean }) {
  return vertical
    ? <div className="w-px self-stretch bg-border opacity-40" />
    : <div className="h-px bg-border opacity-40" />;
}

function ZoneRenderer({ descriptor, ctx }: {
  descriptor: MessageSlotDescriptor;
  ctx: MessageSlotContext;
}) {
  return <>{descriptor.render(ctx)}</>;
}
