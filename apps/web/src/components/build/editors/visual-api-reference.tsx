import { useT } from "../../../i18n/context.js";
import { ApiRefCard, ApiRefCode, ApiRefRow, ApiRefSection } from "./api-reference-parts.js";

/**
 * Visual API reference (user-facing — the visual author's contract, mirroring
 * `InteractiveApiReference` for rules). Documents the HOST BRIDGE a visual runs
 * against inside the experience iframe: the single `window.VibeExperience`
 * global, the projected `view` shape, the `experience` handle methods
 * (act/resize/finish/session), the `connect` option callbacks, and the sandbox
 * bounds (allow-scripts, no same-origin → no network/storage/modules).
 *
 * The contract itself is the source of truth in the asset
 * `services/api/assets/interactive-visual.md` (which the copilot already reads
 * into its system prompt); this component is the static, strict-t() human
 * reference — layout renders through the shared api-reference-parts.tsx.
 */
export function VisualApiReference() {
  const { t } = useT();

  return (
    <ApiRefCard title={t("experience_visual_api_title")}>
      {/* 1. Connection */}
      <ApiRefSection heading={t("experience_visual_api_connect_title")}>
        <ApiRefRow code="window.VibeExperience.connect(onView, opts?)">— {t("experience_visual_api_connect_desc")}</ApiRefRow>
        <ApiRefCode>{`var xp = window.VibeExperience.connect(render);`}</ApiRefCode>
      </ApiRefSection>

      {/* 2. onView / projected view */}
      <ApiRefSection heading={t("experience_visual_api_onview_title")}>
        <ApiRefRow code="onView(view, meta)">— {t("experience_visual_api_onview_desc")}</ApiRefRow>
        <ApiRefCode>{`{
  state:    <plain JSON the rules' project() returned>,
  actions:  [ { type, participantId?, label?, payloadSchema?, allowsText? } ],
  flavor?:  <cosmetic JSON, present only when rules declare flavor()>,
  revision: <integer, monotonically increasing>,
  status:   "active" | "completed"
}`}</ApiRefCode>
      </ApiRefSection>

      {/* 3. Handle methods */}
      <ApiRefSection heading={t("experience_visual_api_methods_title")}>
        <ApiRefRow code="xp.act(type, payload?, opts?)">— {t("experience_visual_api_act_desc")}</ApiRefRow>
        <ApiRefRow code="xp.resize(width, height)">— {t("experience_visual_api_resize_desc")}</ApiRefRow>
        <ApiRefRow code="xp.finish()">— {t("experience_visual_api_finish_desc")}</ApiRefRow>
        <ApiRefRow code="xp.session">— {t("experience_visual_api_session_desc")}</ApiRefRow>
      </ApiRefSection>

      {/* 4. connect options */}
      <ApiRefSection heading={t("experience_visual_api_callbacks_title")}>
        <ApiRefRow code="onReady(sessionMeta)">— {t("experience_visual_api_onready_desc")}</ApiRefRow>
        <ApiRefRow code="onPending(phase)">— {t("experience_visual_api_onpending_desc")}</ApiRefRow>
        <ApiRefRow code="onError(err)">— {t("experience_visual_api_onerror_desc")}</ApiRefRow>
        <ApiRefRow code="onLifecycle(event)">— {t("experience_visual_api_onlifecycle_desc")}</ApiRefRow>
      </ApiRefSection>

      {/* Sandbox bounds */}
      <div className="rounded border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[10px] leading-[1.4] text-t3">
        {t("experience_visual_api_bounds")}
      </div>
    </ApiRefCard>
  );
}
