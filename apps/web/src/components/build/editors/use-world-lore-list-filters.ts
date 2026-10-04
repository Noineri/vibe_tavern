import { useEffect, useMemo } from "react";
import type { AppCharacterEntry, PersonaRecord } from "../../../api/types.js";
import type { Scope } from "./LorebookAccordion.js";
import type { WorldLoreOwnerOption } from "./LorebookListHeader.js";

/** Persisted owner-filter value reserved for entity-scoped records with no links. */
export const WORLD_LORE_UNBOUND_OWNER_ID = "__world_lore_unbound_owner__";

type WorldLoreLink = {
  targetType: "character" | "persona";
  targetId: string;
};

type WorldLoreListItem = {
  id: string;
  name: string;
  scopeType: string;
};

interface UseWorldLoreListFiltersArgs<T extends WorldLoreListItem> {
  scope: Scope;
  ownerId: string | null;
  setOwnerId?: (ownerId: string | null) => void;
  items: T[];
  linksByItemId: Map<string, WorldLoreLink[]>;
  characters: AppCharacterEntry[];
  personas: PersonaRecord[];
  ownerDataReady?: boolean;
  nameSearch: string;
}

/**
 * The client-side ownership rule for World & Lore lists.
 *
 * Both tabs already load their link rows for the shared LinkBindingPopover, so
 * this derives options, owner filtering, and the unbound filter from those same
 * rows instead of recreating ownership from removed home-owner fields.
 */
export function useWorldLoreListFilters<T extends WorldLoreListItem>({
  scope,
  ownerId,
  setOwnerId,
  items,
  linksByItemId,
  characters,
  personas,
  ownerDataReady,
  nameSearch,
}: UseWorldLoreListFiltersArgs<T>) {
  const owners = useMemo<WorldLoreOwnerOption[]>(() => {
    const linkedTargetIds = new Set(
      items.flatMap((item) =>
        item.scopeType === "entity"
          ? (linksByItemId.get(item.id) ?? []).map((link) => link.targetId)
          : [],
      ),
    );
    const hasUnboundEntity = items.some(
      (item) => item.scopeType === "entity" && linksByItemId.get(item.id)?.length === 0,
    );
    return [
      ...(hasUnboundEntity ? [{ id: WORLD_LORE_UNBOUND_OWNER_ID, name: "", kind: "unbound" as const }] : []),
      ...characters.filter((character) => linkedTargetIds.has(character.id)).map((character) => ({ id: character.id, name: character.name, kind: "character" as const })),
      ...personas.filter((persona) => linkedTargetIds.has(persona.id)).map((persona) => ({ id: persona.id, name: persona.name, kind: "persona" as const })),
    ];
  }, [characters, items, linksByItemId, personas]);

  const visibleItems = useMemo(() => {
    const ownerFiltered = scope === "entity" && ownerId
      ? ownerId === WORLD_LORE_UNBOUND_OWNER_ID
        ? items.filter((item) => item.scopeType === "entity" && linksByItemId.get(item.id)?.length === 0)
        : items.filter((item) => item.scopeType === "entity" && linksByItemId.get(item.id)?.some((link) => link.targetId === ownerId))
      : items;
    const query = nameSearch.trim().toLocaleLowerCase();
    return query ? ownerFiltered.filter((item) => item.name.toLocaleLowerCase().includes(query)) : ownerFiltered;
  }, [items, linksByItemId, nameSearch, ownerId, scope]);

  useEffect(() => {
    if (!ownerId || ownerId === WORLD_LORE_UNBOUND_OWNER_ID || !ownerDataReady || !setOwnerId) return;
    const ownerExists = characters.some((character) => character.id === ownerId)
      || personas.some((persona) => persona.id === ownerId);
    if (!ownerExists) setOwnerId(null);
  }, [characters, ownerDataReady, ownerId, personas, setOwnerId]);

  return { owners, visibleItems };
}
