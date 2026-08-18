/**
 * CX-2: pinned-context loader for the experience copilot — resolves thread
 * context links into read-only reference items (CE-C1 semantics, generalized
 * to five target types) plus the skill arm (catalog entry → SKILL.md body,
 * injected eagerly per plan; `read_skill_file` stays for on-demand assets).
 * Pure: all I/O lives behind injected deps.
 */

import type { ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import type { SkillCatalogEntry } from "../../coauthor/skills/skill-scanner.js";

export type CopilotContextItemType = "character" | "persona" | "lorebook" | "script" | "skill";

/** CX-2: one resolved pinned-context entity (or one lorebook ENTRY — books
 *  expand to N items, one per enabled entry, exactly like CE-C1). `type` drives
 *  the block header in {@link renderAttachedContext}. */
export interface CopilotContextItem {
  type: CopilotContextItemType;
  /** Entity id, or the lore ENTRY id when `type === "lorebook"`. */
  id: string;
  title: string;
  content: string;
}

/** Skill catalog access for the skill arm — satisfied by `SkillLibraryService`
 *  (readCatalogEntry) plus a sandboxed read wrapper (see skill-read-tool's
 *  readSkillFile; CX-3 wires the real adapter). `readFile` returns null when the
 *  manifest is missing/unreadable — the item is then skipped, never fatal. */
export interface CopilotSkillSource {
  readCatalogEntry(id: string): Promise<SkillCatalogEntry | null>;
  readFile(rootRelativePath: string): Promise<string | null>;
}

/** Structural store subset — the real StoreContainer satisfies this without
 *  adapters (method syntax keeps param bivariance for branded ids). */
export interface CopilotContextDeps {
  characters: {
    getById(id: string): Promise<{ id: string; name: string } | null>;
    getProfileMdText(id: string): Promise<string>;
  };
  personas: {
    getById(id: string): Promise<{ id: string; name: string; description: string } | null>;
  };
  lorebooks: {
    getLorebook(id: string): Promise<{ id: string; enabled: boolean } | null>;
    listEntries(id: string): Promise<Array<{ id: string; title: string; content: string; enabled: boolean }>>;
  };
  scripts: {
    getById(id: string): Promise<{ id: string; name: string; description: string; code: string } | null>;
  };
  skills: CopilotSkillSource;
}

/** Resolve the thread's pinned-context links into read-only reference items.
 *  Mirrors the co-author's CE-C1 resolution (character profile / persona
 *  description / one item per enabled lorebook entry / script code block) and
 *  adds the skill arm: the catalog entry's SKILL.md body is injected eagerly.
 *  Dangling links and disabled lorebooks are skipped silently; duplicate
 *  type+id pairs (a book pinned twice) inject once. */
export async function getCopilotContextItems(
  links: readonly ExperienceCopilotContextLink[],
  deps: CopilotContextDeps,
): Promise<CopilotContextItem[]> {
  const out: CopilotContextItem[] = [];
  for (const link of links) {
    if (link.targetType === "character") {
      const c = await deps.characters.getById(link.targetId);
      if (!c) continue;
      const content = await deps.characters.getProfileMdText(link.targetId);
      out.push({ type: "character", id: c.id, title: c.name, content });
    } else if (link.targetType === "persona") {
      const p = await deps.personas.getById(link.targetId);
      if (!p) continue;
      out.push({ type: "persona", id: p.id, title: p.name, content: p.description });
    } else if (link.targetType === "lorebook") {
      const lb = await deps.lorebooks.getLorebook(link.targetId);
      if (!lb || !lb.enabled) continue;
      const entries = await deps.lorebooks.listEntries(link.targetId);
      for (const entry of entries.filter((e) => e.enabled)) {
        out.push({ type: "lorebook", id: entry.id, title: entry.title, content: entry.content });
      }
    } else if (link.targetType === "script") {
      const sc = await deps.scripts.getById(link.targetId);
      if (!sc) continue;
      const body = sc.description.trim()
        ? `${sc.description.trim()}\n\n\`\`\`js\n${sc.code}\n\`\`\``
        : `\`\`\`js\n${sc.code}\n\`\`\``;
      out.push({ type: "script", id: sc.id, title: sc.name, content: body });
    } else {
      // skill
      const entry = await deps.skills.readCatalogEntry(link.targetId);
      if (!entry) continue;
      const body = await deps.skills.readFile(entry.rootRelativeManifestPath);
      if (body === null) continue;
      out.push({ type: "skill", id: entry.id, title: entry.name, content: body });
    }
  }
  // Dedupe by type+id (a book pinned twice shouldn't double-inject its entries).
  const seen = new Set<string>();
  return out.filter((it) => {
    const key = `${it.type}:${it.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Render the thread's pinned-context items as read-only reference blocks
 *  (CX-2; generalizes CE-C1's renderContextBlocks to five target types, the
 *  skill arm added). Each item is tagged with its kind so a mixed set is
 *  unambiguous to the model. Empty string when nothing is pinned — the section
 *  is then omitted entirely. */
export function renderAttachedContext(items: readonly CopilotContextItem[]): string {
  if (items.length === 0) return "";
  const TYPE_TAG = {
    character: "Character",
    persona: "Persona",
    lorebook: "Lorebook",
    script: "Script",
    skill: "Skill",
  } as const;
  const blocks = items.map((it) => {
    const title = it.title?.trim() ? it.title.trim() : "(untitled)";
    return `## [${TYPE_TAG[it.type]}] ${title}\n${it.content}`;
  });
  return ["# Pinned context (read-only reference — do NOT edit)", ...blocks].join("\n");
}
