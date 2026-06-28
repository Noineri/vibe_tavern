/**
 * Context resolver for AI assistant requests.
 *
 * Resolves `characterIds[]`, `personaIds[]`, `loreEntryIds[]`, and
 * `lorebookIds[]` from the request into structured data suitable for the prompt pipeline's
 * `PromptAssemblyContext`.
 */

import type { PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import type { PronounForms } from "@vibe-tavern/domain";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextCharacter {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
}

export interface ContextPersona {
  id: string;
  name: string;
  description: string;
  pronouns?: string;
  pronounForms?: PronounForms | null;
}

export interface ContextLoreEntry {
  id: string;
  title: string;
  content: string;
}

export interface ResolvedContext {
  characters: ContextCharacter[];
  personas: ContextPersona[];
  lore: ContextLoreEntry[];
}

export interface ContextResolverDeps {
  getCharacterById(id: string): Promise<ContextCharacter | null>;
  getPersonaById(id: string): Promise<ContextPersona | null>;
  getLoreEntryById(id: string): Promise<ContextLoreEntry | null>;
  getLoreEntriesByLorebookId?(id: string): Promise<ContextLoreEntry[]>;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export async function resolveContext(
  deps: ContextResolverDeps,
  ids: {
    characterIds?: string[];
    personaIds?: string[];
    loreEntryIds?: string[];
    lorebookIds?: string[];
  },
): Promise<ResolvedContext> {
  const [characters, personas, directLore, lorebookLore] = await Promise.all([
    resolveArray(ids.characterIds, deps.getCharacterById),
    resolveArray(ids.personaIds, deps.getPersonaById),
    resolveArray(ids.loreEntryIds, deps.getLoreEntryById),
    resolveLorebooks(ids.lorebookIds, deps.getLoreEntriesByLorebookId),
  ]);

  return { characters, personas, lore: dedupeLore([...directLore, ...lorebookLore]) };
}

/**
 * Build the pipeline-compatible character fields from resolved context.
 * Returns only the fields the pipeline actually reads.
 */
export function toPipelineCharacters(
  resolved: ResolvedContext,
): PromptAssemblyContext["character"][] {
  return resolved.characters.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
  }));
}

export function toPipelinePersonas(
  resolved: ResolvedContext,
): PromptAssemblyContext["persona"][] {
  return resolved.personas.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    pronouns: p.pronouns,
    pronounForms: p.pronounForms ?? null,
  }));
}

export function toPipelineLore(
  resolved: ResolvedContext,
): PromptAssemblyContext["lore"] {
  return resolved.lore.map((e) => ({
    id: e.id,
    title: e.title,
    content: e.content,
    priority: 0,
    position: "before_char" as const,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveArray<T>(
  ids: string[] | undefined,
  resolver: (id: string) => Promise<T | null>,
): Promise<T[]> {
  if (!ids || ids.length === 0) return [];
  const results = await Promise.all(ids.map(resolver));
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

async function resolveLorebooks(
  ids: string[] | undefined,
  resolver: ((id: string) => Promise<ContextLoreEntry[]>) | undefined,
): Promise<ContextLoreEntry[]> {
  if (!ids || ids.length === 0 || !resolver) return [];
  const results = await Promise.all(ids.map(resolver));
  return results.flat();
}

function dedupeLore(entries: ContextLoreEntry[]): ContextLoreEntry[] {
  const seen = new Set<string>();
  const out: ContextLoreEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}
