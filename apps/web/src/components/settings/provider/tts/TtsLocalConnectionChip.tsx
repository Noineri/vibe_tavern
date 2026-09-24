import { useCallback, useEffect, useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { listTtsDraftModels } from "../../../../api/tts-api.js";
import { LocalConnectionStatusChip, type LocalConnectionStatus } from "../../../shared/LocalConnectionStatus.js";
import { useDockerStatus } from "./use-docker-status.js";
import { configString, formDraftConfig } from "./tts-form-helpers.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

type TtsHook = ReturnType<typeof useTtsProfiles>;

/** The TTS local-connection chip, rendered OUTSIDE the provider card (owner
 *  ruling 2026-09-22: not inside the card and not only at first connection
 *  — LLM parity; verbatim quote in
 *  reports/LEGACY_CYRILLIC_CLEANUP_REPORT.md ledger): the chip sits between
 *  the card and the level-2 sections in BOTH header modes, so a SAVED local
 *  profile shows its server state too, not just the first-connection form).
 *
 *  Ping (IG-CF12d, owner: the ping must be honest — the green state means
 *  the SERVER answers, not merely that docker exists): the draft-models
 *  route — the same call the Test-connection button makes (the model list IS
 *  the reachability proof). One mount probe + the re-check button; an empty
 *  endpoint draws no conclusion. The button is labeled with refresh_models,
 *  like the LLM chip (the models route IS the probe on both sides). The
 *  docker probe (D8, one-shot on mount, no retries) rides the detail line.
 *  The caller owns the local-segment/backend gating — the chip itself is
 *  unconditional. */
export function TtsLocalConnectionChip({ form }: { form: NonNullable<TtsHook["form"]> }) {
  const { t } = useT();
  const docker = useDockerStatus();
  const [pingStatus, setPingStatus] = useState<LocalConnectionStatus>("unknown");
  const pingServer = useCallback(async () => {
    if (configString(form.config, "endpoint").trim() === "") {
      setPingStatus("unknown");
      return;
    }
    setPingStatus("checking");
    try {
      await listTtsDraftModels({ backend: form.backend, config: formDraftConfig(form), profileId: form.id ?? undefined });
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

  return (
    <LocalConnectionStatusChip
      testId="tts-docker-status"
      status={pingStatus}
      endpoint={configString(form.config, "endpoint")}
      onRefresh={() => void pingServer()}
      refreshing={pingStatus === "checking"}
      refreshLabel={t("refresh_models")}
      detail={
        docker.error !== null
          ? t("tts_docker_status_unknown")
          : docker.status === null
            ? t("tts_docker_status_probing")
            : docker.status.available
              ? t("tts_docker_status_ok", { version: docker.status.version ?? "" })
              : t("tts_docker_status_missing")
      }
    />
  );
}
