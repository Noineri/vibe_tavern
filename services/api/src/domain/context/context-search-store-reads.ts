/**
 * The ONE store-reads mapping for context-search sessions (SC-10 extraction).
 *
 * `ContextSearchStoreReads` (context-search-service.ts) is a structural
 * interface, and mapping a real `StoreContainer` onto it is pure wiring — 13
 * wrappers (7 bulk reads + 5 O(1) lookups + the skill catalog projection).
 * Until SC-10 that mapping existed once, inline in
 * `session-runtime.ts#buildContextSearchSession` (the Co-Author's session);
 * the sidechat's session (the copilot adapter's wiring) needs the same map,
 * and a second hand-copied wrapper block is exactly the defect the
 * one-data-source rule forbids — so the mapping lives HERE, and every consumer
 * (Co-Author runtime, sidechat adapter) reads this module and only renders it.
 *
 * The skill catalog is an OPTIONAL arm, by consumer: the Co-Author's session
 * projects its skill catalog (CE-D3 — the Co-Author can load those skills via
 * `read_skill_file`); the sidechat's session passes NO catalog — its own
 * skills reach the model through `@` pins (SC-5), never through search, so its
 * index carries no Co-Author skill records.
 */

import type {
  CharacterStore,
  LorebookStore,
  PersonaStore,
  ScriptStore,
} from "@vibe-tavern/db";
import type { SkillCatalogEntry } from "../coauthor/skills/skill-scanner.js";
import type { ContextSearchStoreReads } from "./context-search-service.js";

/** The store slots the mapping reads — structural `Pick`s so a full
 *  `StoreContainer` slots in without adapters and tests can pass narrow seams. */
export interface ContextSearchStoreReadsSource {
  readonly characters: Pick<CharacterStore, "listAll" | "getById">;
  readonly personas: Pick<PersonaStore, "listAll" | "getById">;
  readonly lorebooks: Pick<
    LorebookStore,
    "listAllLorebooks" | "listEntries" | "getLorebook" | "getEntry" | "listLorebooksLinkedToTarget"
  >;
  readonly scripts: Pick<ScriptStore, "listAll" | "getById" | "listScriptsLinkedToTarget">;
}

/**
 * Map real stores (plus an optional skill catalog) onto the session's
 * structural {@link ContextSearchStoreReads}. Without `getSkillCatalog` the
 * mapping lists NO skills — the sidechat's shape (no Co-Author skill records
 * in the index); with it, the catalog projects into the skill channel exactly
 * as the Co-Author's session always has.
 */
export function buildContextSearchStoreReads(
  source: ContextSearchStoreReadsSource,
  getSkillCatalog?: () => Promise<SkillCatalogEntry[]>,
): ContextSearchStoreReads {
  const { characters, personas, lorebooks, scripts } = source;
  return {
    listAllCharacters: () => characters.listAll(),
    listAllPersonas: () => personas.listAll(),
    listAllLorebooks: () => lorebooks.listAllLorebooks(),
    listEntries: (lorebookId: string) => lorebooks.listEntries(lorebookId),
    listAllScripts: () => scripts.listAll(),
    listLorebooksLinkedToTarget: (targetType: "character" | "persona", targetId: string) =>
      lorebooks.listLorebooksLinkedToTarget(targetType, targetId),
    listScriptsLinkedToTarget: (targetType: "character" | "persona", targetId: string) =>
      scripts.listScriptsLinkedToTarget(targetType, targetId),
    getCharacter: (id: string) => characters.getById(id),
    getPersona: (id: string) => personas.getById(id),
    getLorebook: (id: string) => lorebooks.getLorebook(id),
    getEntry: (id: string) => lorebooks.getEntry(id),
    getScript: (id: string) => scripts.getById(id),
    listSkills: async () => {
      // CE-D3, kept verbatim from the pre-extraction site: project the skill
      // catalog into the search index's skill channel. getSkillCatalog returns
      // SkillCatalogEntry[] (already user>builtin merged); map to the narrow
      // ContextSearchSkillView the session expects. No catalog wired → no
      // skill records (the sidechat's contract).
      if (getSkillCatalog === undefined) return [];
      const entries = await getSkillCatalog();
      return entries.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        manifestPath: s.rootRelativeManifestPath,
        source: s.source,
      }));
    },
  };
}
