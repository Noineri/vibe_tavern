/**
 * Fine-tuning chip above the chat input (IMAGE_GENERATION_PLAN IG-17).
 *
 * Visible ONLY while the chat's "Fine tuning" toggle is on (the IG-16 gate
 * in `useImageGenChatStore.fineTuningByChat`). A compact summary row (image
 * icon + profile + model) opens the editor: desktop a Radix popover, mobile
 * a BottomSheet — the same body on both (the ImageGenMessageMenu pattern).
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
import { CustomTooltip } from "../shared/Tooltip.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { getModalPortal } from "../shared/modal-helpers.js";
import { lblCls } from "../../lib/field-tokens.js";
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
  variant: "desktop" | "mobile";
}

export function ImageGenFineTuningChip({ chatId, variant }: ImageGenFineTuningChipProps) {
  const { t } = useT();
  const fineTuning = useImageGenChatStore((s) => s.fineTuningByChat[chatId] ?? false);
  const activeProfileId = useImageGenChatStore((s) => s.activeProfileIdByChat[chatId]);
  const draft = useImageGenChatStore((s) => s.fineTuningDraftByChat[chatId]);
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ImageGenProfileRecord[] | null>(null);

  // Profile list for the summary label (the menu's load-once pattern — the
  // chip is mounted while the toggle is on, so mount-load == open-load).
  useEffect(() => {
    if (!fineTuning) return;
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
  }, [fineTuning]);

  if (!fineTuning) return null;

  const effective = profiles?.find((p) => p.id === activeProfileId) ?? profiles?.[0] ?? null;
  const summaryModel = draft?.model ?? effective?.modelId ?? null;
  const hasPrompt = (draft?.prompt.trim() ?? "") !== "";

  const triggerButton = (
    <button
      type="button"
      data-testid="image-gen-ft-chip"
      aria-label={t("image_gen_fine_tuning")}
      aria-expanded={open}
      className="flex h-[26px] min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-t3 transition-colors hover:bg-s2 hover:text-t1"
    >
      <span className="shrink-0 text-accent-t">
        <Icons.images />
      </span>
      <span className="min-w-0 truncate font-ui text-[calc(var(--ui-fs)-3px)]">
        {effective === null ? t("image_gen_fine_tuning") : effective.name}
        {summaryModel !== null && summaryModel !== "" ? ` · ${summaryModel}` : ""}
      </span>
      {hasPrompt && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      <span className="shrink-0 text-t4">
        <Icons.Caret direction="u" />
      </span>
    </button>
  );

  if (variant === "mobile") {
    return (
      <div className="flex items-center" data-testid="image-gen-ft-chip-row">
        {triggerButton}
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t("image_gen_fine_tuning")}>
          <ImageGenFineTuningBody chatId={chatId} />
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className="flex items-center" data-testid="image-gen-ft-chip-row">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <CustomTooltip content={t("image_gen_chip_tooltip")}>
          <Popover.Trigger asChild>{triggerButton}</Popover.Trigger>
        </CustomTooltip>
        <Popover.Portal container={getModalPortal() ?? document.body}>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={6}
            className="glass-blur z-50 rounded-lg border border-border bg-glass-bg p-2 shadow-[0_12px_36px_rgba(0,0,0,.45)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            <div className="w-[300px]">
              <ImageGenFineTuningBody chatId={chatId} />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
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
