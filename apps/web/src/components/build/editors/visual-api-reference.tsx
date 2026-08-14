import { useT } from "../../../i18n/context.js";

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
 * reference — the same documentation form as `InteractiveApiReference` (accented
 * container, numbered sections, `code` chip + description rows, literal `pre`
 * samples).
 */
export function VisualApiReference() {
  const { t } = useT();

  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
        {t("experience_visual_api_title")}
      </div>
      <div className="grid gap-3 text-[12px]">
        {/* 1. Connection */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_visual_api_connect_title")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">window.VibeExperience.connect(onView, opts?)</code>
              <span className="text-t3">— {t("experience_visual_api_connect_desc")}</span>
            </div>
            <pre className="mt-1 rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{`var xp = window.VibeExperience.connect(render);`}</pre>
          </div>
        </div>

        {/* 2. onView / projected view */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_visual_api_onview_title")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">onView(view, meta)</code>
              <span className="text-t3">— {t("experience_visual_api_onview_desc")}</span>
            </div>
            <pre className="mt-1 rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{`{
  state:    <plain JSON the rules' project() returned>,
  actions:  [ { type, participantId?, label?, payloadSchema?, allowsText? } ],
  flavor?:  <cosmetic JSON, present only when rules declare flavor()>,
  revision: <integer, monotonically increasing>,
  status:   "active" | "completed"
}`}</pre>
          </div>
        </div>

        {/* 3. Handle methods */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_visual_api_methods_title")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">xp.act(type, payload?, opts?)</code>
              <span className="text-t3">— {t("experience_visual_api_act_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">xp.resize(width, height)</code>
              <span className="text-t3">— {t("experience_visual_api_resize_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">xp.finish()</code>
              <span className="text-t3">— {t("experience_visual_api_finish_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">xp.session</code>
              <span className="text-t3">— {t("experience_visual_api_session_desc")}</span>
            </div>
          </div>
        </div>

        {/* 4. connect options */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_visual_api_callbacks_title")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">onReady(sessionMeta)</code>
              <span className="text-t3">— {t("experience_visual_api_onready_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">onPending(phase)</code>
              <span className="text-t3">— {t("experience_visual_api_onpending_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">onError(err)</code>
              <span className="text-t3">— {t("experience_visual_api_onerror_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">onLifecycle(event)</code>
              <span className="text-t3">— {t("experience_visual_api_onlifecycle_desc")}</span>
            </div>
          </div>
        </div>

        {/* Sandbox bounds */}
        <div className="rounded border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[10px] leading-[1.4] text-t3">
          {t("experience_visual_api_bounds")}
        </div>
      </div>
    </div>
  );
}
