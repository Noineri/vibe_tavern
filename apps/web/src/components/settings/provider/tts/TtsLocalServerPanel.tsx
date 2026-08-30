import { useState } from "react";

import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { copyText } from "../../../../lib/clipboard.js";
import { cn } from "../../../../lib/cn.js";
import { lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { AnimatedDisclosure } from "../../../shared/AnimatedDisclosure.js";
import { Icons } from "../../../shared/icons.js";
import {
  TTS_SERVER_SETUP_GUIDES,
  detectTtsOsKind,
  diagnosticI18nKey,
  worstDiagnostic,
} from "../../../../lib/tts/quickstarts.js";
import type { TtsHelpStep, TtsOsKind } from "../../../../lib/tts/quickstarts.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { useDockerStatus } from "./use-docker-status.js";
import { useTtsDiscovery } from "./use-tts-discovery.js";
import { configString, updateConfigField } from "./tts-form-helpers.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

function kindLabel(kind: string): string {
  if (kind === "kokoro-fastapi") return "Kokoro FastAPI";
  return "OpenAI-compatible";
}

export function TtsLocalServerPanel({ tts, form }: { tts: Pick<TtsHook, "setForm">; form: NonNullable<TtsHook["form"]> }) {
  const { t, tDynamic } = useT();
  const discovery = useTtsDiscovery();
  const docker = useDockerStatus();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // TE2-17: the setup reference is scoped to ONE chosen server; the OS
  // toggle defaults to the browser platform (auto-detect) and is always
  // manually switchable. It only affects the no-Docker branch.
  const [guideId, setGuideId] = useState<string>(TTS_SERVER_SETUP_GUIDES[0].id);
  const [os, setOs] = useState<TtsOsKind>(() => detectTtsOsKind(navigator.userAgent));

  // Locked: whole block renders ONLY for openai-compatible backend — the
  // "Local server" UI variant is exactly that backend plus the localServer
  // config flag (the editor mounts this panel only for that variant).
  if (form.backend !== TTS_BACKEND.OpenAiCompatible) return null;

  const currentEndpoint = configString(form.config, "endpoint");

  const worstCode = discovery.notFoundCodes !== null ? worstDiagnostic(discovery.notFoundCodes) : null;
  const diagKey = worstCode !== null ? diagnosticI18nKey(worstCode) : null;

  function setEndpoint(endpoint: string): void {
    updateConfigField(tts, form, "endpoint", endpoint);
  }

  async function handleCopy(copyId: string, command: string): Promise<void> {
    setCopyError(null);
    const result = await copyText(command);
    if (result.ok) {
      setCopiedId(copyId);
      window.setTimeout(() => setCopiedId((current) => (current === copyId ? null : current)), 1500);
    } else {
      setCopyError(result.error === "unsupported" ? t("tts_quickstart_copy_unsupported") : t("tts_quickstart_copy_failed"));
    }
  }

  return (
    <div data-testid="tts-local-server-panel" className="flex flex-col gap-4">
      {/* Honest docker availability (D8): probed server-side once. The cards
          below always show the non-docker variant too, so neither state is a
          dead end. */}
      <div data-testid="tts-docker-status" className="flex items-center gap-2 font-ui text-[11px] text-t3">
        {docker.error !== null ? (
          t("tts_docker_status_unknown")
        ) : docker.status === null ? (
          t("tts_docker_status_probing")
        ) : docker.status.available ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {t("tts_docker_status_ok", { version: docker.status.version ?? "" })}
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            {t("tts_docker_status_missing")}
          </>
        )}
      </div>

      {/* Setup help accordion — disclosure block forked verbatim from
          ProviderSamplerPanel.tsx (advOpen + caret rotate-90 chrome). */}
      <div className="overflow-hidden rounded-lg border border-border2" data-testid="tts-setup-help-accordion">
        <div
          className={cn(
            "flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer",
            helpOpen && "!rounded-b-none",
          )}
        >
          <span className="flex items-center gap-2" onClick={() => setHelpOpen(!helpOpen)} data-testid="tts-setup-help-toggle">
            <span className={cn("transition-transform", helpOpen && "rotate-90")}>
              <Icons.Caret direction="r" />
            </span>
            {t("tts_setup_help")}
          </span>
        </div>

        <AnimatedDisclosure open={helpOpen} className="border-t border-border2 bg-surface p-4" data-testid="tts-setup-help-body">
          <div className="flex flex-col gap-3">
            <div className="font-ui text-[11px] text-t4">{t("tts_help_hint")}</div>

            {/* Step 1 — choose the server (TE2-17). */}
            <div data-testid="tts-help-step-choose" className="flex flex-col gap-1.5">
              <label className={lblCls}>{t("tts_help_step_choose")}</label>
              {TTS_SERVER_SETUP_GUIDES.map((guide) => {
                const selected = guide.id === guideId;
                return (
                  <button
                    type="button"
                    key={guide.id}
                    data-testid={`tts-help-choice-${guide.id}`}
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

            {/* OS toggle — no-Docker branch only (Docker is OS-identical). */}
            <div data-testid="tts-help-os-toggle" className="flex items-center justify-between gap-2">
              <span className={lblCls}>{t("tts_help_os_label")}</span>
              <SegmentedControl<TtsOsKind>
                compact
                value={os}
                options={[
                  { value: "windows", label: t("tts_help_os_windows") },
                  { value: "unix", label: t("tts_help_os_unix") },
                ]}
                onChange={setOs}
              />
            </div>

            {/* How to run the commands below — one hint for every card
                (novices paste blocks into nowhere; owner field-test finding). */}
            <div data-testid="tts-help-terminal-hint" className="font-ui text-[11px] text-t4">
              {t("tts_help_terminal_hint")}
            </div>

            {(() => {
              const guide = TTS_SERVER_SETUP_GUIDES.find((g) => g.id === guideId) ?? TTS_SERVER_SETUP_GUIDES[0];
              const step = (id: string, s: TtsHelpStep) => (
                <div key={id} data-testid={`tts-help-step-${id}`} className="flex flex-col gap-1.5">
                  <label className={lblCls}>{t(s.titleKey)}</label>
                  {s.commands[os].map((command, index) => {
                    const copyId = `${guide.id}-${id}-${index}`;
                    return (
                      <div key={index} className="flex items-center gap-2">
                        <div className={`${monoUICls} min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2 py-1.5 text-[11px]`}>
                          {command}
                        </div>
                        <button
                          type="button"
                          data-testid={`tts-help-copy-${copyId}`}
                          className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
                          onClick={() => void handleCopy(copyId, command)}
                        >
                          <Icons.Copy />
                          {copiedId === copyId ? t("tts_quickstart_copied") : t("tts_quickstart_copy")}
                        </button>
                      </div>
                    );
                  })}
                  {s.noteKey !== undefined && (
                    <div className="font-ui text-[11px] text-t4">{t(s.noteKey)}</div>
                  )}
                </div>
              );
              return (
                <>
                  {/* Step 2 — download: docker or clone. */}
                  {step("download-docker", guide.docker)}
                  {step("download-clone", guide.clone)}
                  {/* Step 3 — install (per-OS; note-only when the server
                      bootstraps itself). */}
                  {step("install", guide.install)}
                  {/* Step 4 — run: a separate copyable command, never glued
                      into the clone with &&. */}
                  {step("run", guide.run)}
                  {/* Step 5 — endpoint to paste (adopt flow preserved). */}
                  <div data-testid="tts-help-step-endpoint" className="flex flex-col gap-1.5">
                    <label className={lblCls}>{t("tts_help_step_endpoint")}</label>
                    <div className="flex items-center gap-2">
                      <div className={`${monoUICls} min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2 py-1.5 text-[11px] text-t3`}>
                        {guide.endpoint}
                      </div>
                      <button
                        type="button"
                        data-testid={`tts-help-use-${guide.id}`}
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 font-ui text-[11px] text-white transition-colors hover:bg-accent/90"
                        onClick={() => setEndpoint(guide.endpoint)}
                      >
                        {t("tts_discover_adopt")}
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}
            {copyError !== null && <div className="font-ui text-[11px] text-danger">{copyError}</div>}
          </div>
        </AnimatedDisclosure>
      </div>

      <div className="flex flex-col gap-2">
        <label className={lblCls}>{t("tts_discover_section")}</label>
        <button
          type="button"
          data-testid="tts-discover-btn"
          disabled={discovery.scanning}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
          onClick={() => void discovery.discover()}
        >
          {discovery.scanning ? t("tts_discover_scanning") : t("tts_discover_btn")}
        </button>

        {discovery.error !== null && (
          <div data-testid="tts-discover-error" className="font-ui text-[12px] text-danger">
            {discovery.error}
          </div>
        )}

        {!discovery.scanning && discovery.error === null && discovery.servers.length === 0 && discovery.notFoundCodes !== null && (
          <>
            <div data-testid="tts-discover-none" className="font-ui text-[12px] text-t3">
              {t("tts_discover_none")}
            </div>
            {diagKey !== null && (
              <div data-testid="tts-discover-diag" className="font-ui text-[11px] text-t3">
                {tDynamic(diagKey)}
              </div>
            )}
          </>
        )}

        {discovery.servers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {discovery.servers.map((server) => {
              const isAdopted = currentEndpoint === `${server.baseUrl}/v1`;
              return (
                <div
                  key={server.port}
                  data-testid={`tts-discover-result-${server.port}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-s1 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-ui text-[12px] font-medium text-t1">{kindLabel(server.kind)}</span>
                    <span className="truncate font-mono text-[11px] text-t3">{server.baseUrl}</span>
                    <span className="font-ui text-[11px] text-t3">
                      {server.voiceIds.length} {t("tts_discover_voices_count")}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid={`tts-discover-adopt-${server.port}`}
                    disabled={isAdopted}
                    className={
                      isAdopted
                        ? "flex cursor-default items-center gap-1 rounded bg-accent/20 px-2 py-1 font-ui text-[11px] text-accent"
                        : "flex cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 font-ui text-[11px] text-white transition-colors hover:bg-accent/90"
                    }
                    onClick={() => setEndpoint(`${server.baseUrl}/v1`)}
                  >
                    {isAdopted && <Icons.Check />}
                    {t("tts_discover_adopt")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
