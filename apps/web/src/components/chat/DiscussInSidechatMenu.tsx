// fork #1 of ImageGenMessageMenu (apps/web/src/components/chat/ImageGenMessageMenu.tsx)
// Correspondence map (built before coding; deviations named):
//   trigger — desktop icon+caret button in a CustomTooltip / mobile 44px icon
//     button with an aria-label: CLONED. The caret rides the multi-variant
//     trigger only (it opens a choice); the single-variant trigger is a
//     direct icon-only action (DEVIATION 1: nothing to choose, no caret).
//   overlay — desktop Radix popover with the CF11 closed-mount avoidance
//     (closed = plain button, the popover mounts only once opened) / mobile
//     BottomSheet: CLONED.
//   body — two scope rows («Only selected» / «All variants») instead of the
//     fine-tuning toggle + eight mode rows (DEVIATION 2: the content IS the
//     choice; the menu owns no run state, so no disabled morph beyond the
//     row-level `disabled`/isBusy idiom). Each row calls onSelect + closes.
//   identity — NO chatId/messageId props (DEVIATION 3: the menu carries no
//     anchor identity; the caller builds the chips from its own variants).
//   sheet title — the tooltip string doubles as the BottomSheet title
//     (DEVIATION 4: no separate section-title key; the choice needs no
//     section chrome). The desktop popover carries no title (reference parity).
//   popover width — w-[220px] instead of w-[260px] (DEVIATION 5: two short
//     rows, no toggle).
//   testids — discuss-sidechat-trigger (the shared closed/open trigger idiom)
//     + discuss-scope-selected / discuss-scope-all (the mode-row parallel).

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Icons } from "../shared/icons.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { useT } from "../../i18n/context.js";

export type DiscussScope = "selected" | "all";

export interface DiscussInSidechatMenuProps {
  variant: "desktop" | "mobile";
  /** Total variants on the RP message — one attaches at once, several open
   *  the choice. */
  variantCount: number;
  /** Row convention: inert while a chat turn is busy (isBusy). */
  disabled?: boolean;
  onSelect: (scope: DiscussScope) => void;
}

export function DiscussInSidechatMenu({ variant, variantCount, disabled = false, onSelect }: DiscussInSidechatMenuProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const tooltip = t("discuss_in_sidechat_tooltip");

  const pick = (scope: DiscussScope): void => {
    setOpen(false);
    onSelect(scope);
  };

  // One variant attaches at once — no choice to open on either viewport.
  if (variantCount <= 1) {
    if (variant === "mobile") {
      return (
        <button
          type="button"
          data-testid="discuss-sidechat-trigger"
          aria-label={tooltip}
          aria-disabled={disabled}
          disabled={disabled}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:cursor-default disabled:opacity-40 [&_svg]:h-5 [&_svg]:w-5"
          onClick={() => onSelect("selected")}
        >
          <Icons.sidechatDiscuss />
        </button>
      );
    }
    return (
      <CustomTooltip content={tooltip}>
        <button
          type="button"
          data-testid="discuss-sidechat-trigger"
          aria-label={tooltip}
          aria-disabled={disabled}
          disabled={disabled}
          className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
          onClick={() => onSelect("selected")}
        >
          <Icons.sidechatDiscuss />
        </button>
      </CustomTooltip>
    );
  }

  if (variant === "mobile") {
    return (
      <>
        <button
          type="button"
          data-testid="discuss-sidechat-trigger"
          aria-label={tooltip}
          aria-disabled={disabled}
          disabled={disabled}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:cursor-default disabled:opacity-40 [&_svg]:h-5 [&_svg]:w-5"
          onClick={() => setOpen(true)}
        >
          <Icons.sidechatDiscuss />
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} title={tooltip}>
          <DiscussScopeBody onPick={pick} />
        </BottomSheet>
      </>
    );
  }

  return (
    // CF11 (the reference's contract): the closed menu must not mount Radix
    // popover machinery — one menu rides EVERY message row, and a closed
    // Popover.Root still settles with one extra internal commit per row.
    <CustomTooltip content={tooltip}>
      {open ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="discuss-sidechat-trigger"
              aria-label={tooltip}
              aria-disabled={disabled}
              disabled={disabled}
              className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
            >
              <Icons.sidechatDiscuss />
              <span className="text-t4">
                <Icons.Caret direction="d" />
              </span>
            </button>
          </Popover.Trigger>
          <Popover.Portal container={getModalPortal() ?? document.body}>
            <Popover.Content
              side="bottom"
              align="start"
              sideOffset={4}
              className="glass-blur z-50 rounded-lg border border-border bg-glass-bg p-2 shadow-[0_12px_36px_rgba(0,0,0,.45)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            >
              <div className="w-[220px]">
                <DiscussScopeBody onPick={pick} />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <button
          onClick={() => setOpen(true)}
          type="button"
          data-testid="discuss-sidechat-trigger"
          aria-label={tooltip}
          aria-disabled={disabled}
          disabled={disabled}
          className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
        >
          <Icons.sidechatDiscuss />
          <span className="text-t4">
            <Icons.Caret direction="d" />
          </span>
        </button>
      )}
    </CustomTooltip>
  );
}

// ─── Standalone scope chooser (SC-18c: the mobile action row no longer carries
// ─── the discuss trigger, so the message "..." sheet opens this chooser when
// ─── several variants exist — same rows, same keys, same onSelect contract).
// ─── The caller opens it AFTER its own sheet closes (no stacked overlays).
// ────────────────────────────────────────────────────────────────────────────

export function DiscussScopeSheet({ open, onClose, onSelect }: {
  open: boolean;
  onClose: () => void;
  onSelect: (scope: DiscussScope) => void;
}) {
  const { t } = useT();
  const tooltip = t("discuss_in_sidechat_tooltip");
  const pick = (scope: DiscussScope): void => {
    onClose();
    onSelect(scope);
  };
  return (
    <BottomSheet open={open} onClose={onClose} title={tooltip}>
      <DiscussScopeBody onPick={pick} />
    </BottomSheet>
  );
}

// ─── Shared body (desktop popover + mobile sheet) ────────────────────────────

function DiscussScopeBody({ onPick }: {
  onPick: (scope: DiscussScope) => void;
}) {
  const { t } = useT();
  const scopes: readonly DiscussScope[] = ["selected", "all"];
  return (
    <div className="flex flex-col gap-2 p-1">
      {scopes.map((scope) => (
        <button
          key={scope}
          type="button"
          data-testid={`discuss-scope-${scope}`}
          className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:bg-s2 hover:text-t1"
          onClick={() => onPick(scope)}
        >
          <span>{t(scope === "selected" ? "discuss_in_sidechat_selected" : "discuss_in_sidechat_all")}</span>
        </button>
      ))}
    </div>
  );
}
