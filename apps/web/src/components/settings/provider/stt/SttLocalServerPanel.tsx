import { useState } from "react";

import { STT_BACKENDS } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { copyText } from "../../../../lib/clipboard.js";
import { cn } from "../../../../lib/cn.js";
import { detectTtsOsKind, worstDiagnostic, diagnosticI18nKey } from "../../../../lib/tts/quickstarts.js";
import { lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { AnimatedDisclosure } from "../../../shared/AnimatedDisclosure.js";
import { Icons } from "../../../shared/icons.js";
import { SegmentedControl } from "../../../shared/SegmentedControl.js";
import { STT_SERVER_GUIDES, type SttHelpStep, type SttOsKind } from "../../../../lib/stt/stt-server-guides.js";
import { useSttDiscovery } from "./use-stt-discovery.js";
import { configString, updateConfigField } from "./stt-form-helpers.js";
import type { SttProfileForm, useSttProfiles } from "./use-stt-profiles.js";

type SttHook = ReturnType<typeof useSttProfiles>;

/** The STT local-server panel (STT_PLAN ST-8): fork SUBSET of
 *  TtsLocalServerPanel — the setup-help accordion + the port-scan block.
 *  Deliberately DROPS the TTS docker-status probe (that is a TTS-only D8
 *  route; STT discovery is pure port probing) and the voices count (STT has
 *  no voices). Renders ONLY for the openai-compat backend — the whisper-browser
 *  tier is in-browser and needs no server. */
export function SttLocalServerPanel({ form, stt }: { form: SttProfileForm; stt: Pick<SttHook, "setForm"> }) {
  const { t, tDynamic } = useT();
  const discovery = useSttDiscovery();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [guideId, setGuideId] = useState<string>(STT_SERVER_GUIDES[0].id);
  const [os, setOs] = useState<SttOsKind>(() => detectTtsOsKind(navigator.userAgent));

  if (form.backend !== STT_BACKENDS.OpenAiCompat) return null;

  const currentEndpoint = configString(form.config, "endpoint");

  const worstCode = discovery.notFoundCodes !== null ? worstDiagnostic(discovery.notFoundCodes) : null;
  const diagKey = worstCode !== null ? diagnosticI18nKey(worstCode) : null;

  async function handleCopy(copyId: string, command: string): Promise<void> {
    setCopyError(null);
    const result = await copyText(command);
    if (result.ok) {
      setCopiedId(copyId);
      window.setTimeout(() => setCopiedId((current) => (current === copyId ? null : current)), 1500);
    } else {
      setCopyError(result.error === "unsupported" ? t("stt_local_copy_unsupported") : t("stt_local_copy_failed"));
    }
  }

  /** Adopt a discovered server: fill the openai-compat endpoint (the config
   *  stores the base INCLUDING `/v1` — see the backend's parseConfig) and,
   *  when a whisper-named model was found, pre-fill it too. The config is
   *  written in ONE atomic setForm: the form prop is CONTROLLED (unchanged
   *  while the panel is open), so two sequential updateConfigField calls
   *  would each spread the same stale config and the second would clobber
   *  the first's endpoint. */
  function adoptServer(baseUrl: string, modelIds: string[]): void {
    const next: Record<string, unknown> = { ...form.config, endpoint: `${baseUrl}/v1` };
    const whisperModel = modelIds.find((id) => /whisper/i.test(id));
    if (whisperModel !== undefined) {
      next.model = whisperModel;
    }
    stt.setForm({ config: next });
  }

  return (
    <div data-testid="stt-local-server-panel" className="flex flex-col gap-4">
      {/* Setup help accordion — disclosure block mirroring TtsLocalServerPanel. */}
      <div className="overflow-hidden rounded-lg border border-border2" data-testid="stt-setup-help-accordion">
        <div
          className={cn(
            "flex w-full items-center justify-between bg-s2 px-3 py-3 font-ui text-[13px] font-medium text-t1 transition-colors hover:bg-[var(--border)] cursor-pointer",
            helpOpen && "!rounded-b-none",
          )}
        >
          <span className="flex items-center gap-2" onClick={() => setHelpOpen(!helpOpen)} data-testid="stt-setup-help-toggle">
            <span className={cn("transition-transform", helpOpen && "rotate-90")}>
              <Icons.Caret direction="r" />
            </span>
            {t("stt_local_setup_help")}
          </span>
        </div>

        <AnimatedDisclosure open={helpOpen} className="border-t border-border2 bg-surface p-4" data-testid="stt-setup-help-body">
          <div className="flex flex-col gap-3">
            <div className="font-ui text-[11px] text-t4">{t("stt_local_help_hint")}</div>

            {/* Step 1 — choose the server. */}
            <div data-testid="stt-help-step-choose" className="flex flex-col gap-1.5">
              <label className={lblCls}>{t("stt_local_step_choose")}</label>
              {STT_SERVER_GUIDES.map((guide) => {
                const selected = guide.id === guideId;
                return (
                  <button
                    type="button"
                    key={guide.id}
                    data-testid={`stt-help-choice-${guide.id}`}
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
            <div data-testid="stt-help-os-toggle" className="flex items-center justify-between gap-2">
              <span className={lblCls}>{t("stt_local_os_label")}</span>
              <SegmentedControl<SttOsKind>
                compact
                value={os}
                options={[
                  { value: "windows", label: t("stt_local_os_windows") },
                  { value: "unix", label: t("stt_local_os_unix") },
                ]}
                onChange={setOs}
              />
            </div>

            <div data-testid="stt-help-terminal-hint" className="font-ui text-[11px] text-t4">
              {t("stt_local_terminal_hint")}
            </div>

            {(() => {
              const guide = STT_SERVER_GUIDES.find((g) => g.id === guideId) ?? STT_SERVER_GUIDES[0];
              const step = (id: string, s: SttHelpStep) => (
                <div key={id} data-testid={`stt-help-step-${id}`} className="flex flex-col gap-1.5">
                  <label className={lblCls}>{t(s.titleKey)}</label>
                  {s.commands[os].map((command, index) => {
                    const copyId = `${guide.id}-${id}-${index}`;
                    return (
                      <div key={index} className="flex items-center gap-2">
                        <div className={`${monoUICls} min-w-0 flex-1 whitespace-pre-wrap break-all px-2 py-1.5 text-[11px]`}>
                          {command}
                        </div>
                        <button
                          type="button"
                          data-testid={`stt-help-copy-${copyId}`}
                          className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
                          onClick={() => void handleCopy(copyId, command)}
                        >
                          <Icons.Copy />
                          {copiedId === copyId ? t("stt_local_copied") : t("stt_local_copy")}
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
                  {step("download-docker", guide.docker)}
                  {step("download-clone", guide.clone)}
                  {step("install", guide.install)}
                  {step("run", guide.run)}
                  {/* Endpoint to paste (adopt flow preserved). */}
                  <div data-testid="stt-help-step-endpoint" className="flex flex-col gap-1.5">
                    <label className={lblCls}>{t("stt_local_step_endpoint")}</label>
                    <div className="flex items-center gap-2">
                      <div className={`${monoUICls} min-w-0 flex-1 whitespace-pre-wrap break-all px-2 py-1.5 text-[11px] text-t3`}>
                        {guide.endpoint}
                      </div>
                      <button
                        type="button"
                        data-testid={`stt-help-use-${guide.id}`}
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 font-ui text-[11px] text-white transition-colors hover:bg-accent/90"
                        onClick={() => updateConfigField(stt, form, "endpoint", guide.endpoint)}
                      >
                        {t("stt_local_adopt")}
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

      {/* Local-server scan. */}
      <div className="flex flex-col gap-2">
        <label className={lblCls}>{t("stt_local_section")}</label>
        <button
          type="button"
          data-testid="stt-local-scan"
          disabled={discovery.scanning}
          className="flex w-fit cursor-pointer items-center gap-1.5 rounded border border-s3 px-3 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
          onClick={() => void discovery.discover()}
        >
          {discovery.scanning ? t("stt_local_scanning") : t("stt_local_scan_btn")}
        </button>

        {discovery.error !== null && (
          <div data-testid="stt-discover-error" className="font-ui text-[12px] text-danger">
            {discovery.error}
          </div>
        )}

        {!discovery.scanning && discovery.error === null && discovery.servers.length === 0 && discovery.notFoundCodes !== null && (
          <>
            <div data-testid="stt-discover-none" className="font-ui text-[12px] text-t3">
              {t("stt_local_none")}
            </div>
            {diagKey !== null && (
              <div data-testid="stt-discover-diag" className="font-ui text-[11px] text-t3">
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
                  data-testid={`stt-discover-result-${server.port}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-s1 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-[11px] text-t3">{server.baseUrl}</span>
                    {server.modelIds.length > 0 && (
                      <span className="truncate font-ui text-[11px] text-t4">
                        {server.modelIds.slice(0, 3).join(", ")}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    data-testid={`stt-discover-adopt-${server.port}`}
                    disabled={isAdopted}
                    className={
                      isAdopted
                        ? "flex cursor-default items-center gap-1 rounded bg-accent/20 px-2 py-1 font-ui text-[11px] text-accent"
                        : "flex cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 font-ui text-[11px] text-white transition-colors hover:bg-accent/90"
                    }
                    onClick={() => adoptServer(server.baseUrl, server.modelIds)}
                  >
                    {isAdopted && <Icons.Check />}
                    {t("stt_local_adopt")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* whisper.cpp exclusion — plain-language note (ST-8). */}
      <div data-testid="stt-local-whisper-cpp-note" className="rounded-md border border-border bg-s1 px-3 py-2 font-ui text-[11px] text-t3">
        {t("stt_local_whisper_cpp_note")}
      </div>
    </div>
  );
}
