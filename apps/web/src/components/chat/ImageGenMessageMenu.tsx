/**
 * Message-action image-generation menu (IMAGE_GENERATION_PLAN IG-16).
 *
 * Desktop: an icon+caret trigger in the MessageShell action row opening a
 * Radix popover (the MediaMenu desktop pattern). Mobile: an icon button in
 * the mobile action row opening a BottomSheet (the custom-content sheet
 * precedent — ActionSheet is items-only and cannot carry the Toggle row).
 * Both surfaces render the same body: the per-chat "Fine tuning" toggle
 * (shared across every message of the chat — plain zustand state, not
 * canonical data) and the eight generation-mode recipes in one FLAT list
 * (IPT Wave 5: selfie right after portrait, avatar right after character —
 * complement positions, never a grouped taxonomy). The profile pick is
 * NOT here — the design keeps provider+model in the Fine-tuning chip's
 * editor (design line 30: the popover is modes + toggle; the chip holds
 * provider+model); the menu reads the chat's active profile from the store
 * (activeProfileId ?? first — the IG-2 chat-level choice).
 *
 * While a generation is in flight the trigger renders as itself, DISABLED
 * (owner 2026-09-22, locked — IF-9: «я думаю, на прогресс строку логично.
 * и тогда убрать тот же морф из текстового сообщения, просто гасить
 * кнопку»): the explicit Stop lives on the progress row (the pill that
 * narrates the run), not in the menu — desktop and mobile alike. Mode
 * rows stay inert while running.
 *
 * The `free` recipe is a normal mode: it resolves the active image prompt
 * profile's free template. Fine tuning is an optional per-run override
 * layer, so its positive prompt may replace that template but never gates
 * the row.
 */

import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { IMAGE_GENERATION_MODES, IMAGE_GEN_BACKEND_CAPABILITIES, type ImageGenerationMode } from "@vibe-tavern/domain";

import { Icons } from "../shared/icons.js";
import { Toggle } from "../shared/Toggle.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { useT } from "../../i18n/context.js";
import { listAllImageGenProfiles, type ImageGenProfileRecord } from "../../api/image-gen-api.js";
import { EMPTY_IMAGE_GEN_DRAFT, buildDraftGenerateInput, resolveEffectiveImageGenProfile, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useModalStore } from "../../stores/modal-store.js";
import type { GenerateImageGenInput, ImageGenGenerateOverridesValue } from "@vibe-tavern/api-contracts";

/** The flat menu order (IPT Wave 5): the v1 registry order with the two
 *  Wave-0 complements at their owner-ruled positions — selfie right after
 *  portrait, avatar right after character. The domain registry appends the
 *  new modes at its tail (registry order is mode IDENTITY, not menu
 *  taxonomy); this list is the presentation order both variants render. */
const MODES: ImageGenerationMode[] = [
  IMAGE_GENERATION_MODES.SceneBackground,
  IMAGE_GENERATION_MODES.Portrait,
  IMAGE_GENERATION_MODES.Selfie,
  IMAGE_GENERATION_MODES.Character,
  IMAGE_GENERATION_MODES.Avatar,
  IMAGE_GENERATION_MODES.UserPersona,
  IMAGE_GENERATION_MODES.SceneIllustration,
  IMAGE_GENERATION_MODES.Free,
];

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
  const [open, setOpen] = useState(false);

  // The menu is an RP surface (owner 2026-09-18): co-author chats never
  // offer image generation — no trigger at all (no entry point exists
  // there, so nothing can be in flight for the chat either).
  const isCoauthorChat = useSnapshotStore((s) => s.activeChat?.mode === "coauthor");
  if (isCoauthorChat) return null;

  // IF-9: no Stop morph — while a run is in flight the trigger renders as
  // itself, disabled (the progress row owns cancel). The row-level
  // `disabled` (a busy chat turn) merges into the same idiom.
  const triggerDisabled = disabled || running !== undefined;

  if (variant === "mobile") {
    return (
      <>
        <button
          type="button"
          data-testid="image-gen-message-trigger"
          aria-label={t("image_gen_action_tooltip")}
          aria-disabled={triggerDisabled}
          disabled={triggerDisabled}
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
              aria-disabled={triggerDisabled}
              disabled={triggerDisabled}
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
          aria-disabled={triggerDisabled}
          disabled={triggerDisabled}
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
  const globalActiveId = useImageGenChatStore((s) => s.activeImageGenProfileId);
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

  // MR-5: the fallback chain — chat pick → global active → first row
  //  (the silent "first profile" default is dead; the chip's pick stays the
  //  per-chat override, the global card's pointer is the default).
  const effective = resolveEffectiveImageGenProfile(profiles, activeProfileId, globalActiveId);

  const startMode = (mode: ImageGenerationMode): void => {
    if (running !== undefined || effective === null) return;
    // FT-A3: the draft→generate fold is ONE shared implementation (the
    // store's buildDraftGenerateInput) — this menu (mode = the clicked row)
    // and the chip's Generate button (mode = the draft target, tail
    // anchor) fold identically: prompt VERBATIM when non-empty (IG-14),
    // picks as overrides with empty-means-not-sent semantics and the
    // IG-13/CG-C3 capability gates (negative, loras). The one-shot sampler
    // pick is GONE (FT-A1) — the model-settings overlay is the only
    // sampler source.
    const input = buildDraftGenerateInput({
      draft,
      effective,
      mode,
      anchorMessageId: messageId,
      foldDraft: fineTuning,
    });
    if (input === null) return;
    void runGeneration(chatId, input, {
      // PG-2: the START-time capability snapshot rides the run — Stop then
      // interrupts the local server-side job, the progress row polls it.
      // Derived from the STATIC table by the profile's backend — the saved
      // record's capability mirror is a save-time snapshot and can predate
      // the backend gaining live progress (the IG swipe-progress incident,
      // 2026-09-18); the registry's current truth is the only source.
      liveProgress: IMAGE_GEN_BACKEND_CAPABILITIES[effective.backend].supportsLiveProgress,
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
        const disabledRow = busy;
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
          </button>
        );
      })}
    </div>
  );
}
