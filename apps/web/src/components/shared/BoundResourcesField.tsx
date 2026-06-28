/**
 * BoundResourcesField — reverse-direction binding UI for the persona editor.
 *
 * Shows the lorebooks M:N-linked to the persona as avatar pills, with add/remove
 * via the shared `LinkBindingPopover`. This is the mirror of the lorebook-side
 * binding in `LorebookEditor`: instead of "which characters/personas is this
 * lorebook linked to" it shows "which lorebooks are linked to this persona".
 *
 * Lorebook-only by design. Scripts use a different binding model (FK ownership,
 * not M:N) and are tracked separately — see
 * `vibe_tavern_plan/reports/script-link-binding-gap.md`. When that gap is closed,
 * a script pill group will be added here. Character support rides along once the
 * character reverse-read endpoint exists (mirrors `listPersonaLorebooks`).
 *
 * Toggle write semantics: `setLorebookLinks` replaces the ENTIRE link set for a
 * lorebook, so toggling one persona's link is a read-modify-write round-trip —
 * fetch the lorebook's current links, add/remove this persona, put them back.
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
  listPersonaLorebooks,
  setLorebookLinks,
} from "../../app-client.js";
import type { LorebookRecord } from "../../api/types.js";
import { CustomTooltip } from "./Tooltip.js";

interface BoundResourcesFieldProps {
  personaId: string;
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

export function BoundResourcesField({ personaId, isMobile }: BoundResourcesFieldProps) {
  const { t } = useT();
  const [allLorebooks, setAllLorebooks] = useState<LorebookRecord[]>([]);
  const [boundIds, setBoundIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Load available lorebooks + the set linked to this persona.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [all, bound] = await Promise.all([
        listAllLorebooks(),
        listPersonaLorebooks(personaId),
      ]);
      setAllLorebooks(all);
      setBoundIds(new Set(bound.map((lb) => lb.id)));
    } finally {
      setLoading(false);
    }
  }, [personaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const targets = allLorebooks.map(lorebookToTarget);
  // LinkBindingPopover is told the persona's bound lorebooks as pseudo-links of
  // targetType 'lorebook'. The pill row + the popover's lorebook section both
  // derive from this list and the `lorebooks` prop.
  const links = [...boundIds].map((id) => ({ targetType: "lorebook" as const, targetId: id }));

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
          const personaLink = { targetType: "persona" as const, targetId: personaId };
          const updated = isAdding
            ? [...current, personaLink]
            : current.filter((l) => !(l.targetType === "persona" && l.targetId === personaId));
          await setLorebookLinks(lbId, updated);
        }
      } catch {
        void refresh();
      } finally {
        setBusyId(null);
      }
    },
    [boundIds, personaId, refresh],
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
        <span className="font-ui text-[11px] font-medium uppercase tracking-wider text-t3">
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
    </div>
  );
}
