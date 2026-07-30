import { useT } from "../../../i18n/context.js";
import type { ScriptKind } from "@vibe-tavern/domain";

export function ScriptApiReference({ kind }: { kind: ScriptKind }) {
  const { t, tDynamic } = useT();

  if (kind === "dice") {
    return (
      <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
        <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {tDynamic("script_api_dice_title") || "Dice Script API"}
        </div>
        <div className="grid gap-3 text-[12px]">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
              {tDynamic("script_api_dice_registration") || "1. Register a check"}
            </div>
            <div className="grid gap-1">
              <div className="flex items-center gap-2 leading-[1.5]">
                <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.dice.register(def)</code>
                <span className="text-t3">— {tDynamic("script_api_dice_register_desc") || "Declare one check at discovery time. Called once per check; never inside resolve()."}</span>
              </div>
              <pre className="mt-1 rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{`context.dice.register({
  id: "str_check",          // stable unique id
  label: "Strength Check",  // shown in the tray
  notation: "1d20+3",       // dice grammar — also the roll source
  actors: ["persona", "character"], // who may roll
  resolution: "strict",     // "strict" | "narrative"
  help: "Roll 1d20+3 vs difficulty.", // optional, shown in the tray
  resolve: function () { /* see below */ }
})`}</pre>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
              {tDynamic("script_api_dice_context") || "2. Frozen roll context (inside resolve)"}
            </div>
            <div className="grid gap-1">
              <div className="flex items-center gap-2 leading-[1.5]">
                <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.dice.roll(notation)</code>
                <span className="text-t3">— {tDynamic("script_api_dice_roll_desc") || "The ONLY source of randomness. Returns { faces, modifier, subtotal, total }."}</span>
              </div>
              <div className="flex items-center gap-2 leading-[1.5]">
                <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.actor</code>
                <span className="text-t3">— {tDynamic("script_api_dice_actor_desc") || "Frozen snapshot of who is rolling: { actorType, actorId, actorLabel }."}</span>
              </div>
              <div className="flex items-center gap-2 leading-[1.5]">
                <code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.priorAttempts</code>
                <span className="text-t3">— {tDynamic("script_api_dice_prior_desc") || "Read-only array of earlier attempts in this envelope (Immersive retry grants read these)."}</span>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
              {tDynamic("script_api_dice_resolve") || "3. Return the result envelope"}
            </div>
            <div className="grid gap-1">
              <div className="flex items-center gap-2 leading-[1.5]">
                <span className="text-t3">— {tDynamic("script_api_dice_return_desc") || "resolve() takes NO argument; read everything via context.*. Return:"}</span>
              </div>
              <pre className="mt-1 rounded border border-border2 bg-bg px-2 py-1.5 font-mono text-[10px] leading-[1.4] text-t2">{`return {
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
};`}</pre>
              <div className="mt-1 rounded border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[10px] leading-[1.4] text-t3">
                {tDynamic("script_api_dice_warning") || "Do not call injectMessage, parse /roll, or use Math.random / Date.now — context.dice.roll is the only randomness channel."}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim/30" style={{ padding: 14 }}>
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{tDynamic("script_api_context") || "Scripting API"}</div>
      <div className="grid gap-3 text-[12px]">
        <div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.character.name</code><span className="text-t3">— {t("script_api_char_name")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.character.personality</code><span className="text-t3">— {t("script_api_char_personality")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.character.scenario</code><span className="text-t3">— {t("script_api_char_scenario")}</span></div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_state")}</div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.state.get(key, default)</code><span className="text-t3">— {t("script_api_state_get")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.state.set(key, value)</code><span className="text-t3">— {t("script_api_state_set")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.state.increment(key, n)</code><span className="text-t3">— {t("script_api_state_increment")}</span></div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_lore")}</div>
          <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.lore.activeEntries</code><span className="text-t3">— {t("script_api_lore_entries")}</span></div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_persona")}</div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.persona.name</code><span className="text-t3">— {t("script_api_persona_name")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.persona.description</code><span className="text-t3">— {t("script_api_persona_desc")}</span></div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_shared")}</div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.shared.get(key, default)</code><span className="text-t3">— {t("script_api_shared_get")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.shared.set(key, value)</code><span className="text-t3">— {t("script_api_shared_set")}</span></div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{t("script_api_random")}</div>
          <div className="grid gap-1">
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.random()</code><span className="text-t3">— {t("script_api_random_fn")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.randomInt(min, max)</code><span className="text-t3">— {t("script_api_randomInt")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.pick(arr)</code><span className="text-t3">— {t("script_api_pick")}</span></div>
            <div className="flex items-center gap-2 leading-[1.5]"><code className="shrink-0 rounded bg-bg px-1.5 py-px font-mono text-[11px] leading-[1.4] text-accent-t">context.weightedPick(items)</code><span className="text-t3">— {t("script_api_weightedPick")}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
