/**
 * Message-action image-generation menu (IMAGE_GENERATION_PLAN IG-16).
 *
 * Desktop: an icon+caret trigger in the MessageShell action row opening a
 * Radix popover (the MediaMenu desktop pattern). Mobile: an icon button in
 * the mobile action row opening a BottomSheet (the custom-content sheet
 * precedent — ActionSheet is items-only and cannot carry the Toggle row).
 * Both surfaces render the same body: the per-chat "Fine tuning" toggle
 * (shared across every message of the chat — plain zustand state, not
 * canonical data) and the six generation-mode recipes. The profile pick is
 * NOT here — the design keeps provider+model in the Fine-tuning chip's
 * editor (design line 30: the popover is modes + toggle; the chip holds
 * provider+model); the menu reads the chat's active profile from the store
 * (activeProfileId ?? first — the IG-2 chat-level choice).
 *
 * While a generation is in flight the trigger morphs into the explicit Stop
 * control (owner 2026-09-14 — local backends have NO timeout, cancel is the
 * only limit): every message's trigger for that chat shows Stop; clicking it
 * aborts the shared per-chat AbortController (one in-flight generation per
 * chat in v1). Mode rows are inert while running.
 *
 * The `free` recipe is enabled only while Fine tuning is on AND the IG-17
 * chip's positive prompt is non-empty: the server REQUIRES free's raw
 * prompt (`prompt` on the generate contract), and that field is the chip's
 * positive-prompt editor. With the toggle off (or an empty chip prompt) the
 * row stays disabled with its hint.
 */

import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { IMAGE_GENERATION_MODES, type ImageGenerationMode } from "@vibe-tavern/domain";

import { Icons } from "../shared/icons.js";
import { Toggle } from "../shared/Toggle.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { useT } from "../../i18n/context.js";
import { listAllImageGenProfiles, type ImageGenProfileRecord } from "../../api/image-gen-api.js";
import { EMPTY_IMAGE_GEN_DRAFT, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useModalStore } from "../../stores/modal-store.js";
import type { GenerateImageGenInput, ImageGenGenerateOverridesValue } from "@vibe-tavern/api-contracts";

/** The v1 mode order the popover lists (registry order, no new names). */
const MODES: ImageGenerationMode[] = Object.values(IMAGE_GENERATION_MODES);

export interface ImageGenMessageMenuProps {
  chatId: string;
  /** The message the generation anchors to (slot position + context). */
  messageId: string;
  variant: "desktop" | "mobile";
  /** Row convention: inert while a chat turn is busy (isBusy). */
  disabled?: boolean;
}

export function ImageGenMessageMenu({ chatId, messageId, variant, disabled = false }: ImageGenMessageMenuProps) {
  const { t } = useT();
  const running = useImageGenChatStore((s) => s.runningByChat[chatId]);
  const abortGeneration = useImageGenChatStore((s) => s.abortGeneration);
  const [open, setOpen] = useState(false);

  // ── Stop morph: every message's trigger for this chat is the Stop while
  //    a generation is in flight (they all abort the same shared run).
  if (running !== undefined) {
    if (variant === "mobile") {
      return (
        <button
          type="button"
          data-testid="image-gen-message-stop"
          aria-label={t("image_gen_stop_tooltip")}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-accent animate-pulse active:bg-s2 [&_svg]:h-5 [&_svg]:w-5"
          onClick={() => abortGeneration(chatId)}
        >
          <Icons.stopSquare />
        </button>
      );
    }
    return (
      <CustomTooltip content={t("image_gen_stop_tooltip")}>
        <button
          type="button"
          data-testid="image-gen-message-stop"
          aria-label={t("image_gen_stop_tooltip")}
          className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-accent animate-pulse transition-colors duration-100 hover:bg-s2"
          onClick={() => abortGeneration(chatId)}
        >
          <Icons.stopSquare />
          <Icons.Caret direction="d" />
        </button>
      </CustomTooltip>
    );
  }

  if (variant === "mobile") {
    return (
      <>
        <button
          type="button"
          data-testid="image-gen-message-trigger"
          aria-label={t("image_gen_action_tooltip")}
          aria-disabled={disabled}
          disabled={disabled}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-t3 active:bg-s2 disabled:cursor-default disabled:opacity-40 [&_svg]:h-5 [&_svg]:w-5"
          onClick={() => setOpen(true)}
        >
          <Icons.images />
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t("image_gen_section_title")}>
          <ImageGenMenuBody chatId={chatId} messageId={messageId} onDone={() => setOpen(false)} />
        </BottomSheet>
      </>
    );
  }

  return (
    // CF11: the closed menu must not mount Radix popover machinery. A closed
    // Popover.Root still settles with one extra internal commit right after
    // mount, and one menu rides EVERY message row — that per-row settle reads
    // as a MessageBlock re-render in commit-counting isolation tests (and is
    // N dead Radix contexts in a long chat). So: closed = plain button inside
    // the tooltip; the real popover mounts only once opened (the mobile side's
    // BottomSheet-on-open twin). Keyboard/mouse open the same setOpen path.
    <CustomTooltip content={t("image_gen_action_tooltip")}>
      {open ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="image-gen-message-trigger"
              aria-label={t("image_gen_action_tooltip")}
              aria-disabled={disabled}
              disabled={disabled}
              className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
            >
              <Icons.images />
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
              <div className="w-[260px]">
                <ImageGenMenuBody chatId={chatId} messageId={messageId} onDone={() => setOpen(false)} />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <button
          onClick={() => setOpen(true)}
          type="button"
          data-testid="image-gen-message-trigger"
          aria-label={t("image_gen_action_tooltip")}
          aria-disabled={disabled}
          disabled={disabled}
          className="flex cursor-pointer items-center gap-1 rounded px-[7px] py-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors duration-100 hover:bg-s2 hover:text-t2 disabled:cursor-default disabled:opacity-40"
        >
          <Icons.images />
          <span className="text-t4">
            <Icons.Caret direction="d" />
          </span>
        </button>
      )}
    </CustomTooltip>
  );
}

// ─── Shared body (desktop popover + mobile sheet) ────────────────────────────

function ImageGenMenuBody({ chatId, messageId, onDone }: {
  chatId: string;
  messageId: string;
  onDone: () => void;
}) {
  const { t, tDynamic } = useT();
  const running = useImageGenChatStore((s) => s.runningByChat[chatId]);
  const fineTuning = useImageGenChatStore((s) => s.fineTuningByChat[chatId] ?? false);
  // The chat's profile choice (read-only here — the chip's editor owns the
  // pick; this menu only CONSUMES it for the generate payload).
  const activeProfileId = useImageGenChatStore((s) => s.activeProfileIdByChat[chatId]);
  const setFineTuning = useImageGenChatStore((s) => s.setFineTuning);
  const runGeneration = useImageGenChatStore((s) => s.runGeneration);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setIsProviderModalOpen = useModalStore((s) => s.setIsProviderModalOpen);
  const [profiles, setProfiles] = useState<ImageGenProfileRecord[] | null>(null);

  // Load the profile list on mount (the MediaMenu load-on-open twin — this
  // body mounts only while the popover/sheet is open). Fetch failure = the
  // empty state, not a crash (MediaMenu precedent).
  useEffect(() => {
    let cancelled = false;
    void listAllImageGenProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The chat's profile choice — undefined falls back to the first profile
  // (IG-2: "active" is a chat-level concern; no server default pointer).
  const effective = profiles?.find((p) => p.id === activeProfileId) ?? profiles?.[0] ?? null;

  const startMode = (mode: ImageGenerationMode): void => {
    if (running !== undefined || effective === null) return;
    const input: GenerateImageGenInput = { profileId: effective.id, mode, anchorMessageId: messageId };
    // IG-17: while Fine tuning is on the chip's draft rides the request —
    // the positive prompt VERBATIM (the IG-14 contract: a present prompt is
    // never re-templated server-side), the picks + negative as overrides.
    // Empty trimmed strings are not sent (the contract's fallback
    // semantics); the negative additionally gates on the profile's
    // capability (IG-13) so an unsupported backend never receives one.
    if (fineTuning) {
      const prompt = draft.prompt.trim();
      if (prompt !== "") input.prompt = prompt;
      const overrides: ImageGenGenerateOverridesValue = {};
      const negative = draft.negative.trim();
      if (negative !== "" && effective.capabilities.supportsNegativePrompt) {
        overrides.negativePrompt = negative;
      }
      if (draft.model !== undefined && draft.model !== "") overrides.model = draft.model;
      if (draft.sampler !== undefined && draft.sampler !== "") overrides.sampler = draft.sampler;
      // CG-C3: enabled loras ride the run — capability-gated exactly like
      // the negative (a profile without supportsLoras never sees them).
      // Entry order = ComfyUI chain order; strength verbatim from the chip.
      if (draft.loras !== undefined && draft.loras.length > 0 && effective.capabilities.supportsLoras === true) {
        overrides.loras = draft.loras;
      }
      if (Object.keys(overrides).length > 0) input.overrides = overrides;
    }
    void runGeneration(chatId, input, {
      // PG-2: the START-time capability snapshot rides the run — Stop then
      // interrupts the local server-side job, the progress row polls it.
      liveProgress: effective.capabilities.supportsLiveProgress,
    });
    onDone();
  };

  const busy = running !== undefined;

  if (profiles === null) {
    return <div className="flex h-16 items-center justify-center px-3 text-xs text-t3">…</div>;
  }

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
        <div className="text-xs text-t3">{t("image_gen_no_profiles")}</div>
        <button
          type="button"
          data-testid="image-gen-empty-open-settings"
          className="cursor-pointer rounded-full bg-accent-dim px-3 py-1 text-xs font-medium text-accent-t transition-colors hover:bg-accent-hover"
          onClick={() => {
            onDone();
            setIsProviderModalOpen(true);
          }}
        >
          {t("image_gen_open_settings")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-1">
      {/* Fine tuning — per-chat, default off; the chip it activates is IG-17. */}
      <div className="flex items-center justify-between gap-3 px-1.5">
        <span className="font-ui text-[calc(var(--ui-fs)-2px)] text-t2">{t("image_gen_fine_tuning")}</span>
        <Toggle checked={fineTuning} onChange={(on) => setFineTuning(chatId, on)} aria-label={t("image_gen_fine_tuning")} />
      </div>

      <div className="my-0.5 h-px bg-border opacity-40" />

      {busy && (
        <div className="flex items-center gap-2 px-1.5 text-xs text-accent animate-pulse">
          <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          {t("image_gen_generating")}
        </div>
      )}

      {MODES.map((mode) => {
        // `free` unparks with IG-17: enabled while Fine tuning is on AND the
        // chip's positive prompt is non-empty (its raw payload — the locked
        // contract rejects a prompt-less free request). Off-toggle or an
        // empty chip prompt keeps the row disabled with the hint.
        const isFree = mode === IMAGE_GENERATION_MODES.Free;
        const freeBlocked = !fineTuning || draft.prompt.trim() === "";
        const disabledRow = busy || (isFree && freeBlocked);
        return (
          <button
            key={mode}
            type="button"
            data-testid={`image-gen-mode-${mode}`}
            aria-disabled={disabledRow}
            disabled={disabledRow}
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
            onClick={() => startMode(mode)}
          >
            <span>{tDynamic(`image_gen_mode_${mode}`)}</span>
            {isFree && freeBlocked && <span className="text-[calc(var(--ui-fs)-3px)] text-t4">{t("image_gen_free_hint")}</span>}
          </button>
        );
      })}
    </div>
  );
}
