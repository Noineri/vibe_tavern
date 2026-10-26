/**
 * Script-kind context-card resolution (AS-8e1) — the adapter-side helper that
 * resolves a script's linked owners (names) PLUS the request's build-panel
 * character/persona into full cards. Extracted verbatim from
 * experience-copilot-adapter.ts (the `experience-copilot-turn-delete.ts`
 * helper pattern) when AP-9's regenerate seam wiring pushed the adapter past
 * the 800-line size ratchet — the behavior is byte-identical to the private
 * method it replaces; only `this.stores` became the explicit `stores` param.
 *
 * The card text is the same source the @-pin loader uses: a character's full
 * profile markdown, a persona's description. The script kind's context
 * package lists the names so the model knows whom the script binds to, then
 * renders every card in full — the assistant sees what a human author would
 * need, not just a name. Deduped by type+id (a request id that is also a
 * linked owner renders once); dangling targets and missing rows are skipped,
 * never fatal. `scriptId === null` (a draft thread) still resolves the
 * request ids.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type { ScriptAgentContextCard } from "../../domain/agent/kinds/script-kind.js";

/** The store slots the card resolution reads (structural so tests can pass a
 *  narrowed container). */
export type ScriptCardStores = Pick<StoreContainer, "characters" | "personas" | "scripts">;

/** Resolve a script's linked owners (names) plus the request's build-panel
 *  character/persona ids into full context cards (see the module header). */
export async function resolveScriptAgentContextCards(
  stores: ScriptCardStores,
  input: {
    scriptId: string | null;
    contextCharacterId?: string;
    contextPersonaId?: string;
  },
): Promise<{ ownerNames: string[]; cards: ScriptAgentContextCard[] }> {
  const names: string[] = [];
  const cards: ScriptAgentContextCard[] = [];
  const seen = new Set<string>();
  const pushCharacter = async (id: string): Promise<void> => {
    const key = `character:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const character = await stores.characters.getById(id);
    if (!character) return;
    names.push(character.name);
    cards.push({
      type: "character",
      id: character.id,
      name: character.name,
      content: await stores.characters.getProfileMdText(id),
    });
  };
  const pushPersona = async (id: string, countAsOwner: boolean): Promise<void> => {
    const key = `persona:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const persona = await stores.personas.getById(id);
    if (!persona) return;
    if (countAsOwner) names.push(persona.name);
    cards.push({ type: "persona", id: persona.id, name: persona.name, content: persona.description });
  };
  if (input.scriptId !== null) {
    const links = await stores.scripts.getLinks(input.scriptId);
    for (const link of links) {
      if (link.targetType === "character") {
        await pushCharacter(link.targetId);
      } else {
        await pushPersona(link.targetId, true);
      }
    }
  }
  // The request's build-panel ids are context, not ownership: their cards
  // render, but their names never join the «Linked owners» line.
  if (input.contextCharacterId !== undefined) await pushCharacter(input.contextCharacterId);
  if (input.contextPersonaId !== undefined) await pushPersona(input.contextPersonaId, false);
  return { ownerNames: names, cards };
}
