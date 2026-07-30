/**
 * Context-search session — shared lazy per-turn service that projects canonical
 * entities (characters, personas, lorebooks, lore entries, scripts) into
 * {@link ContextSearchIndex} (CE-D1) and exposes `search` + `read` primitives.
 *
 * Lifecycle: the session is created once per assembled turn, projects all
 * entities into an immutable in-memory FTS5 snapshot on the first search, then
 * reuses that snapshot for the rest of the turn. The next turn rebuilds from
 * canonical stores — edits are always visible without a restart or explicit
 * invalidation. No embeddings, no provider calls, no durable tables.
 *
 * Injected into `buildCoauthorTools` through `ChatModeAssembleInput` (alongside
 * `loreEntityLookup` / `loreDelegate`). The co-author tools
 * `search_context` / `read_context_item` use it to give the model indexed
 * discovery with full canonical content on request.
 */

import {
  buildContextSearchIndex,
  DEFAULT_SEARCH_LIMIT,
  type ContextSearchIndex,
  type ContextSearchResult,
  type IndexedContextRecord,
} from "@vibe-tavern/db";

// ── Structural view of the stores the session reads ──────────────────────────
// Minimal subsets so tests can pass a plain mock without a full StoreContainer.

export interface ContextSearchCharacterView {
  id: string;
  name: string;
  description: string;
  personalitySummary: string | null;
  tags: string[];
}

export interface ContextSearchPersonaView {
  id: string;
  name: string;
  description: string;
}

export interface ContextSearchLorebookView {
  id: string;
  name: string;
  description: string;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
}

export interface ContextSearchLoreEntryView {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: string[];
  logic: string;
  enabled: boolean;
}

export interface ContextSearchScriptView {
  id: string;
  name: string;
  description: string;
  code: string;
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
}

/** Discovery metadata for a Co-Author skill (CE-D3 skill channel). */
export interface ContextSearchSkillView {
  /** Stable skill id = the skill directory name. */
  id: string;
  /** Human-readable name from the manifest frontmatter. */
  name: string;
  /** One-line description from the manifest frontmatter (may be empty). */
  description: string;
  /** Root-relative manifest path (`<id>/SKILL.md`) — the read_skill_file target. */
  manifestPath: string;
  /** Where the winning copy lives: a user skill shadows a same-id built-in. */
  source: "builtin" | "user";
}

/** Structural read-store subset the session lazily reads. */
export interface ContextSearchStoreReads {
  // ── Bulk reads for projection (index build) ──
  listAllCharacters(): Promise<ContextSearchCharacterView[]>;
  listAllPersonas(): Promise<ContextSearchPersonaView[]>;
  listAllLorebooks(): Promise<ContextSearchLorebookView[]>;
  listEntries(lorebookId: string): Promise<ContextSearchLoreEntryView[]>;
  listAllScripts(): Promise<ContextSearchScriptView[]>;
  /** Lorebooks M:N-linked to a character (junction table). */
  listLorebooksLinkedToTarget(targetType: "character" | "persona", targetId: string): Promise<ContextSearchLorebookView[]>;
  /** Scripts M:N-linked to a character (junction table). */
  listScriptsLinkedToTarget(targetType: "character" | "persona", targetId: string): Promise<ContextSearchScriptView[]>;
  /** Co-Author skill catalog entries (CE-D3 skill channel). */
  listSkills(): Promise<ContextSearchSkillView[]>;
  // ── Direct lookups for canonical read (O(1), avoid N+1 scans) ──
  getCharacter(id: string): Promise<ContextSearchCharacterView | null>;
  getPersona(id: string): Promise<ContextSearchPersonaView | null>;
  getLorebook(id: string): Promise<ContextSearchLorebookView | null>;
  getEntry(id: string): Promise<ContextSearchLoreEntryView | null>;
  getScript(id: string): Promise<ContextSearchScriptView | null>;
}

/** Active-scope metadata — the chat's character/persona and their bound sets. */
export interface ContextSearchActiveScope {
  activeCharacterId: string | null;
  activePersonaId: string | null;
}

/** Scope mode: `active_first` boosts active-scope records within each tier. */
export type ContextSearchScopeMode = "active_first" | "library";

export interface ContextSearchSessionOptions {
  scopeMode?: ContextSearchScopeMode;
  types?: readonly string[];
  limit?: number;
}

export interface ContextSearchReadResult {
  type: string;
  id: string;
  title: string;
  content: string;
}

// ── Types the search_context tool returns (mirrors ContextSearchResult) ──────

export interface ContextSearchToolResult {
  type: string;
  id: string;
  title: string;
  scope: string;
  ownerId: string | null;
  parentId: string | null;
  meta: Record<string, string | null>;
  matchKind: string;
}

// ── Canonical read — full content by type ────────────────────────────────────

async function readCanonicalContent(
  stores: ContextSearchStoreReads,
  type: string,
  id: string,
): Promise<ContextSearchReadResult> {
  switch (type) {
    case "character": {
      const c = await stores.getCharacter(id);
      if (!c) throw new Error(`character '${id}' not found`);
      const parts = [`# ${c.name}`];
      if (c.description) parts.push(c.description);
      if (c.personalitySummary) parts.push(`\n## Personality summary\n${c.personalitySummary}`);
      if (c.tags.length > 0) parts.push(`\nTags: ${c.tags.join(", ")}`);
      return { type, id, title: c.name, content: parts.join("\n") };
    }
    case "persona": {
      const p = await stores.getPersona(id);
      if (!p) throw new Error(`persona '${id}' not found`);
      return { type, id, title: p.name, content: `# ${p.name}\n${p.description}` };
    }
    case "lorebook": {
      const lb = await stores.getLorebook(id);
      if (!lb) throw new Error(`lorebook '${id}' not found`);
      // One call for the lorebook's entries (enabled filter applied here —
      // disabled entries are hidden from canonical read just as they are from
      // the index). This is a single query, not an N+1 scan.
      const entries = (await stores.listEntries(id)).filter((e) => e.enabled);
      const parts = [`# ${lb.name}`];
      if (lb.description) parts.push(lb.description);
      if (entries.length > 0) {
        parts.push("\n## Entries");
        for (const e of entries) {
          parts.push(`\n### ${e.title}\n${e.content}`);
        }
      }
      return { type, id, title: lb.name, content: parts.join("\n") };
    }
    case "lore-entry": {
      // O(1) direct lookup — replaces the previous scan of every lorebook ×
      // every entry. A disabled entry is unreachable via search (the index
      // excludes it); a direct read by id still returns its content, matching
      // the prior scan behaviour.
      const e = await stores.getEntry(id);
      if (!e) throw new Error(`lore-entry '${id}' not found`);
      const content = [
        `# ${e.title}`,
        e.content,
        e.keys.length > 0 ? `\nKeys: ${e.keys.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { type, id, title: e.title, content };
    }
    case "script": {
      const sc = await stores.getScript(id);
      if (!sc) throw new Error(`script '${id}' not found`);
      const parts = [`# ${sc.name}`];
      if (sc.description) parts.push(sc.description);
      parts.push(`\n\`\`\`js\n${sc.code}\n\`\`\``);
      return { type, id, title: sc.name, content: parts.join("\n") };
    }
    case "skill":
      // Skills are workflow instructions, not data entities — they are loaded
      // via the separate read_skill_file tool (progressive disclosure), never
      // via read_context_item. The read_context_item schema enum already
      // excludes "skill"; this explicit guard keeps the contract clear if the
      // session.read() surface is ever called directly with type "skill".
      throw new Error(
        `skills are read via the read_skill_file tool, not read_context_item — ` +
          `use the manifestPath from the search_context result`,
      );
    default:
      throw new Error(`Unknown context type '${type}'`);
  }
}

// ── Scope helpers ────────────────────────────────────────────────────────────

/** Derive scope for an entity based on its own scopeType/owner fields. */
function deriveEntityScope(
  scopeType: string,
  ownerId: string | null,
  activeScope: ContextSearchActiveScope,
  /** Bound IDs for the active character (overrides scope to active-scope). */
  boundLorebookIds: Set<string>,
  boundScriptIds: Set<string>,
  entityId: string,
  entityKind: "character" | "persona" | "lorebook" | "script",
): string {
  // Active character itself → character:<id>
  if (entityKind === "character" && entityId === activeScope.activeCharacterId) {
    return `character:${entityId}`;
  }
  // Active persona itself → persona:<id>
  if (entityKind === "persona" && entityId === activeScope.activePersonaId) {
    return `persona:${entityId}`;
  }
  // Lorebook bound to active character → character:<activeCharId>
  if (entityKind === "lorebook" && boundLorebookIds.has(entityId) && activeScope.activeCharacterId) {
    return `character:${activeScope.activeCharacterId}`;
  }
  // Script bound to active character → character:<activeCharId>
  if (entityKind === "script" && boundScriptIds.has(entityId) && activeScope.activeCharacterId) {
    return `character:${activeScope.activeCharacterId}`;
  }
  // Canonical scope
  switch (scopeType) {
    case "character":
      return ownerId ? `character:${ownerId}` : "global";
    case "persona":
      return ownerId ? `persona:${ownerId}` : "global";
    case "chat":
      return ownerId ? `chat:${ownerId}` : "global";
    default:
      return "global";
  }
}

/** Derive ownerId for a lore-entry from its parent lorebook. */
function deriveEntryOwner(
  parentLorebookScopeType: string,
  parentLorebookOwnerId: string | null,
): string | null {
  switch (parentLorebookScopeType) {
    case "character":
      return parentLorebookOwnerId;
    case "persona":
      return parentLorebookOwnerId;
    default:
      return null;
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

async function projectAllRecords(
  stores: ContextSearchStoreReads,
  activeScope: ContextSearchActiveScope,
): Promise<{ records: IndexedContextRecord[]; boundLorebookIds: Set<string>; boundScriptIds: Set<string> }> {
  // Resolve bound resources for the active character.
  const activeCharId = activeScope.activeCharacterId;
  const [linkedLorebooks, linkedScripts] = activeCharId
    ? await Promise.all([
        stores.listLorebooksLinkedToTarget("character", activeCharId),
        stores.listScriptsLinkedToTarget("character", activeCharId),
      ])
    : [[], []];
  const boundLorebookIds = new Set(linkedLorebooks.map((lb) => lb.id));
  const boundScriptIds = new Set(linkedScripts.map((sc) => sc.id));

  const [characters, personas, lorebooks, scripts, skills] = await Promise.all([
    stores.listAllCharacters(),
    stores.listAllPersonas(),
    stores.listAllLorebooks(),
    stores.listAllScripts(),
    stores.listSkills(),
  ]);

  const records: IndexedContextRecord[] = [];

  // Characters
  for (const c of characters) {
    const scope = deriveEntityScope("character", c.id, activeScope, boundLorebookIds, boundScriptIds, c.id, "character");
    records.push({
      channel: "entity",
      type: "character",
      id: c.id,
      title: c.name,
      body: [c.description, c.personalitySummary ?? "", c.tags.join(" ")].filter(Boolean).join(" "),
      scope,
      ownerId: c.id,
      parentId: null,
      meta: {},
    });
  }

  // Personas
  for (const p of personas) {
    const scope = deriveEntityScope("persona", p.id, activeScope, boundLorebookIds, boundScriptIds, p.id, "persona");
    records.push({
      channel: "entity",
      type: "persona",
      id: p.id,
      title: p.name,
      body: p.description,
      scope,
      ownerId: p.id,
      parentId: null,
      meta: {},
    });
  }

  // Lorebooks + entries
  for (const lb of lorebooks) {
    const scope = deriveEntityScope(lb.scopeType, lb.characterId ?? lb.personaId ?? null, activeScope, boundLorebookIds, boundScriptIds, lb.id, "lorebook");
    const ownerId = deriveEntryOwner(lb.scopeType, lb.characterId ?? lb.personaId ?? null);
    records.push({
      channel: "entity",
      type: "lorebook",
      id: lb.id,
      title: lb.name,
      body: lb.description,
      scope,
      ownerId,
      parentId: null,
      meta: {},
    });

    // Entries
    const entries = await stores.listEntries(lb.id);
    for (const e of entries) {
      if (!e.enabled) continue;
      records.push({
        channel: "entity",
        type: "lore-entry",
        id: e.id,
        title: e.title,
        body: [e.content, ...e.keys].filter(Boolean).join(" "),
        scope, // inherit parent lorebook's scope
        ownerId,
        parentId: lb.id,
        meta: { lorebookId: lb.id, logic: e.logic },
      });
    }
  }

  // Scripts
  for (const sc of scripts) {
    const scope = deriveEntityScope(sc.scopeType, sc.characterId ?? sc.personaId ?? null, activeScope, boundLorebookIds, boundScriptIds, sc.id, "script");
    records.push({
      channel: "entity",
      type: "script",
      id: sc.id,
      title: sc.name,
      body: [sc.description, sc.code].filter(Boolean).join(" "),
      scope,
      ownerId: sc.characterId ?? sc.personaId ?? null,
      parentId: null,
      meta: {},
    });
  }

  // Skills (CE-D3) — library-wide workflow instructions, not data entities.
  // They carry no owner scope (always "global", never boosted) and are read via
  // the separate `read_skill_file` tool, NOT read_context_item. Surfacing them
  // in the same index lets the model discover the right skill by keyword and
  // then load its manifest — the existing progressive-disclosure flow.
  for (const sk of skills) {
    records.push({
      channel: "skill",
      type: "skill",
      id: sk.id,
      title: sk.name,
      body: sk.description,
      scope: "global",
      ownerId: null,
      parentId: null,
      meta: { manifestPath: sk.manifestPath, source: sk.source },
    });
  }

  return { records, boundLorebookIds, boundScriptIds };
}

// ── Session ──────────────────────────────────────────────────────────────────

export interface ContextSearchSession {
  search(query: string, opts?: ContextSearchSessionOptions): Promise<ContextSearchToolResult[]>;
  read(type: string, id: string): Promise<ContextSearchReadResult>;
  dispose(): void;
}

/**
 * Build a context-search session. The index is lazily constructed on the first
 * call to `search` and memoized for the rest of the session's lifetime.
 * `activeScope` is a lazy resolver — called once on the first search so the
 * session avoids a DB read when no search occurs.
 */
export function createContextSearchSession(
  stores: ContextSearchStoreReads,
  resolveActiveScope: () => Promise<ContextSearchActiveScope>,
): ContextSearchSession {
  let index: ContextSearchIndex | null = null;
  let indexReady: Promise<void> | null = null;
  let resolvedScope: ContextSearchActiveScope | null = null;

  async function ensureIndex(): Promise<ContextSearchIndex> {
    if (index) return index;
    if (!indexReady) {
      indexReady = (async () => {
        resolvedScope = await resolveActiveScope();
        const projected = await projectAllRecords(stores, resolvedScope!);
        index = buildContextSearchIndex(projected.records);
      })();
    }
    await indexReady;
    return index!;
  }

  return {
    async search(query: string, opts?: ContextSearchSessionOptions): Promise<ContextSearchToolResult[]> {
      const idx = await ensureIndex();
      const scopeBoosts =
        opts?.scopeMode === "library" || !resolvedScope?.activeCharacterId
          ? []
          : [
              `character:${resolvedScope.activeCharacterId}`,
              ...(resolvedScope.activePersonaId ? [`persona:${resolvedScope.activePersonaId}`] : []),
            ];
      const results = idx.search(query, {
        types: opts?.types,
        scopeBoosts,
        limit: opts?.limit ?? DEFAULT_SEARCH_LIMIT,
      });
      return results.map((r) => ({
        type: r.type,
        id: r.id,
        title: r.title,
        scope: r.scope,
        ownerId: r.ownerId,
        parentId: r.parentId,
        meta: r.meta,
        matchKind: r.matchKind,
      }));
    },

    async read(type: string, id: string): Promise<ContextSearchReadResult> {
      // Canonical read goes straight to the stores via O(1) direct lookups —
      // it does NOT use the index, so we must NOT call ensureIndex() here.
      // Building the index is a side effect of search only; coupling read to it
      // would (a) trigger a full library projection for a single read when the
      // model calls read_context_item without a prior search, and (b) make read
      // depend on resolveActiveScope succeeding even though read needs no scope.
      return readCanonicalContent(stores, type, id);
    },

    dispose() {
      index?.dispose();
      index = null;
      indexReady = null;
    },
  };
}
