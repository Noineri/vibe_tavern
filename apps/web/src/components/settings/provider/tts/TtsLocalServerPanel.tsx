import { useState } from "react";

import { TTS_BACKEND } from "@vibe-tavern/domain";
import { useT } from "../../../../i18n/context.js";
import { copyText } from "../../../../lib/clipboard.js";
import { lblCls, monoUICls } from "../../../build/fields/field-styles.js";
import { Ic } from "../../../shared/icons.js";
import { LOCAL_TTS_QUICKSTARTS, diagnosticI18nKey, worstDiagnostic } from "../../../../lib/tts/quickstarts.js";
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

  async function handleCopy(quickstartId: string, command: string): Promise<void> {
    setCopyError(null);
    const result = await copyText(command);
    if (result.ok) {
      setCopiedId(quickstartId);
      window.setTimeout(() => setCopiedId((current) => (current === quickstartId ? null : current)), 1500);
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

      <div className="flex flex-col gap-2">
        <label className={lblCls}>{t("tts_quickstart_section")}</label>
        <div className="font-ui text-[11px] text-t4">{t("tts_quickstart_hint")}</div>
        {LOCAL_TTS_QUICKSTARTS.map((quickstart) => (
          <div
            key={quickstart.id}
            data-testid={`tts-quickstart-card-${quickstart.id}`}
            className="flex flex-col gap-1.5 rounded-md border border-border bg-s1 px-3 py-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-ui text-[12px] font-medium text-t1">{quickstart.name}</span>
              <span className="font-ui text-[11px] text-t3">
                127.0.0.1:{quickstart.port} · {t("tts_quickstart_port")} {quickstart.port}
              </span>
            </div>
            <div className={`${monoUICls} overflow-x-auto whitespace-nowrap px-2 py-1.5 text-[11px]`}>
              {quickstart.command}
            </div>
            {/* Non-docker variant (D8) — always shown; the prerequisite note
                keeps it honest about what the command needs. */}
            <div className={`${monoUICls} overflow-x-auto whitespace-nowrap px-2 py-1.5 text-[11px] text-t3`}>
              {quickstart.alt.command}
            </div>
            <div className="font-ui text-[11px] text-t4">{t(quickstart.alt.noteKey)}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`tts-quickstart-copy-${quickstart.id}`}
                className="flex cursor-pointer items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
                onClick={() => void handleCopy(quickstart.id, quickstart.command)}
              >
                <Ic.copy />
                {copiedId === quickstart.id ? t("tts_quickstart_copied") : t("tts_quickstart_copy")}
              </button>
              <button
                type="button"
                data-testid={`tts-quickstart-copy-alt-${quickstart.id}`}
                className="flex cursor-pointer items-center gap-1 rounded border border-s3 px-2 py-1 font-ui text-[11px] text-t2 transition-colors hover:bg-s2 hover:text-t1"
                onClick={() => void handleCopy(`${quickstart.id}-alt`, quickstart.alt.command)}
              >
                <Ic.copy />
                {t("tts_quickstart_copy_alt")}
              </button>
              <button
                type="button"
                data-testid={`tts-quickstart-use-${quickstart.id}`}
                className="flex cursor-pointer items-center gap-1 rounded bg-accent px-2 py-1 font-ui text-[11px] text-white transition-colors hover:bg-accent/90"
                onClick={() => setEndpoint(quickstart.endpoint)}
              >
                {t("tts_discover_adopt")}
              </button>
            </div>
          </div>
        ))}
        {copyError !== null && (
          <div className="font-ui text-[11px] text-danger">{copyError}</div>
        )}
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
                    {isAdopted && <Ic.check />}
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
