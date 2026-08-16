/**
 * DiceAssignment — chat-local Dice script assignment (DICE_ASSIGNMENT_AND_TRAY_UX_REPORT).
 *
 * Unified-editor model (supersedes the override/inherit two-mode UI — the user
 * rejected "Override for this chat" / "Use inherited" as internal mechanics
 * leaking into UX):
 *
 *  - ONE list, always: each effective rule is a row with the script name, a
 *    muted provenance note, the per-script actor chips (Persona/Character),
 *    and a remove button. No modes, no mode verbs, no separate "Rolls for"
 *    block (the chips live in the row).
 *  - Any add/remove silently snapshots the current effective ids into
 *    `insightsConfig.diceScriptIds` — the chat's set becomes local on the
 *    FIRST edit, without the user ever naming that transition. Until then
 *    (`diceScriptIds == null`) the set stays live and follows the resolver's
 *    automatic union (global / character / persona / chat links).
 *  - `Reset to automatic` appears ONLY while the chat has a local set; it
 *    patches `diceScriptIds = null`. It is a reset, not a mode switch. Actor
 *    bindings are NOT cleared by it — they are a separate chat-local config
 *    and still apply to whichever scripts remain effective.
 *  - Actor chips are ALWAYS editable (inherit or local): toggling writes only
 *    `diceActorBindings` and never freezes the set. Defaults mirror the
 *    script's declared `check.actors`; the user may add or remove either
 *    actor (full freedom), but never drop below one.
 *  - `Create new Dice script` is ALWAYS visible (zero scripts or many) and
 *    opens the editor directly in blank dice-script creation via the existing
 *    `requestDiceCreate` intent — never the general Scripts list.
 *
 * Data model (unchanged): `diceScriptIds: null` = follow automatic union;
 * an array = this chat's frozen set. `diceActorBindings: Record<scriptId,
 * actors>` overrides each script's declared actors at roll resolution. The
 * list the user edits is the RESOLVED effective set (discovery output) —
 * broken/zero-check scripts are dropped by the resolver and simply do not
 * appear; a set write also normalizes away any such stale ids and prunes
 * bindings for scripts leaving the set.
 */
import { useEffect, useState } from "react";
import { DICE_ACTOR_TYPE, type ChatId, type DiceActorType } from "@vibe-tavern/domain";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { EmptyState } from "../../shared/empty-state.js";
import { LinkBindingPopover, type LinkTarget, type LinkBindingRecord } from "../../shared/LinkBindingPopover.js";
import { ToggleChips } from "../../shared/ToggleChips.js";
import { useT } from "../../../i18n/context.js";
import type { TFunc } from "../../../i18n/locale-helpers.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { useActiveCharacter, useActivePersona } from "../../../stores/snapshot-store.js";
import { useBuildNavigationStore } from "../../../stores/build-navigation-store.js";
import { useCharacterStore } from "../../../stores/character-store.js";
import { useNavigationStore } from "../../../stores/navigation-store.js";
import { getDiceDefinitions } from "../../../api/dice-api.js";
import { listAllScripts } from "../../../api/script-api.js";
import type { DiceDefinitionsResponse, ScriptRecord } from "../../../api/types.js";
import { Ic } from "../../shared/icons.js";

export interface DiceAssignmentProps {
  chatId: ChatId;
  diceMode: "normal" | "immersive";
  /** null/absent = follow automatic union (live set); array = frozen chat set. */
  diceScriptIds: string[] | null;
  /** Per-script actor distribution. null = each script uses its declared
   *  check.actors; a record overrides per script (full freedom). */
  diceActorBindings: Record<string, DiceActorType[]> | null;
  /** Partial PATCH through the Insights config pipe (round-trips the snapshot). */
  onPatch: (patch: { diceMode?: "normal" | "immersive"; diceScriptIds?: string[] | null; diceActorBindings?: Record<string, DiceActorType[]> | null }) => void;
  /** True while a PATCH is in flight — disables all interactive controls. */
  pending: boolean;
}

/** Provenance note for an effective dice script — where the script LIVES, so
 *  the user can tell why it is in this chat and what else it would affect. */
function provenanceLabel(
  t: TFunc,
  script: ScriptRecord | undefined,
  chatId: ChatId,
  activeCharacterId: string | null,
  activeCharacterName: string | null,
  activePersonaId: string | null,
  activePersonaName: string | null,
): string {
  if (!script) return t("insights_dice_prov_linked");
  switch (script.scopeType) {
    case "global":
      return t("insights_dice_prov_global");
    case "chat":
      return script.chatId === chatId ? t("insights_dice_prov_chat") : t("insights_dice_prov_linked");
    case "character":
      return script.characterId && script.characterId === activeCharacterId
        ? t("insights_dice_prov_character", { name: activeCharacterName ?? "" })
        : t("insights_dice_prov_linked");
    case "persona":
      return script.personaId && script.personaId === activePersonaId
        ? t("insights_dice_prov_persona", { name: activePersonaName ?? "" })
        : t("insights_dice_prov_linked");
    default:
      return t("insights_dice_prov_linked");
  }
}

export function DiceAssignment({ chatId, diceMode, diceScriptIds, diceActorBindings, onPatch, pending }: DiceAssignmentProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const character = useActiveCharacter();
  const persona = useActivePersona();

  const [allDiceScripts, setAllDiceScripts] = useState<ScriptRecord[] | null>(null);
  const [definitions, setDefinitions] = useState<DiceDefinitionsResponse | null>(null);

  // All dice-kind scripts (every scope) — source for the Add popover,
  // provenance lookup, and the "do any dice scripts exist at all" check.
  useEffect(() => {
    let cancelled = false;
    listAllScripts()
      .then((all) => {
        if (cancelled) return;
        setAllDiceScripts(all.filter((s) => s.scriptKind === "dice"));
      })
      .catch(() => { if (!cancelled) setAllDiceScripts([]); });
    return () => { cancelled = true; };
  }, []);

  // Effective working rules — runs the resolver; broken/zero-check scripts are
  // dropped, so this is the authoritative "what actually rolls" set.
  useEffect(() => {
    let cancelled = false;
    getDiceDefinitions(chatId)
      .then((def) => { if (!cancelled) setDefinitions(def); })
      .catch(() => { if (!cancelled) setDefinitions({ scripts: [] }); });
    return () => { cancelled = true; };
  }, [chatId, diceScriptIds]);

  const isLocalSet = Array.isArray(diceScriptIds);
  const scriptById = new Map((allDiceScripts ?? []).map((s) => [s.id, s]));
  const noScriptsExist = allDiceScripts != null && allDiceScripts.length === 0;
  const effective = definitions?.scripts ?? [];
  const displayedIds = effective.map((d) => d.scriptId);

  // The set the user edits = the resolved effective set. LinkBindingPopover
  // needs LinkBindingRecord[]; only the "script" target type is used here.
  const displayedLinks: LinkBindingRecord[] = displayedIds.map((id) => ({ targetType: "script", targetId: id }));
  const diceLinkTargets: LinkTarget[] = (allDiceScripts ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    avatarAssetId: null,
  }));

  function openDiceCreate(template?: "fate_die") {
    useBuildNavigationStore.getState().requestDiceCreate({
      scope: { type: "chat", id: chatId },
      ...(template ? { template } : {}),
    });
    useNavigationStore.getState().setMode("build");
    useCharacterStore.getState().setBuildTab("lorebook");
  }

  /** Write a new chat set (add/remove). This is the silent "snapshot": in
   *  inherit mode the first edit freezes the currently effective ids; in
   *  local mode it updates them. Bindings for scripts leaving the set are
   *  pruned in the same PATCH. */
  function setChatSet(nextIds: string[]) {
    const keep = new Set(nextIds);
    const prev = diceActorBindings ?? {};
    const pruned: Record<string, DiceActorType[]> = {};
    for (const [k, v] of Object.entries(prev)) {
      if (keep.has(k)) pruned[k] = v;
    }
    onPatch({
      diceScriptIds: nextIds,
      ...(Object.keys(pruned).length !== Object.keys(prev).length ? { diceActorBindings: pruned } : {}),
    });
  }

  /** Declared actor union for a script (from discovery). Falls back to both
   *  actors while definitions are loading or if the script declares none. */
  function declaredActorsForScript(scriptId: string): DiceActorType[] {
    const def = effective.find((s) => s.scriptId === scriptId);
    if (!def) return [DICE_ACTOR_TYPE.persona, DICE_ACTOR_TYPE.character];
    const union = new Set<DiceActorType>();
    for (const c of def.checks) for (const a of c.actors) union.add(a);
    return union.size > 0 ? [...union] : [DICE_ACTOR_TYPE.persona, DICE_ACTOR_TYPE.character];
  }
  /** Effective actor binding for a script: explicit override, else declared. */
  function effectiveBinding(scriptId: string): DiceActorType[] {
    return diceActorBindings?.[scriptId] ?? declaredActorsForScript(scriptId);
  }
  /** Persist a per-script actor distribution. NEVER touches diceScriptIds —
   *  tuning actors must not freeze a live (inherited) set. Entries for
   *  scripts no longer displayed are pruned on write. */
  function patchBinding(scriptId: string, actors: DiceActorType[]) {
    const keep = new Set(displayedIds);
    const next: Record<string, DiceActorType[]> = {};
    for (const [k, v] of Object.entries(diceActorBindings ?? {})) {
      if (keep.has(k)) next[k] = v;
    }
    next[scriptId] = actors;
    onPatch({ diceActorBindings: next });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-s2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-ui text-[13px] text-t3">
          {definitions == null ? "…" : t("insights_dice_active", { count: effective.length })}
        </span>
        <SegmentedControl
          value={diceMode}
          options={[
            { value: "normal", label: t("insights_dice_mode_normal"), tooltip: t("insights_dice_mode_normal_tip") },
            { value: "immersive", label: t("insights_dice_mode_immersive"), tooltip: t("insights_dice_mode_immersive_tip") },
          ]}
          onChange={(v) => onPatch({ diceMode: v as "normal" | "immersive" })}
          compact
          disabled={pending}
        />
      </div>

      {/* Zero dice scripts anywhere — Fate quick-start. Create is still always shown below. */}
      {noScriptsExist && (
        <EmptyState
          icon={<Ic.dice />}
          title={t("insights_dice_empty_title")}
          sub={t("insights_dice_empty_sub")}
          cta={t("insights_dice_empty_cta_fate")}
          onCta={() => openDiceCreate("fate_die")}
        />
      )}

      {/* Unified rule list — same in inherit and local mode. */}
      {!noScriptsExist && effective.length === 0 && definitions != null && (
        <p className="font-ui text-[12px] leading-relaxed text-t4">
          {t("insights_dice_none_effective")}
        </p>
      )}
      {!noScriptsExist && effective.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {effective.map((def) => {
            const prov = provenanceLabel(
              t, scriptById.get(def.scriptId), chatId,
              character?.id ?? null, character?.name ?? null,
              persona?.id ?? null, persona?.name ?? null,
            );
            return (
              <div
                key={def.scriptId}
                className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md bg-s2 px-2.5 py-1.5"
              >
                <span className="min-w-0 truncate font-ui text-[12px] font-medium text-t2">
                  {def.scriptLabel}
                </span>
                <span className="min-w-0 truncate font-ui text-[10px] text-t4">
                  · {prov}
                </span>
                <ToggleChips
                  className="ml-auto"
                  selected={effectiveBinding(def.scriptId)}
                  options={[
                    { value: DICE_ACTOR_TYPE.persona, label: t("dice_persona") },
                    { value: DICE_ACTOR_TYPE.character, label: t("dice_character") },
                  ]}
                  onChange={(next) => {
                    // keep ≥1 actor — never let a script end up with no rolls
                    if (next.length === 0) return;
                    patchBinding(def.scriptId, next as DiceActorType[]);
                  }}
                  disabled={pending}
                />
                <button
                  type="button"
                  aria-label={t("insights_dice_remove")}
                  title={t("insights_dice_remove")}
                  onClick={() => setChatSet(displayedIds.filter((id) => id !== def.scriptId))}
                  disabled={pending}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-t4 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Ic.close />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer: add existing + create (always visible) + reset (local set only). */}
      <div className="flex flex-wrap items-center gap-2">
        {!noScriptsExist && (
          <LinkBindingPopover
            links={displayedLinks}
            characters={[]}
            personas={[]}
            scripts={diceLinkTargets}
            onSetLinks={(links) => setChatSet(links.filter((l) => l.targetType === "script").map((l) => l.targetId))}
            t={t}
            isMobile={isMobile}
            showPills={false}
            triggerLabel={t("insights_dice_add")}
            tooltipLabel={t("insights_dice_add")}
            scriptSectionLabel={t("insights_dice_add")}
            emptyLabel={t("insights_dice_add_empty")}
            disabled={pending}
          />
        )}
        <button
          type="button"
          onClick={() => openDiceCreate()}
          disabled={pending}
          className="flex items-center gap-1.5 rounded-md border border-dashed border-border2 px-2.5 py-1.5 font-ui text-[12px] text-t2 transition-colors hover:border-accent hover:text-accent-t disabled:opacity-40"
        >
          <Ic.plus />
          {t("insights_dice_create_new")}
        </button>
        {!noScriptsExist && isLocalSet && (
          <button
            type="button"
            onClick={() => onPatch({ diceScriptIds: null })}
            disabled={pending}
            className="ml-auto rounded-md px-2 py-1 font-ui text-[11px] text-t4 transition-colors hover:text-accent-t disabled:opacity-40"
          >
            {t("insights_dice_reset_auto")}
          </button>
        )}
      </div>
    </div>
  );
}
