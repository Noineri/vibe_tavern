import { useT } from "../../../i18n/context.js";
import type { ScriptKind } from "@vibe-tavern/domain";
import { ApiRefCard, ApiRefCode, ApiRefRow, ApiRefSection } from "./api-reference-parts.js";

export function ScriptApiReference({ kind }: { kind: ScriptKind }) {
  const { t, tDynamic } = useT();

  if (kind === "dice") {
    return (
      <ApiRefCard title={tDynamic("script_api_dice_title") || "Dice Script API"}>
        <ApiRefSection heading={tDynamic("script_api_dice_registration") || "1. Register a check"}>
          <ApiRefRow code="context.dice.register(def)">— {tDynamic("script_api_dice_register_desc") || "Declare one check at discovery time. Called once per check; never inside resolve()."}</ApiRefRow>
          <ApiRefCode>{`context.dice.register({
  id: "str_check",          // stable unique id
  label: "Strength Check",  // shown in the tray
  notation: "1d20+3",       // dice grammar — also the roll source
  actors: ["persona", "character"], // who may roll
  resolution: "strict",     // "strict" | "narrative"
  help: "Roll 1d20+3 vs difficulty.", // optional, shown in the tray
  resolve: function () { /* see below */ }
})`}</ApiRefCode>
        </ApiRefSection>

        <ApiRefSection heading={tDynamic("script_api_dice_context") || "2. Frozen roll context (inside resolve)"}>
          <ApiRefRow code="context.dice.roll(notation)">— {tDynamic("script_api_dice_roll_desc") || "The ONLY source of randomness. Returns { faces, modifier, subtotal, total }."}</ApiRefRow>
          <ApiRefRow code="context.actor">— {tDynamic("script_api_dice_actor_desc") || "Frozen snapshot of who is rolling: { actorType, actorId, actorLabel }."}</ApiRefRow>
          <ApiRefRow code="context.priorAttempts">— {tDynamic("script_api_dice_prior_desc") || "Read-only array of earlier attempts in this envelope (Immersive retry grants read these)."}</ApiRefRow>
        </ApiRefSection>

        <ApiRefSection heading={tDynamic("script_api_dice_resolve") || "3. Return the result envelope"}>
          <ApiRefRow>— {tDynamic("script_api_dice_return_desc") || "resolve() takes NO argument; read everything via context.*. Return:"}</ApiRefRow>
          <ApiRefCode>{`return {
  faces: r.faces,        // [number, ...] per-die values
  modifier: r.modifier,  // numeric modifier
  subtotal: r.subtotal,  // sum of faces
  total: r.total,        // subtotal + modifier
  final: {               // optional; binding result for "strict"
    total: r.total,
    outcome: "success",  // short label
    degree: "+2",        // optional degree string
    constraint: "..."    // optional narrative constraint
  }
};`}</ApiRefCode>
          <div className="mt-1 rounded border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[10px] leading-[1.4] text-t3">
            {tDynamic("script_api_dice_warning") || "Do not call injectMessage, parse /roll, or use Math.random / Date.now — context.dice.roll is the only randomness channel."}
          </div>
        </ApiRefSection>
      </ApiRefCard>
    );
  }

  return (
    <ApiRefCard title={tDynamic("script_api_context") || "Scripting API"}>
      <ApiRefSection>
        <ApiRefRow code="context.character.name">— {t("script_api_char_name")}</ApiRefRow>
        <ApiRefRow code="context.character.personality">— {t("script_api_char_personality")}</ApiRefRow>
        <ApiRefRow code="context.character.scenario">— {t("script_api_char_scenario")}</ApiRefRow>
      </ApiRefSection>
      <ApiRefSection heading={t("script_api_state")}>
        <ApiRefRow code="context.state.get(key, default)">— {t("script_api_state_get")}</ApiRefRow>
        <ApiRefRow code="context.state.set(key, value)">— {t("script_api_state_set")}</ApiRefRow>
        <ApiRefRow code="context.state.increment(key, n)">— {t("script_api_state_increment")}</ApiRefRow>
      </ApiRefSection>
      <ApiRefSection heading={t("script_api_lore")}>
        <ApiRefRow code="context.lore.activeEntries">— {t("script_api_lore_entries")}</ApiRefRow>
      </ApiRefSection>
      <ApiRefSection heading={t("script_api_persona")}>
        <ApiRefRow code="context.persona.name">— {t("script_api_persona_name")}</ApiRefRow>
        <ApiRefRow code="context.persona.description">— {t("script_api_persona_desc")}</ApiRefRow>
      </ApiRefSection>
      <ApiRefSection heading={t("script_api_shared")}>
        <ApiRefRow code="context.shared.get(key, default)">— {t("script_api_shared_get")}</ApiRefRow>
        <ApiRefRow code="context.shared.set(key, value)">— {t("script_api_shared_set")}</ApiRefRow>
      </ApiRefSection>
      <ApiRefSection heading={t("script_api_random")}>
        <div className="mb-1.5 text-[11px] leading-[1.5] text-t3">{t("script_api_random_hint")}</div>
        <ApiRefRow code="context.random()">— {t("script_api_random_fn")}</ApiRefRow>
        <ApiRefRow code="context.randomInt(min, max)">— {t("script_api_randomInt")}</ApiRefRow>
        <ApiRefRow code="context.pick(arr)">— {t("script_api_pick")}</ApiRefRow>
        <ApiRefRow code="context.weightedPick(items)">— {t("script_api_weightedPick")}</ApiRefRow>
      </ApiRefSection>
    </ApiRefCard>
  );
}
