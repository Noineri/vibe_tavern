/**
 * fork #1 of tts/TtsLocalConnectionChip.tsx.
 */

import { useCallback, useEffect, useState } from "react";

import { useT } from "../../../../i18n/context.js";
import { listSttDraftModels } from "../../../../api/stt-api.js";
import { LocalConnectionStatusChip, type LocalConnectionStatus } from "../../../shared/LocalConnectionStatus.js";
import { configString, formDraftConfig } from "./stt-form-helpers.js";
import type { SttProfileForm } from "./use-stt-profiles.js";

/** The STT local-connection chip, rendered OUTSIDE the provider card (owner
 *  ruling 2026-09-22: not inside the card and not only at first connection
 *  — LLM parity; verbatim quote in
 *  reports/LEGACY_CYRILLIC_CLEANUP_REPORT.md ledger): the chip sits between
 *  the card and the level-2 sections in BOTH header modes, so a SAVED local
 *  profile shows its server state too, not just the first-connection form).
 *
 *  Ping (IG-CF12d, owner: the ping must be honest): the CONFIGURED
 *  ENDPOINT's reachability via the draft-models route — the compat row
 *  lists its model catalog; whisper.cpp has no catalog, and the route falls
 *  back to the backend probe (SPE-7: green on a healthy server, red on a
 *  dead one). One mount probe + the re-check button; an empty endpoint
 *  draws no conclusion. The button is labeled with refresh_models, like
 *  the LLM chip (the models route IS the probe on both sides). The caller
 *  owns the local-segment/backend gating — the chip itself is unconditional. */
export function SttLocalConnectionChip({ form }: { form: SttProfileForm }) {
  const { t } = useT();
  const [pingStatus, setPingStatus] = useState<LocalConnectionStatus>("unknown");
  const pingServer = useCallback(async () => {
    if (configString(form.config, "endpoint").trim() === "") {
      setPingStatus("unknown");
      return;
    }
    setPingStatus("checking");
    try {
      await listSttDraftModels({ backend: form.backend, config: formDraftConfig(form), profileId: form.id ?? undefined });
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
      testId="stt-local-status"
      status={pingStatus}
      endpoint={configString(form.config, "endpoint")}
      onRefresh={() => void pingServer()}
      refreshing={pingStatus === "checking"}
      refreshLabel={t("refresh_models")}
    />
  );
}
