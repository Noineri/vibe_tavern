import { useCallback, useEffect, useState } from "react";

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { draftListImageGenModels } from "../../../../api/image-gen-api.js";
import { copyText } from "../../../../lib/clipboard.js";
import { cn } from "../../../../lib/cn";
import { detectTtsOsKind } from "../../../../lib/tts/quickstarts.js";
import { lblCls, codeQuoteCls } from "../../../../lib/field-tokens.js";
import { AnimatedDisclosure } from "../../../shared/AnimatedDisclosure.js";
import { Icons } from "../../../shared/icons.js";
import { LocalConnectionStatusChip, type LocalConnectionStatus } from "../../../shared/LocalConnectionStatus.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { useGuideChecklist } from "../../../../hooks/use-guide-checklist.js";
import { GuideCommandRow } from "../GuideCommandRow.js";
import {
  IMAGE_GEN_SERVER_GUIDES,
  type ImageGenHelpStep,
  type ImageGenOsKind,
} from "../../../../lib/imagegen/imagegen-local-guides.js";
import type { ImageGenProfileForm, useImageProfiles } from "../../../../hooks/use-image-profiles.js";

type ImageGenHook = ReturnType<typeof useImageProfiles>;

/** The image-gen local-server help panel (IMAGEGEN_POLISH_REPORT PG-1): fork
 *  SUBSET of SttLocalServerPanel — the setup-help accordion + the honest
 *  endpoint chip. Deliberately DROPS the STT port-scan block (image-gen has
 *  no scan route — A1111-family UIs answer the draft-models probe directly)
 *  and the TTS docker probe (this family is not docker-distributed).
 *  Renders for the LOCAL dialects (A1111 family + ComfyUI — CG-B1); each
 *  dialect keeps its own guide card in IMAGE_GEN_SERVER_GUIDES. */
export function ImageGenLocalServerPanel({
  form,
  updateForm,
}: {
  form: ImageGenProfileForm;
  updateForm: <K extends keyof ImageGenProfileForm>(k: K, v: ImageGenProfileForm[K]) => void;
}) {
  const { t } = useT();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [guideId, setGuideId] = useState<string>(
    // The backend's own preset row opens preselected (a comfy profile
    // opens on the comfy guide — no a1111-first detour through commands
    // that do not apply to it).
    form.backend === IMAGE_GEN_BACKENDS.ComfyUI
      ? (IMAGE_GEN_SERVER_GUIDES.find((g) => g.id === "comfyui")?.id ?? IMAGE_GEN_SERVER_GUIDES[0].id)
      : IMAGE_GEN_SERVER_GUIDES[0].id,
  );
  const [os, setOs] = useState<ImageGenOsKind>(() => detectTtsOsKind(navigator.userAgent));
  // Manual per-command done-marks, persisted per guide+OS (the shared
  // tracker the TTS/STT panels use).
  const checklist = useGuideChecklist(guideId, os);

  // The local segment's dialects (A1111 family + ComfyUI, CG-B1).
  if (form.backend !== IMAGE_GEN_BACKENDS.A1111 && form.backend !== IMAGE_GEN_BACKENDS.ComfyUI) return null;

  // The chip's honest ping (the IG-CF12d rule the STT/TTS twins follow):
  // the draft-models route is the same reachability proof the Test
  // connection button uses — one mount probe + the chip's re-check button;
  // an empty endpoint draws no conclusion (unknown), edits do not auto
  // re-ping.
  const [pingStatus, setPingStatus] = useState<LocalConnectionStatus>("unknown");
  const pingServer = useCallback(async () => {
    if (form.endpoint.trim() === "") {
      setPingStatus("unknown");
      return;
    }
    setPingStatus("checking");
    try {
      await draftListImageGenModels({
        backend: form.backend,
        // The just-typed key rides inside the draft config (the draft
        // rule); profileId enables stored-key resolution.
        config: {
          endpoint: form.endpoint.trim(),
          ...(form.apiKey.trim() !== "" ? { apiKey: form.apiKey.trim() } : {}),
        },
        profileId: form.id ?? undefined,
      });
      setPingStatus("online");
    } catch {
      setPingStatus("offline");
    }
  }, [form]);
  useEffect(() => {
    void pingServer();
    // Mount-only one-shot: the re-check button re-fires with the CURRENT
    // form; edits do not auto-re-ping.
  }, []);

  async function handleCopy(copyId: string, command: string): Promise<void> {
    setCopyError(null);
    const result = await copyText(command);
    if (result.ok) {
      setCopiedId(copyId);
      window.setTimeout(() => setCopiedId((current) => (current === copyId ? null : current)), 1500);
    } else {
      setCopyError(result.error === "unsupported" ? t("image_gen_local_copy_unsupported") : t("image_gen_local_copy_failed"));
    }
  }

  return (
    <div data-testid="image-gen-local-server-panel" className="flex flex-col gap-4">
      {/* Canonical local-connection chip (IG-CF12c/12d): status = the
          honest endpoint ping above; no docker detail line on this family. */}
      <LocalConnectionStatusChip
        testId="image-gen-local-status"
        status={pingStatus}
        endpoint={form.endpoint}
        onRefresh={() => void pingServer()}
        refreshing={pingStatus === "checking"}
        refreshLabel={t("test_connection")}
      />

      {/* Setup help accordion — disclosure block mirroring
          SttLocalServerPanel. */}
      <div className="overflow-hidden rounded-lg border border-border2" data-testid="image-gen-setup-help-accordion">
        <div
          className={cn(
            "flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer",
            helpOpen && "!rounded-b-none",
          )}
        >
          <span className="flex items-center gap-2" onClick={() => setHelpOpen(!helpOpen)} data-testid="image-gen-setup-help-toggle">
            <span className={cn("transition-transform", helpOpen && "rotate-90")}>
              <Icons.Caret direction="r" />
            </span>
            {t("image_gen_local_setup_help")}
          </span>
        </div>

        <AnimatedDisclosure open={helpOpen} className="border-t border-border2 bg-surface p-4" data-testid="image-gen-setup-help-body">
          <div className="flex flex-col gap-3">
            <div className="font-ui text-[11px] text-t4">{t("image_gen_local_help_hint")}</div>

            {/* Step 1 — choose the server family (one card today; ComfyUI
                and others join when their adapters land). */}
            <div data-testid="image-gen-help-step-choose" className="flex flex-col gap-1.5">
              <label className={lblCls}>{t("image_gen_local_step_choose")}</label>
              {IMAGE_GEN_SERVER_GUIDES.map((guide) => {
                const selected = guide.id === guideId;
                return (
                  <button
                    type="button"
                    key={guide.id}
                    data-testid={`image-gen-help-choice-${guide.id}`}
                    onClick={() => setGuideId(guide.id)}
                    className={cn(
                      "flex cursor-pointer flex-col gap-0.5 rounded-md border bg-s1 px-3 py-2 text-left transition-colors hover:bg-s2",
                      selected ? "border-accent" : "border-border",
                    )}
                  >
                    <span className="flex items-center gap-2 font-ui text-[12px] font-medium text-t1">
                      {selected && <Icons.Check />}
                      {guide.name}
                    </span>
                    <span className="font-ui text-[11px] text-t3">{t(guide.descriptionKey)}</span>
                  </button>
                );
              })}
            </div>

            {/* OS toggle — the launch commands differ per family. */}
            <div data-testid="image-gen-help-os-toggle" className="flex items-center justify-between gap-2">
              <span className={lblCls}>{t("image_gen_local_os_label")}</span>
              <SegmentedControl<ImageGenOsKind>
                compact
                value={os}
                options={[
                  { value: "windows", label: t("image_gen_local_os_windows") },
                  { value: "unix", label: t("image_gen_local_os_unix") },
                ]}
                onChange={setOs}
              />
            </div>

            <div
              data-testid="image-gen-help-terminal-hint"
              className="flex items-center justify-between gap-2 font-ui text-[11px] text-t4"
            >
              <span>{t("image_gen_local_terminal_hint")}</span>
              {checklist.total > 0 && (
                <button
                  type="button"
                  data-testid="image-gen-help-reset-checks"
                  className="shrink-0 cursor-pointer font-ui text-[11px] text-t3 underline underline-offset-2 transition-colors hover:text-t1"
                  onClick={checklist.reset}
                >
                  {t("image_gen_local_reset_checks")}
                </button>
              )}
            </div>

            {(() => {
              const guide = IMAGE_GEN_SERVER_GUIDES.find((g) => g.id === guideId) ?? IMAGE_GEN_SERVER_GUIDES[0];
              const step = (id: string, s: ImageGenHelpStep) => (
                <div key={id} data-testid={`image-gen-help-step-${id}`} className="flex flex-col gap-1.5">
                  <label className={lblCls}>{t(s.titleKey)}</label>
                  {s.commands[os].map((command, index) => {
                    const copyId = `${guide.id}-${id}-${index}`;
                    return (
                      <GuideCommandRow
                        key={index}
                        command={command}
                        testPrefix="image-gen-help"
                        copyId={copyId}
                        copied={copiedId === copyId}
                        onCopy={() => void handleCopy(copyId, command)}
                        copyLabel={t("image_gen_local_copy")}
                        copiedLabel={t("image_gen_local_copied")}
                        checked={checklist.isChecked(id, index)}
                        onToggleChecked={() => checklist.toggle(id, index)}
                        checkLabel={t("image_gen_local_mark_done")}
                      />
                    );
                  })}
                  {s.noteKey !== undefined && (
                    <div className="font-ui text-[11px] text-t4">{t(s.noteKey)}</div>
                  )}
                </div>
              );
              return (
                <>
                  {/* Start the server with the API enabled — the owner's
                      case (1): the flags ARE the content; per-UI launcher
                      lines cover the Forge/ReForge/SD.Next variations. */}
                  {step("run", guide.run)}
                  {/* Endpoint to paste (adopt flow). */}
                  <div data-testid="image-gen-help-step-endpoint" className="flex flex-col gap-1.5">
                    <label className={lblCls}>{t("image_gen_local_step_endpoint")}</label>
                    <div className="flex items-center gap-2">
                      <div className={cn(codeQuoteCls, "flex-1")}>
                        {guide.endpoint}
                      </div>
                      <button
                        type="button"
                        data-testid={`image-gen-help-use-${guide.id}`}
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 font-ui text-[11px] text-white transition-colors hover:bg-accent/90"
                        onClick={() => updateForm("endpoint", guide.endpoint)}
                      >
                        {t("image_gen_local_adopt")}
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}

            {/* Diagnosis hints — the owner's cases (2) and (3): the 404
                means the --api flag is missing; a mid-generation 502/timeout
                means the GPU is busy with another local service. */}
            <div data-testid="image-gen-help-diagnosis" className="flex flex-col gap-1.5 border-t border-border2 pt-3">
              <label className={lblCls}>{t("image_gen_local_diag_title")}</label>
              <div className="font-ui text-[11px] text-t3">{t("image_gen_local_diag_404")}</div>
              <div className="font-ui text-[11px] text-t3">{t("image_gen_local_diag_gpu")}</div>
            </div>
            {copyError !== null && <div className="font-ui text-[11px] text-danger">{copyError}</div>}
          </div>
        </AnimatedDisclosure>
      </div>
    </div>
  );
}
