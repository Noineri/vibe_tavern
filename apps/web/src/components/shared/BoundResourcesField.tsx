/**
 * BoundResourcesField — reverse-direction binding UI for the persona and
 * character editors.
 *
 * Shows the lorebooks AND scripts M:N-linked to the entity as avatar pills,
 * with add/remove via the shared `LinkBindingPopover`. This is the mirror of
 * the resource-side binding in `LorebookEditor` / `ScriptEditor`: instead of
 * "which characters/personas is this lorebook/script linked to" it shows
 * "which lorebooks/scripts are linked to this entity".
 *
 * Each resource kind is an independent pill group with its own optimistic
 * read-modify-write toggle. Toggle write semantics: `setLorebookLinks` /
 * `setScriptLinks` each replace the ENTIRE link set for one resource, so
 * toggling one entity's link is a per-resource read-modify-write round-trip —
 * fetch the resource's current links, add/remove this entity, put them back.
 * This matches the existing pattern in `LorebookEditor.handleSetLinks`. It is
 * safe for local-first single-user use; concurrent multi-user edits are not a
 * target.
 */
import { useCallback, useEffect, useState } from "react";
import { LinkBindingPopover, type LinkTarget } from "./LinkBindingPopover.js";
import { useT } from "../../i18n/context.js";
import {
  getLorebookLinks,
  listAllLorebooks,
  listCharacterLorebooks,
  listPersonaLorebooks,
  setLorebookLinks,
  getScriptLinks,
  setScriptLinks,
  listAllScripts,
  listCharacterScripts,
  listPersonaScripts,
} from "../../app-client.js";
import type { LorebookRecord, ScriptRecord } from "../../api/types.js";
import { CustomTooltip } from "./Tooltip.js";

interface BoundResourcesFieldProps {
  /** Which editor hosts the field — selects the reverse-read + link target. */
  entityKind: "persona" | "character";
  /** The persisted entity id (personaId / characterId). */
  entityId: string;
  isMobile: boolean;
}

/**
 * Map a lorebook record to the LinkTarget shape LinkBindingPopover expects.
 * Lorebooks have no avatar, so they fall back to the name-initial dot inside
 * LinkBindingPopover's AvatarDot (avatarAssetId null → initial).
 */
function lorebookToTarget(lb: LorebookRecord): LinkTarget {
  return { id: lb.id, name: lb.name, avatarAssetId: null };
}

/**
 * Map a script record to the LinkTarget shape. Scripts have no avatar, so they
 * fall back to the name-initial dot (same as lorebooks).
 */
function scriptToTarget(sc: ScriptRecord): LinkTarget {
  return { id: sc.id, name: sc.name, avatarAssetId: null };
}

export function BoundResourcesField({ entityKind, entityId, isMobile }: BoundResourcesFieldProps) {
  const { t } = useT();
  const [allLorebooks, setAllLorebooks] = useState<LorebookRecord[]>([]);
  const [boundIds, setBoundIds] = useState<Set<string>>(new Set());
  const [allScripts, setAllScripts] = useState<ScriptRecord[]>([]);
  const [boundScriptIds, setBoundScriptIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Load available lorebooks + scripts and the sets linked to this entity.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const boundLorebooksPromise = entityKind === "persona"
        ? listPersonaLorebooks(entityId)
        : listCharacterLorebooks(entityId);
      const boundScriptsPromise = entityKind === "persona"
        ? listPersonaScripts(entityId)
        : listCharacterScripts(entityId);
      const [allLb, boundLb, allSc, boundSc] = await Promise.all([
        listAllLorebooks(),
        boundLorebooksPromise,
        listAllScripts(),
        boundScriptsPromise,
      ]);
      setAllLorebooks(allLb);
      setBoundIds(new Set(boundLb.map((lb) => lb.id)));
      setAllScripts(allSc);
      setBoundScriptIds(new Set(boundSc.map((sc) => sc.id)));
    } finally {
      setLoading(false);
    }
  }, [entityKind, entityId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const targets = allLorebooks.map(lorebookToTarget);
  const scriptTargets = allScripts.map(scriptToTarget);
  // LinkBindingPopover is told the persona's bound lorebooks as pseudo-links of
  // targetType 'lorebook'. The pill row + the popover's lorebook section both
  // derive from this list and the `lorebooks` prop.
  const links = [...boundIds].map((id) => ({ targetType: "lorebook" as const, targetId: id }));
  const scriptLinks = [...boundScriptIds].map((id) => ({ targetType: "script" as const, targetId: id }));

  const handleSetLinks = useCallback(
    async (next: { targetType: "lorebook"; targetId: string }[]) => {
      const nextIds = new Set(next.map((l) => l.targetId));
      // Diff: added = in next but not in prev; removed = in prev but not in next.
      const added = [...nextIds].filter((id) => !boundIds.has(id));
      const removed = [...boundIds].filter((id) => !nextIds.has(id));
      const changed = [...added, ...removed];
      if (changed.length === 0) return;

      // Optimistically update the pill state so toggling feels instant; revert
      // to the server's view on failure. Each changed lorebook is a separate
      // read-modify-write round-trip (setLorebookLinks is whole-list replace).
      setBoundIds(nextIds);
      try {
        for (const lbId of changed) {
          setBusyId(lbId);
          const current = await getLorebookLinks(lbId);
          const isAdding = nextIds.has(lbId);
          const entityLink = { targetType: entityKind, targetId: entityId };
          const updated = isAdding
            ? [...current, entityLink]
            : current.filter((l) => !(l.targetType === entityKind && l.targetId === entityId));
          await setLorebookLinks(lbId, updated);
        }
      } catch {
        void refresh();
      } finally {
        setBusyId(null);
      }
    },
    [boundIds, entityKind, entityId, refresh],
  );

  const handleSetScriptLinks = useCallback(
    async (next: { targetType: "script"; targetId: string }[]) => {
      const nextIds = new Set(next.map((l) => l.targetId));
      const added = [...nextIds].filter((id) => !boundScriptIds.has(id));
      const removed = [...boundScriptIds].filter((id) => !nextIds.has(id));
      const changed = [...added, ...removed];
      if (changed.length === 0) return;

      // Same read-modify-write pattern as lorebooks: setScriptLinks replaces
      // the whole link set, so toggling one entity's binding is a per-script
      // round-trip.
      setBoundScriptIds(nextIds);
      try {
        for (const scId of changed) {
          setBusyId(scId);
          const current = await getScriptLinks(scId);
          const isAdding = nextIds.has(scId);
          const entityLink = { targetType: entityKind, targetId: entityId };
          const updated = isAdding
            ? [...current, entityLink]
            : current.filter((l) => !(l.targetType === entityKind && l.targetId === entityId));
          await setScriptLinks(scId, updated);
        }
      } catch {
        void refresh();
      } finally {
        setBusyId(null);
      }
    },
    [boundScriptIds, entityKind, entityId, refresh],
  );

  if (loading) {
    return (
      <div className="mb-3 flex items-center gap-2 font-ui text-[11px] text-t3">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-border2 border-t-transparent" />
        {t("bound_resources_loading")}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          {t("bound_lorebooks_label")}
        </span>
        <CustomTooltip content={t("bound_lorebooks_hint")}>
          <span className="cursor-help text-t4 text-[11px]">ⓘ</span>
        </CustomTooltip>
        {busyId && (
          <span className="ml-1 inline-block h-2.5 w-2.5 animate-spin rounded-full border border-border2 border-t-transparent" />
        )}
      </div>
      <LinkBindingPopover
        links={links}
        characters={[]}
        personas={[]}
        lorebooks={targets}
        onSetLinks={(newLinks) => {
          void handleSetLinks(newLinks as { targetType: "lorebook"; targetId: string }[]);
        }}
        t={t}
        isMobile={isMobile}
        tooltipLabel={t("bound_lorebooks_add")}
        emptyLabel={t("bound_lorebooks_empty")}
        lorebookSectionLabel={t("bound_lorebooks_section")}
      />

      <div className="mt-3 mb-1.5 flex items-center gap-1.5">
        <span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">
          {t("bound_scripts_label")}
        </span>
        <CustomTooltip content={t("bound_scripts_hint")}>
          <span className="cursor-help text-t4 text-[11px]">ⓘ</span>
        </CustomTooltip>
      </div>
      <LinkBindingPopover
        links={scriptLinks}
        characters={[]}
        personas={[]}
        scripts={scriptTargets}
        onSetLinks={(newLinks) => {
          void handleSetScriptLinks(newLinks as { targetType: "script"; targetId: string }[]);
        }}
        t={t}
        isMobile={isMobile}
        tooltipLabel={t("bound_scripts_add")}
        emptyLabel={t("bound_scripts_empty")}
        scriptSectionLabel={t("bound_scripts_section")}
      />
    </div>
  );
}
