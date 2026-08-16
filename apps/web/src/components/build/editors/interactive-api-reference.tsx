import { useT } from "../../../i18n/context.js";

/**
 * Interactive Rules API reference (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8
 * / IR-81C). The package authoring surface an author reads without leaving the
 * Experience editor: the registration contract (apiVersion, manifest,
 * capabilities, setup descriptor), the four mandatory methods
 * (create/project/actions/reduce), the optional choose/flavor, and the
 * event/effect envelopes + sandbox bounds.
 *
 * Documentation only — it renders static, strict-t() copy with literal code
 * samples. It documents the PUBLIC contract the IR-12 sandbox discovers
 * (`context.experience.register({…})`), nothing application-internal. The
 * runtime diagnostic that validates a source against this contract lives in
 * the playground's developer-diagnostics accordion (XU-4; formerly the
 * standalone InteractiveTester, IR-81D).
 *
 * Mirrors the layout of ScriptApiReference (script-api-reference.tsx): one
 * accented container, numbered sections, `code` chip + description rows, and
 * literal `pre` samples. Unlike that sibling (legacy tDynamic fallbacks),
 * every key here is strict — a missing key is a compile error.
 */
export function InteractiveApiReference() {
  const { t } = useT();

  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
        {t("experience_api_title")}
      </div>
      <div className="grid gap-3 text-[12px]">
        {/* 1. Registration contract */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_api_registration")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.experience.register(def)</code>
              <span className="text-t3">— {t("experience_api_registration_desc")}</span>
            </div>
            <pre className="mt-1 rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{`context.experience.register({
  apiVersion: 1,
  manifest: { id: "my_game", name: "My Game" },
  capabilities: [
    { capability: "participants", reason: "per-player turns" }
  ],
  create(context) { return initialState; },
  project(context) { return viewForViewer; },
  actions(context) { return legalActions; },
  reduce(context, action) { return transition; }
})`}</pre>
          </div>
        </div>

        {/* 2. Mandatory methods */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_api_methods")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">create(context)</code>
              <span className="text-t3">— {t("experience_api_create_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">project(context)</code>
              <span className="text-t3">— {t("experience_api_project_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">actions(context)</code>
              <span className="text-t3">— {t("experience_api_actions_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">reduce(context, action)</code>
              <span className="text-t3">— {t("experience_api_reduce_desc")}</span>
            </div>
            <pre className="mt-1 rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{`return {
  state: nextState,       // plain bounded JSON
  status: "active",       // "active" | "completed"
  events: [...],          // see section 5
  effects: [...]          // optional — see section 5
};`}</pre>
          </div>
        </div>

        {/* 3. Optional methods */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_api_optional")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">choose(context, legal)</code>
              <span className="text-t3">— {t("experience_api_choose_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">flavor(context)</code>
              <span className="text-t3">— {t("experience_api_flavor_desc")}</span>
            </div>
          </div>
        </div>

        {/* 4. Manifest, capabilities, setup */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_api_manifest")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">capabilities: […]</code>
              <span className="text-t3">— {t("experience_api_capabilities_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">setup: {"{ fields: […] }"}</code>
              <span className="text-t3">— {t("experience_api_setup_desc")}</span>
            </div>
          </div>
        </div>

        {/* 5. Events and effects */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
            {t("experience_api_events")}
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">{"{ visibility, type, detail? }"}</code>
              <span className="text-t3">— {t("experience_api_events_desc")}</span>
            </div>
            <div className="flex items-center gap-2 leading-[1.5]">
              <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">{"{ kind: \"model\", request }"}</code>
              <span className="text-t3">— {t("experience_api_effects_desc")}</span>
            </div>
          </div>
        </div>

        {/* Sandbox bounds */}
        <div className="rounded border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[10px] leading-[1.4] text-t3">
          {t("experience_api_bounds")}
        </div>
      </div>
    </div>
  );
}
