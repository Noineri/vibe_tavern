/**
 * Fine-tuning pill above the chat input (IMAGE_GENERATION_PLAN IG-17,
 * restyled to the DicePanel pill canon 2026-09-15 — owner: "chip like the
 * dice one"). Lives in the PlayMode shared launcher bar next to DicePanel /
 * NarrationPlaylistPanel (the design's "chip above the input joins the dice
 * tray" line).
 *
 * Visible ONLY while the chat's "Fine tuning" toggle is on (the IG-16 gate
 * in `useImageGenChatStore.fineTuningByChat`). A compact pill (image icon +
 * label + caret; accent state while a draft prompt is armed) opens the
 * editor: desktop a Radix popover, mobile a BottomSheet — the same body on
 * both (the DicePanel pattern). The pill label is FIXED (the dice pill never
 * shows roll internals); profile/model/samplers live in the editor body.
 *
 * The editor holds the design's chip contents (design lines 30/160):
 * profile + model pick, sampler (only when the profile's capabilities
 * `supportsSamplers`), positive prompt, negative prompt (only when
 * `supportsNegativePrompt` — the IG-13 gate). Everything edits the per-chat
 * draft in the image-gen chat store; the message popover folds the draft
 * into the NEXT generation's payload (positive → verbatim `prompt`, picks +
 * negative → `overrides`).
 */

import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { Icons } from "../shared/icons.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { BottomSheet } from "../shared/BottomSheet.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { lblCls } from "../../lib/field-tokens.js";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import {
  listAllImageGenProfiles,
  listImageGenModels,
  listImageGenSamplers,
  type ImageGenModelEntry,
  type ImageGenProfileRecord,
} from "../../api/image-gen-api.js";
import type { ImageGenSamplerInfoValue } from "@vibe-tavern/api-contracts";
import { EMPTY_IMAGE_GEN_DRAFT, useImageGenChatStore } from "../../stores/image-gen-chat-store.js";

export interface ImageGenFineTuningChipProps {
  chatId: string;
}

export function ImageGenFineTuningChip({ chatId }: ImageGenFineTuningChipProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const fineTuning = useImageGenChatStore((s) => s.fineTuningByChat[chatId] ?? false);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId]);
  const [open, setOpen] = useState(false);

  if (!fineTuning) return null;

  const hasPrompt = (draft?.prompt.trim() ?? "") !== "";

  const body = <ImageGenFineTuningBody chatId={chatId} />;

  // The DicePanel structure verbatim: ONE popover (Root + Trigger own the
  // click → open on BOTH platforms), its Popover content desktop-only, and a
  // BottomSheet sibling for mobile — the same `body` on both.
  const popover = (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="image-gen-ft-chip"
          aria-label={t("image_gen_fine_tuning")}
          aria-expanded={open}
          className={cn(
            "glass-blur flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border2 bg-glass-bg px-2.5 py-1 font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1",
            hasPrompt && "border-accent/40 bg-accent-dim text-accent-t",
          )}
        >
          <Icons.images />
          <span>{t("image_gen_fine_tuning")}</span>
          <Icons.Caret direction={open ? "d" : "u"} />
        </button>
      </Popover.Trigger>
      {!isMobile && (
        <Popover.Portal container={getModalPortal() ?? document.body}>
          <Popover.Content
            side="top"
            align="center"
            sideOffset={4}
            className="glass-blur z-[220] w-[300px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border2 bg-glass-bg p-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {body}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );

  const sheet = open && isMobile && (
    <BottomSheet open={true} onClose={() => setOpen(false)} title={t("image_gen_fine_tuning")}>
      {body}
    </BottomSheet>
  );

  return (
    <div className="flex items-center" data-testid="image-gen-ft-chip-row">
      {popover}
      {sheet}
    </div>
  );
}

// ─── Shared editor body (desktop popover + mobile sheet) ────────────────────

function ImageGenFineTuningBody({ chatId }: { chatId: string }) {
  const { t } = useT();
  const activeProfileId = useImageGenChatStore((s) => s.activeProfileIdByChat[chatId]);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId] ?? EMPTY_IMAGE_GEN_DRAFT);
  const setActiveProfile = useImageGenChatStore((s) => s.setActiveProfile);
  const setFineTuningDraft = useImageGenChatStore((s) => s.setFineTuningDraft);
  const clearFineTuningDraft = useImageGenChatStore((s) => s.clearFineTuningDraft);
  const running = useImageGenChatStore((s) => s.runningByChat[chatId]);

  const [profiles, setProfiles] = useState<ImageGenProfileRecord[] | null>(null);
  const [models, setModels] = useState<ImageGenModelEntry[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [samplers, setSamplers] = useState<ImageGenSamplerInfoValue[] | null>(null);

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

  const effective = profiles?.find((p) => p.id === activeProfileId) ?? profiles?.[0] ?? null;
  const effectiveId = effective?.id ?? null;
  const caps = effective?.capabilities ?? null;
  const supportsSamplers = caps?.supportsSamplers ?? false;
  const supportsNegative = caps?.supportsNegativePrompt ?? false;

  // Model catalog for the effective profile (re-fetched on profile switch).
  useEffect(() => {
    if (effectiveId === null) {
      setModels(null);
      return;
    }
    let cancelled = false;
    setModels(null);
    setModelsFailed(false);
    void listImageGenModels(effectiveId)
      .then((list) => {
        if (!cancelled) setModels(list ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setModelsFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId]);

  // Sampler list — capability-gated before calling (the route 400s on
  // unsupported backends; the hook contract gates on supportsSamplers).
  useEffect(() => {
    if (effectiveId === null || !supportsSamplers) {
      setSamplers(null);
      return;
    }
    let cancelled = false;
    setSamplers(null);
    void listImageGenSamplers(effectiveId)
      .then((list) => {
        if (!cancelled) setSamplers(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setSamplers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveId, supportsSamplers]);

  if (profiles === null) {
    return <div className="flex h-16 items-center justify-center px-3 text-xs text-t3">…</div>;
  }

  const busy = running !== undefined;

  return (
    <div className="flex flex-col gap-2.5 p-1" data-testid="image-gen-ft-body">
      {/* Profile + model (the design's "provider + model selector"). The
          profile pick shares the IG-16 popover's store map. */}
      <div className="flex flex-col gap-1.5 px-1.5">
        <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_profile_label")}</span>
        <DropdownSelect
          value={effective?.id ?? ""}
          options={profiles.map((p) => ({ id: p.id, label: p.name }))}
          onChange={(id) => setActiveProfile(chatId, id)}
          triggerTestId="image-gen-ft-profile-select"
          disabled={busy}
        />
      </div>

      <div className="flex flex-col gap-1.5 px-1.5">
        <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_model_label")}</span>
        <DropdownSelect
          value={draft.model ?? ""}
          options={[
            { id: "", label: t("image_gen_chip_model_default") },
            ...(models ?? []).map((m) => ({ id: m.id, label: m.label })),
          ]}
          onChange={(id) => setFineTuningDraft(chatId, { model: id === "" ? undefined : id })}
          triggerTestId="image-gen-ft-model-select"
          disabled={busy || models === null}
        />
        {modelsFailed && (
          <span className="px-0.5 text-[calc(var(--ui-fs)-3px)] text-t4">{t("image_gen_chip_models_failed")}</span>
        )}
      </div>

      {supportsSamplers && (
        <div className="flex flex-col gap-1.5 px-1.5" data-testid="image-gen-ft-sampler-row">
          <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_sampler_label")}</span>
          <DropdownSelect
            value={draft.sampler ?? ""}
            options={[
              { id: "", label: t("image_gen_sampler_auto") },
              ...(samplers ?? []).map((s) => ({ id: s.name, label: s.name })),
            ]}
            onChange={(id) => setFineTuningDraft(chatId, { sampler: id === "" ? undefined : id })}
            triggerTestId="image-gen-ft-sampler-select"
            disabled={busy || samplers === null}
          />
        </div>
      )}

      <div className="my-0.5 h-px bg-border opacity-40" />

      <div className="flex flex-col gap-1.5 px-1.5">
        <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_prompt_label")}</span>
        <AutoTextarea
          value={draft.prompt}
          onChange={(e) => setFineTuningDraft(chatId, { prompt: e.target.value })}
          placeholder={t("image_gen_chip_prompt_placeholder")}
          minRows={2}
          maxRows={6}
          data-testid="image-gen-ft-prompt"
          aria-label={t("image_gen_chip_prompt_label")}
        />
      </div>

      {supportsNegative && (
        <div className="flex flex-col gap-1.5 px-1.5" data-testid="image-gen-ft-negative-row">
          <span className={`${lblCls} !mb-0 font-ui text-t2`}>{t("image_gen_chip_negative_label")}</span>
          <AutoTextarea
            value={draft.negative}
            onChange={(e) => setFineTuningDraft(chatId, { negative: e.target.value })}
            placeholder={t("image_gen_chip_negative_placeholder")}
            minRows={2}
            maxRows={4}
            data-testid="image-gen-ft-negative"
            aria-label={t("image_gen_chip_negative_label")}
          />
        </div>
      )}

      <div className="flex justify-end px-1.5">
        <button
          type="button"
          data-testid="image-gen-ft-clear"
          className="cursor-pointer rounded-md px-2 py-1 font-ui text-[calc(var(--ui-fs)-3px)] text-t3 transition-colors hover:bg-s2 hover:text-t1"
          onClick={() => clearFineTuningDraft(chatId)}
        >
          {t("image_gen_chip_clear")}
        </button>
      </div>
    </div>
  );
}
