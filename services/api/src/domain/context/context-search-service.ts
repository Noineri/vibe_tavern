/**
 * Context-search session — shared lazy per-turn service that projects canonical
 * entities (characters, personas, lorebooks, lore entries, scripts) into
 * {@link ContextSearchIndex} (CE-D1) and exposes `search` + `read` primitives.
 * Since SC-10 a session wired with a branch view (the sidechat's) also
 * projects the branch's selected messages as `rp-message` records — current
 * model-facing text, read back as the message plus its immediate neighbours.
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
 * discovery with full canonical content on request. The sidechat's own thin
 * twin of those tools (kinds/sidechat/sidechat-search-tools.ts) rides the same
 * session with a branch view and no Co-Author skill catalog.
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

/** Structural view of one branch message the `rp-message` channel indexes
 *  (SC-10). `RpBranchViewMessage` (domain/sidechat/rp-branch-view.ts — the
 *  SC-2a view) satisfies this structurally; the interface stays local so the
 *  session's tests can pass plain literals, the file's established pattern.
 *  `text` is the CURRENT text — the message as the RP model sees it NOW
 *  (macros resolved, prompt-placement regex applied, dice/report blocks),
 *  never the raw stored `messages.content` (owner decision 1 refined,
 *  2026-10-20). */
export interface ContextSearchRpMessageView {
  id: string;
  /** 0-based branch position, as stored on the message row. */
  position: number;
  role: "system" | "user" | "assistant" | "tool";
  /** Speaker name (assistant → character, user → persona, else null). */
  authorName: string | null;
  /** The message's current model-facing text. */
  text: string;
}

/** The branch whose selected messages a session's `rp-message` records index
 *  (SC-10): the SC-2a view (`readBranchAsModelSees`) the TURN'S SYNC already
 *  produced. The session CONSUMES this view — it never runs its own branch
 *  read or RP assembly (the plan's "one view per turn" rule). `RpBranchView`
 *  satisfies this structurally. */
export interface ContextSearchBranchView {
  chatId: string;
  branchId: string;
  /** Position order, oldest first (the SC-2a view's contract). */
  messages: readonly ContextSearchRpMessageView[];
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

/** Render one branch message as a labelled block (SC-10's read path). */
function renderRpMessageBlock(label: string, message: ContextSearchRpMessageView): string {
  const author = message.authorName !== null ? ` — ${message.authorName}` : "";
  return `## ${label} — RP message #${message.position + 1} (${message.role}${author})\n${message.text}`;
}

async function readCanonicalContent(
  stores: ContextSearchStoreReads,
  type: string,
  id: string,
  /** The session-held branch view — the ONLY source for `rp-message` reads
   *  (null when the session has no branch wired; the read then misses). */
  branch: ContextSearchBranchView | null,
): Promise<ContextSearchReadResult> {
  switch (type) {
    case "rp-message": {
      // The view is position-ordered, so array adjacency IS story adjacency
      // (positions may have gaps — deletes do not renumber — so the
      // neighbours are the PREVIOUS/NEXT ENTRIES, never position arithmetic).
      const index = branch?.messages.findIndex((m) => m.id === id) ?? -1;
      if (branch === null || index < 0) {
        throw new Error(`rp-message '${id}' not found in this branch`);
      }
      const message = branch.messages[index]!;
      const before = index > 0 ? branch.messages[index - 1] : null;
      const after = index + 1 < branch.messages.length ? branch.messages[index + 1] : null;
      const parts = [
        `# RP message #${message.position + 1}`,
        // The explicit current-text marker: the sidechat's prompt also carries
        // FROZEN rp_sync events, and the model must never confuse this read
        // with one of those snapshots (the plan's "current text, not a frozen
        // event" pin).
        "Current text as the RP model sees it now (macros resolved, prompt regex applied) — not a frozen event copy.",
        renderRpMessageBlock("This message", message),
      ];
      if (before !== null) parts.push(renderRpMessageBlock("Before", before));
      if (after !== null) parts.push(renderRpMessageBlock("After", after));
      return {
        type,
        id,
        title: `RP message #${message.position + 1}`,
        content: parts.join("\n\n"),
      };
    }
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
  /** Entity scope's home FK is the typed pair — the persona column decides
   *  which owner label an entity-scoped resource carries. */
  personaOwnerId?: string | null,
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
    case "entity":
      return personaOwnerId ? `persona:${personaOwnerId}` : ownerId ? `character:${ownerId}` : "global";
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
    case "persona":
    case "entity":
      return parentLorebookOwnerId;
    default:
      return null;
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

async function projectAllRecords(
  stores: ContextSearchStoreReads,
  activeScope: ContextSearchActiveScope,
  /** The session-held branch view — SC-10's `rp-message` records; null (the
   *  Co-Author's sessions) indexes no branch messages. */
  branch: ContextSearchBranchView | null,
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
    const scope = deriveEntityScope(lb.scopeType, lb.characterId ?? lb.personaId ?? null, activeScope, boundLorebookIds, boundScriptIds, lb.id, "lorebook", lb.personaId);
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
    const scope = deriveEntityScope(sc.scopeType, sc.characterId ?? sc.personaId ?? null, activeScope, boundLorebookIds, boundScriptIds, sc.id, "script", sc.personaId);
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

  // Branch messages (SC-10) — the sidechat's own channel: the SELECTED
  // messages of the thread's branch, at their CURRENT text (the SC-2a view
  // the turn's sync already produced — macros resolved, prompt regex applied;
  // since SC-6 the view keeps summary-covered messages, exactly the old
  // material this search exists to find). Scope `branch:<id>` never matches a
  // character/persona boost — story text ranks by relevance alone, and no
  // other branch's messages can appear here (the view is this branch only,
  // so cross-branch isolation holds by construction).
  if (branch !== null) {
    for (const m of branch.messages) {
      records.push({
        channel: "branch",
        type: "rp-message",
        id: m.id,
        title: `RP message #${m.position + 1}`,
        body: m.text,
        scope: `branch:${branch.branchId}`,
        ownerId: null,
        parentId: null,
        meta: { role: m.role, author: m.authorName, position: String(m.position) },
      });
    }
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
 * session avoids a DB read when no search occurs. `resolveBranchView` (the
 * sidechat's sessions, SC-10) is likewise lazy: the SC-2a branch view the
 * TURN'S SYNC already produced, handed to the session — never a second branch
 * read or dry RP assembly here. A null resolution (or an omitted resolver, the
 * Co-Author's sessions) indexes no `rp-message` records; an `rp-message` read
 * then misses with the not-found refusal.
 */
export function createContextSearchSession(
  stores: ContextSearchStoreReads,
  resolveActiveScope: () => Promise<ContextSearchActiveScope>,
  resolveBranchView?: () => Promise<ContextSearchBranchView | null>,
): ContextSearchSession {
  let index: ContextSearchIndex | null = null;
  let indexReady: Promise<void> | null = null;
  let resolvedScope: ContextSearchActiveScope | null = null;
  let branchView: ContextSearchBranchView | null | undefined;

  async function ensureBranchView(): Promise<ContextSearchBranchView | null> {
    if (branchView === undefined) {
      branchView = resolveBranchView ? await resolveBranchView() : null;
    }
    return branchView;
  }

  async function ensureIndex(): Promise<ContextSearchIndex> {
    if (index) return index;
    if (!indexReady) {
      indexReady = (async () => {
        resolvedScope = await resolveActiveScope();
        const projected = await projectAllRecords(stores, resolvedScope!, await ensureBranchView());
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
      // The branch view is resolved HERE for `rp-message` reads only (SC-10):
      // the sidechat's resolver returns the view the turn already holds, so an
      // rp-message read costs no branch read and no RP assembly either.
      return readCanonicalContent(
        stores,
        type,
        id,
        type === "rp-message" ? await ensureBranchView() : null,
      );
    },

    dispose() {
      index?.dispose();
      index = null;
      indexReady = null;
    },
  };
}
