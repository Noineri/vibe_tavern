import { useT } from "../../../i18n/context.js";
import { ApiRefCard, ApiRefCode, ApiRefRow, ApiRefSection } from "./api-reference-parts.js";

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
 * Layout renders through the shared api-reference-parts.tsx (the card /
 * section / row / code-block pieces this file used to hand-copy). Unlike the
 * script sibling (legacy tDynamic fallbacks), every key here is strict — a
 * missing key is a compile error.
 */
export function InteractiveApiReference() {
  const { t } = useT();

  return (
    <ApiRefCard title={t("experience_api_title")}>
      {/* 1. Registration contract */}
      <ApiRefSection heading={t("experience_api_registration")}>
        <ApiRefRow code="context.experience.register(def)">— {t("experience_api_registration_desc")}</ApiRefRow>
        <ApiRefCode>{`context.experience.register({
  apiVersion: 1,
  manifest: { id: "my_game", name: "My Game" },
  capabilities: [
    { capability: "participants", reason: "per-player turns" }
  ],
  create(context) { return initialState; },
  project(context) { return viewForViewer; },
  actions(context) { return legalActions; },
  reduce(context, action) { return transition; }
})`}</ApiRefCode>
      </ApiRefSection>

      {/* 2. Mandatory methods */}
      <ApiRefSection heading={t("experience_api_methods")}>
        <ApiRefRow code="create(context)">— {t("experience_api_create_desc")}</ApiRefRow>
        <ApiRefRow code="project(context)">— {t("experience_api_project_desc")}</ApiRefRow>
        <ApiRefRow code="actions(context)">— {t("experience_api_actions_desc")}</ApiRefRow>
        <ApiRefRow code="reduce(context, action)">— {t("experience_api_reduce_desc")}</ApiRefRow>
        <ApiRefCode>{`return {
  state: nextState,       // plain bounded JSON
  status: "active",       // "active" | "completed"
  events: [...],          // see section 5
  effects: [...]          // optional — see section 5
};`}</ApiRefCode>
      </ApiRefSection>

      {/* 3. Optional methods */}
      <ApiRefSection heading={t("experience_api_optional")}>
        <ApiRefRow code="choose(context, legal)">— {t("experience_api_choose_desc")}</ApiRefRow>
        <ApiRefRow code="flavor(context)">— {t("experience_api_flavor_desc")}</ApiRefRow>
      </ApiRefSection>

      {/* 4. Manifest, capabilities, setup */}
      <ApiRefSection heading={t("experience_api_manifest")}>
        <ApiRefRow code="capabilities: […]">— {t("experience_api_capabilities_desc")}</ApiRefRow>
        <ApiRefRow code={'setup: { fields: […] }'}>— {t("experience_api_setup_desc")}</ApiRefRow>
      </ApiRefSection>

      {/* 5. Events and effects */}
      <ApiRefSection heading={t("experience_api_events")}>
        <ApiRefRow code="{ visibility, type, detail? }">— {t("experience_api_events_desc")}</ApiRefRow>
        <ApiRefRow code={'{ kind: "model", request }'}>— {t("experience_api_effects_desc")}</ApiRefRow>
      </ApiRefSection>

      {/* Sandbox bounds */}
      <div className="rounded border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[10px] leading-[1.4] text-t3">
        {t("experience_api_bounds")}
      </div>
    </ApiRefCard>
  );
}
