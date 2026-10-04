import { useEffect, useMemo } from "react";
import type { AppCharacterEntry, LorebookRecord, PersonaRecord } from "../../../api/types.js";
import type { Scope } from "./LorebookAccordion.js";
import type { WorldLoreOwnerOption } from "./LorebookListHeader.js";

interface UseLorebookListFiltersArgs {
  scope: Scope;
  ownerId: string | null;
  setOwnerId: (ownerId: string | null) => void;
  lorebooks: LorebookRecord[];
  characters: AppCharacterEntry[];
  personas: PersonaRecord[];
  ownerDataReady: boolean;
  nameSearch: string;
}

/** Owns lorebook-only list filtering while the shared owner picker receives its source options. */
export function useLorebookListFilters({
  scope,
  ownerId,
  setOwnerId,
  lorebooks,
  characters,
  personas,
  ownerDataReady,
  nameSearch,
}: UseLorebookListFiltersArgs) {
  const owners = useMemo<WorldLoreOwnerOption[]>(() => {
    const characterIds = new Set(lorebooks.flatMap((lorebook) => lorebook.characterId ? [lorebook.characterId] : []));
    const personaIds = new Set(lorebooks.flatMap((lorebook) => lorebook.personaId ? [lorebook.personaId] : []));
    return [
      ...characters.filter((character) => characterIds.has(character.id)).map((character) => ({ id: character.id, name: character.name, kind: "character" as const })),
      ...personas.filter((persona) => personaIds.has(persona.id)).map((persona) => ({ id: persona.id, name: persona.name, kind: "persona" as const })),
    ];
  }, [characters, lorebooks, personas]);
  const visibleLorebooks = useMemo(() => {
    const ownerFiltered = scope === "entity" && ownerId
      ? lorebooks.filter((lorebook) => lorebook.characterId === ownerId || lorebook.personaId === ownerId)
      : lorebooks;
    const query = nameSearch.trim().toLocaleLowerCase();
    return query ? ownerFiltered.filter((lorebook) => lorebook.name.toLocaleLowerCase().includes(query)) : ownerFiltered;
  }, [lorebooks, nameSearch, ownerId, scope]);

  useEffect(() => {
    if (!ownerId || !ownerDataReady) return;
    const ownerExists = characters.some((character) => character.id === ownerId)
      || personas.some((persona) => persona.id === ownerId);
    if (!ownerExists) setOwnerId(null);
  }, [characters, ownerDataReady, ownerId, personas, setOwnerId]);

  return { owners, visibleLorebooks };
}
