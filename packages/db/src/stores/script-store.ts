import { eq, and, or, asc, inArray } from 'drizzle-orm';
import type { ScriptKind } from '@vibe-tavern/domain';
import { scripts, scriptLinks, scriptVisuals } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS } from '../file-store.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateScriptData {
  name: string;
  description?: string;
  code?: string;
  enabled?: boolean;
  /** Runtime contract: 'prompt' (default) or 'dice'. Set at creation; the two
   *  runtimes are isolated by kind at the resolver boundary. */
  scriptKind?: ScriptKind;
  /** Server-idempotent creation key. When set and an existing script already
   *  carries it, `create` returns that script instead of duplicating —
   *  process-safe against retries/two tabs/restart. NOT content: omitted from
   *  the file payload and never updatable. */
  creationIntentId?: string | null;
  scopeType?: string;
  sortOrder?: number;
  /** Deprecated home-owner input — accepted for API-shape compatibility but
   *  NOT written anywhere: migration 0107 (LORE_SCRIPT_OWNERS_AS_LINKS step 1)
   *  dropped the home-owner columns; owners are `script_links` rows only.
   *  The explicit-owner-list create API that replaces this field is step 2
   *  (COAUTHOR_MODEL_LORE_CHAIN_PLAN unit 15). */
  characterId?: string | null;
  /** Deprecated home-owner input — ignored; see {@link characterId}. */
  personaId?: string | null;
  chatId?: string | null;
  /** Default visual paired with this experience (interactive scripts only).
   *  Set by the creation wizard; null for non-interactive and legacy rows. */
  defaultVisualId?: string | null;
  /** Optional copilot profile assigned to this experience (interactive scripts
   *  only). Soft link — a plain stored id with NO FK. */
  copilotProfileId?: string | null;
  extensions?: Record<string, unknown>;
}

export type UpdateScriptData = Partial<CreateScriptData>;

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Store-level Script — domain Script projected from a DB row.
 */
export interface Script {
  id: string;
  name: string;
  description: string;
  code: string;
  enabled: boolean;
  scriptKind: ScriptKind;
  /** Server-idempotent creation key (nullable; unique when set). Read-only. */
  creationIntentId: string | null;
  scopeType: string;
  sortOrder: number;
  /** Always null since migration 0107 (home-owner columns dropped; owners are
   *  links). Kept on the store/API shape until the step-2 contract redesign
   *  removes it — do not read it for behavior. */
  characterId: string | null;
  /** Always null since migration 0107 — see {@link characterId}. */
  personaId: string | null;
  chatId: string | null;
  defaultVisualId: string | null;
  copilotProfileId: string | null;
  extensions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Junction row: a script M:N-linked to a character or persona. Mirrors
 * `LorebookLink`. Since migration 0107 links are the ONLY owner source — a
 * link IS the owner binding (the separate home-scope FK is gone).
 */
export interface ScriptLink {
  scriptId: string;
  targetType: 'character' | 'persona';
  targetId: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ScriptStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly content: ContentStore | null;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator; content?: ContentStore | null }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.content = options?.content ?? null;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  async getById(id: string): Promise<Script | null> {
    const row = await this.db.select().from(scripts).where(eq(scripts.id, id)).get();
    if (!row) return null;

    // Lazy migration: generate file if it doesn't exist on disk
    if (this.content && !row.hasFileOnDisk) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(scripts.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  async listByScope(scopeType: string, ownerId?: string): Promise<Script[]> {
    if (scopeType === 'global') {
      const rows = await this.db
        .select()
        .from(scripts)
        .where(eq(scripts.scopeType, 'global'))
        .orderBy(asc(scripts.sortOrder), asc(scripts.name))
        .all();
      return rows.map((r) => this.mapRow(r));
    }
    // Entity scope (and any legacy scope value — the 0062 collapse made
    // global/entity/chat the only reachable values): owners are `script_links`
    // rows (since migration 0107, LORE_SCRIPT_OWNERS_AS_LINKS step 1, the
    // home-owner FK columns are gone — every owner is a plain link).
    // Without an ownerId this is a BROWSE view — every entity book regardless
    // of which owners it is linked to (the editor sidebar's "entity" tab is a
    // scope filter, symmetric with the global tab). Owner views
    // (character/persona build sidebars) always pass ownerId and see exactly
    // the scripts linked to that owner through any link target type.
    if (scopeType !== 'global' && scopeType !== 'chat') {
      if (!ownerId) {
        const rows = await this.db
          .select()
          .from(scripts)
          .where(eq(scripts.scopeType, 'entity'))
          .orderBy(asc(scripts.sortOrder), asc(scripts.name))
          .all();
        return rows.map((r) => this.mapRow(r));
      }
      // A script bound to the owner through ANY link belongs to the owner's
      // view. Mirrors `LorebookStore.listLorebooksByScope`; chat scope remains
      // direct-only — script_links supports character/persona targets only,
      // same as lorebook_links.
      const linkedRows = await this.db
        .select({ scriptId: scriptLinks.scriptId })
        .from(scriptLinks)
        .where(and(inArray(scriptLinks.targetType, ['character', 'persona']), eq(scriptLinks.targetId, ownerId)))
        .all();
      const linkedIds = [...new Set(linkedRows.map((row) => row.scriptId))];
      if (linkedIds.length === 0) return [];
      const rows = await this.db
        .select()
        .from(scripts)
        .where(inArray(scripts.id, linkedIds))
        .orderBy(asc(scripts.scopeType), asc(scripts.sortOrder), asc(scripts.name))
        .all();
      return rows.map((r) => this.mapRow(r));
    }

    // Chat fallthrough is an owner view by definition — no ownerId
    // means nothing to match (chat tab without a chat context stays empty).
    if (!ownerId) return [];
    const directCondition = and(eq(scripts.scopeType, scopeType), eq(scripts.chatId, ownerId));

    const rows = await this.db
      .select()
      .from(scripts)
      .where(directCondition)
      .orderBy(asc(scripts.sortOrder), asc(scripts.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * List ALL scripts across every scope, ordered for a stable overview view.
   * Mirrors `LorebookStore.listAllLorebooks` — the read-only "All" tab needs
   * the unfiltered set, ignoring ownerId.
   */
  async listAll(): Promise<Script[]> {
    const rows = await this.db
      .select()
      .from(scripts)
      .orderBy(asc(scripts.scopeType), asc(scripts.sortOrder), asc(scripts.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateScriptData): Promise<Script> {
    // Server-idempotent creation: a duplicate creationIntentId returns the
    // existing script rather than creating a second copy. The DB unique index
    // is the race safety net; this check handles the common sequential case
    // (retry / two tabs / restart) without surfacing a constraint error.
    if (data.creationIntentId) {
      const existing = await this.db
        .select()
        .from(scripts)
        .where(eq(scripts.creationIntentId, data.creationIntentId))
        .get();
      if (existing) return this.mapRow(existing);
    }

    const id = this.idGen.next('script');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(scripts)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        code: data.code ?? '',
        enabled: (data.enabled ?? true) ? 1 : 0,
        scriptKind: data.scriptKind ?? 'prompt',
        creationIntentId: data.creationIntentId ?? null,
        scopeType: data.scopeType ?? 'entity',
        sortOrder: data.sortOrder ?? 0,
        chatId: data.chatId ?? null,
        defaultVisualId: data.defaultVisualId ?? null,
        copilotProfileId: data.copilotProfileId ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Dual-write: write canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(row!);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(scripts.id, id))
        .run();
    }

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdateScriptData): Promise<Script> {
    const now = this.clock.now();
    const values: Partial<typeof scripts.$inferInsert> = { updatedAt: now };
    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.code !== undefined) values.code = data.code;
    if (data.enabled !== undefined) values.enabled = data.enabled ? 1 : 0;
    if (data.scopeType !== undefined) values.scopeType = data.scopeType;
    if (data.sortOrder !== undefined) values.sortOrder = data.sortOrder;
    // Home-owner inputs are deliberately not mapped: the columns are gone
    // (migration 0107) and owners are links only.
    if (data.chatId !== undefined) values.chatId = data.chatId;
    if (data.defaultVisualId !== undefined) values.defaultVisualId = data.defaultVisualId;
    if (data.copilotProfileId !== undefined) values.copilotProfileId = data.copilotProfileId;
    if (data.extensions !== undefined) values.extensionsJson = JSON.stringify(data.extensions);

    const [row] = await this.db
      .update(scripts)
      .set(values)
      .where(eq(scripts.id, id))
      .returning();
    if (!row) throw new Error(`Script '${id}' not found after update`);

    // Dual-write: update canonical JSON file
    if (this.content) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(scripts.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  /** Atomically reassign a script's scope: chat keeps its 1:1 `chatId` FK
   *  (`ownerId` is null for 'global'). Since migration 0107 there are no
   *  home-owner columns to clear or keep — owner bindings are `script_links`
   *  rows, which a scope flip NEVER touches (same before and after 0107:
   *  links always survived scope transitions, and a linked script keeps
   *  participating through its link under any scope value). This remains the
   *  safe write path for the scope binding UI — unlike a raw
   *  `update({ scopeType })` it cannot leave a stale chat FK behind. */
  async setScope(id: string, scopeType: 'global' | 'entity' | 'chat', ownerId: string | null): Promise<Script> {
    const now = this.clock.now();
    const values: Partial<typeof scripts.$inferInsert> = {
      updatedAt: now,
      scopeType,
      chatId: scopeType === 'chat' ? ownerId : null,
    };
    const [row] = await this.db.update(scripts).set(values).where(eq(scripts.id, id)).returning();
    if (!row) throw new Error(`Script '${id}' not found after scope update`);
    if (this.content) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntity(STORAGE_FOLDERS.scripts, id, fileData);
      await this.db.update(scripts).set({ contentHash: hash, hasFileOnDisk: 1 }).where(eq(scripts.id, id)).run();
    }
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    // Delete file from disk
    if (this.content) {
      await this.content.deleteEntity(STORAGE_FOLDERS.scripts, id);
    }

    await this.db.delete(scripts).where(eq(scripts.id, id)).run();
  }

  // ─── Scope-aware listing (pipeline entry point) ─────────────────────────────

  /**
   * Returns all enabled PROMPT scripts visible to a chat session across all
   * scopes, sorted by sortOrder. This is the prompt-assembly resolver: it
   * excludes dice-kind scripts so the dedicated Dice VM (Wave B2) is the only
   * path that loads dice scripts. Scope resolution: global → entity links →
   * chat (migration 0107 removed the entity home FK; every owner is a
   * `script_links` row).
   *
   * Scripts run synchronously in this order — script #2 can read state from script #1.
   */
  async listAllEnabledForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Script[]> {
    return this.resolveEnabledScriptsForChat(characterId, personaId, chatId, 'prompt');
  }

  /**
   * Returns all enabled DICE scripts visible to a chat session across all
   * scopes, sorted by sortOrder. This is the Dice-VM resolver (Wave B2): it
   * excludes prompt-kind scripts. Same binding core + dedup/order as
   * {@link listAllEnabledForChat}; only the kind filter differs. A dice script
   * never enters prompt assembly, and a prompt script never reaches the Dice VM.
   */
  async listAllEnabledDiceScriptsForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Script[]> {
    return this.resolveEnabledScriptsForChat(characterId, personaId, chatId, 'dice');
  }

  /**
   * «Текущие» (LOREBOOK_LIST_FILTERS_REPORT step 2): every script that
   * participates in the chat through the SAME binding core the enabled
   * resolvers above read (`resolveChatScriptBindings` — no second rule set),
   * under attached-list semantics mirroring
   * `LorebookStore.listParticipatingForChat`: character/persona/chat-bound
   * scripts are included even while disabled (they are attached here — the
   * enabled toggle is how the author turns them on); scripts participating
   * only through the global pool are included only while enabled. Kinds:
   * prompt + dice — the two chat runtimes this binding core serves; a dice
   * script participates via the Dice VM just as a prompt script does via
   * prompt assembly. Interactive scripts are excluded: they never enter
   * either runtime and the generic scripts tab never lists them (they are
   * owned by the Experience editor). Sorted by `sortOrder`, like the
   * enabled resolvers.
   */
  async listParticipatingForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Script[]> {
    const bindings = await this.resolveChatScriptBindings(characterId, personaId, chatId);
    if (bindings.size === 0) return [];
    const rows = await this.db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, [...bindings.keys()]))
      .all();
    return rows
      .filter((r) => r.scriptKind !== 'interactive' && (r.enabled === 1 || bindings.get(r.id) === true))
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * Shared scope-aware enabled-script resolution, filtered by `kind`. The
   * binding sources come from `resolveChatScriptBindings` (the one source of
   * the chat participation rules, shared with `listParticipatingForChat`);
   * this read keeps only ENABLED rows of the requested kind. Same
   * Set-dedup + `sortOrder` ordering the pre-core resolver had.
   */
  private async resolveEnabledScriptsForChat(
    characterId: string,
    personaId: string | null,
    chatId: string,
    kind: 'prompt' | 'dice',
  ): Promise<Script[]> {
    const bindings = await this.resolveChatScriptBindings(characterId, personaId, chatId);
    if (bindings.size === 0) return [];

    const rows = await this.db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, [...bindings.keys()]))
      .all();

    return rows
      .filter((r) => r.enabled === 1 && r.scriptKind === kind)
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * Chat-binding core — the ONE source of "which scripts are bound to this
   * chat" (LOREBOOK_LIST_FILTERS_REPORT step 2), extracted from
   * `resolveEnabledScriptsForChat`. Unions FK-scoped sources (global /
   * chat-FK) with junction-linked sources (character ∪ persona links),
   * Set-deduped by id. Since migration 0107 (LORE_SCRIPT_OWNERS_AS_LINKS
   * step 1) links are the ONLY char/persona source — the entity home-FK
   * columns were copied into `script_links` and dropped.
   *
   * Enabled/kind filters are deliberately NOT applied here — which bound
   * rows survive is caller policy: the enabled resolvers keep only enabled
   * rows of their kind, while `listParticipatingForChat` keeps attached
   * rows (see its doc). Returns scriptId → bound through a NON-global
   * source (junction link or chat FK).
   */
  private async resolveChatScriptBindings(
    characterId: string,
    personaId: string | null,
    chatId: string,
  ): Promise<Map<string, boolean>> {
    const entityBoundByScriptId = new Map<string, boolean>();
    const addBinding = (scriptId: string, entityBound: boolean): void => {
      entityBoundByScriptId.set(scriptId, entityBoundByScriptId.get(scriptId) || entityBound);
    };

    // FK-scoped sources: global and chat-FK. The chat branch keeps its
    // historical OR shape (`scopeType = 'chat'` OR `chatId = :cid`) — pinned
    // as-is by lore-script-owner-links-migration.test.ts; unit 14 does not
    // touch chat binding semantics.
    const fkConditions = [
      eq(scripts.scopeType, 'global'),
      eq(scripts.scopeType, 'chat'), eq(scripts.chatId, chatId),
    ];
    const fkRows = await this.db
      .select({ id: scripts.id, scopeType: scripts.scopeType })
      .from(scripts)
      .where(or(...fkConditions))
      .all();
    for (const r of fkRows) addBinding(r.id, r.scopeType !== 'global');

    // Owner sources: junction links (character ∪ persona) — the only owner
    // source since migration 0107. Mirrors the lorebook binding core
    // (`lorebook-chat-resolution.ts`); the two resolvers stay consistent.
    const charLinkRows = await this.db
      .select({ scriptId: scriptLinks.scriptId })
      .from(scriptLinks)
      .innerJoin(scripts, eq(scriptLinks.scriptId, scripts.id))
      .where(and(eq(scriptLinks.targetType, 'character'), eq(scriptLinks.targetId, characterId)))
      .all();
    for (const r of charLinkRows) addBinding(r.scriptId, true);

    if (personaId) {
      const personaLinkRows = await this.db
        .select({ scriptId: scriptLinks.scriptId })
        .from(scriptLinks)
        .innerJoin(scripts, eq(scriptLinks.scriptId, scripts.id))
        .where(and(eq(scriptLinks.targetType, 'persona'), eq(scriptLinks.targetId, personaId)))
        .all();
      for (const r of personaLinkRows) addBinding(r.scriptId, true);
    }

    return entityBoundByScriptId;
  }

  // ─── Chat-local Dice override resolution ─────────────────────────────

  /**
   * Resolve an explicit set of script ids for a chat-local Dice override
   * (DICE_ASSIGNMENT_AND_TRAY_UX_REPORT fix 1). Fetches by id, then keeps ONLY
   * enabled dice-kind rows — disabled / deleted / non-dice / duplicate ids drop
   * silently (the override is a best-effort selection, not a hard constraint).
   * Ordered by `sortOrder` so the override list is deterministic and matches
   * the inherit resolver's ordering rather than the array's input order.
   */
  async listDiceScriptsByIds(ids: string[]): Promise<Script[]> {
    const unique = [...new Set(ids)].filter((id) => id.length > 0);
    if (unique.length === 0) return [];
    const rows = await this.db
      .select()
      .from(scripts)
      .where(and(inArray(scripts.id, unique), eq(scripts.enabled, 1), eq(scripts.scriptKind, 'dice')))
      .all();
    return rows.map((r) => this.mapRow(r)).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // ─── Link management (mirrors LorebookStore link methods) ─────────────────

  /**
   * Get all junction links for a script — its owner bindings (the only owner
   * source since migration 0107; the home-scope FK columns are gone).
   */
  async getLinks(scriptId: string): Promise<ScriptLink[]> {
    const rows = await this.db
      .select()
      .from(scriptLinks)
      .where(eq(scriptLinks.scriptId, scriptId))
      .all();
    return rows.map((r) => ({
      scriptId: r.scriptId,
      targetType: r.targetType as 'character' | 'persona',
      targetId: r.targetId,
    }));
  }

  /**
   * Replace all links for a script. Deletes existing and inserts new ones in a
   * transaction.
   */
  async setLinks(scriptId: string, links: Array<{ targetType: string; targetId: string }>): Promise<ScriptLink[]> {
    // Dedup by (targetType, targetId) BEFORE the delete: the junction table
    // has a composite PK on those columns, so a duplicate tuple in the input
    // would violate the PK on the second insert — AFTER the old set is already
    // deleted, leaving the graph empty. Normalizing first keeps the replace whole.
    const seen = new Set<string>();
    const unique: Array<{ targetType: string; targetId: string }> = [];
    for (const link of links) {
      const key = JSON.stringify([link.targetType, link.targetId]);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(link);
    }

    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 3): drizzle-orm 0.38.4
    // + bun:sqlite commits at the end of the callback's synchronous prefix, so
    // an async callback's post-await throw is never rolled back. Keeping this
    // synchronous means a failure on a later link insert rolls the delete back
    // too — the prior complete graph survives instead of being wiped to empty.
    this.db.transaction((tx) => {
      tx.delete(scriptLinks).where(eq(scriptLinks.scriptId, scriptId)).run();
      for (const link of unique) {
        tx.insert(scriptLinks).values({
          scriptId,
          targetType: link.targetType,
          targetId: link.targetId,
        }).run();
      }
    });
    return this.getLinks(scriptId);
  }

  /**
   * Add a single link (idempotent — ignores duplicates).
   */
  async addLink(scriptId: string, targetType: string, targetId: string): Promise<void> {
    await this.db.insert(scriptLinks).values({
      scriptId,
      targetType,
      targetId,
    }).onConflictDoNothing().run();
  }

  /**
   * Remove a single link.
   */
  async removeLink(scriptId: string, targetType: string, targetId: string): Promise<void> {
    await this.db.delete(scriptLinks).where(
      and(
        eq(scriptLinks.scriptId, scriptId),
        eq(scriptLinks.targetType, targetType),
        eq(scriptLinks.targetId, targetId),
      ),
    ).run();
  }

  /**
   * Reverse query — list scripts M:N-linked to a given target (character or
   * persona), regardless of the script's own scope. This is the
   * persona/character-editor view of "which scripts activate for me". Since
   * migration 0107 links are the ONLY owner source, so this and the owner
   * branch of `listByScope` read the same rows. Mirrors
   * `LorebookStore.listLorebooksLinkedToTarget`.
   */
  async listScriptsLinkedToTarget(targetType: 'character' | 'persona', targetId: string): Promise<Script[]> {
    const linkedRows = await this.db
      .select({ scriptId: scriptLinks.scriptId })
      .from(scriptLinks)
      .where(and(eq(scriptLinks.targetType, targetType), eq(scriptLinks.targetId, targetId)))
      .all();
    const linkedIds = [...new Set(linkedRows.map((row) => row.scriptId))];
    if (linkedIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, linkedIds))
      .orderBy(asc(scripts.sortOrder), asc(scripts.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  // ─── Visual bindings (script_visuals junction) ────────────────────────────

  /**
   * List the visuals bound to a script (its "skin" set). The primary
   * (`default_visual_id`) is always one of these (or null when the set is
   * empty). Order is unspecified — there is no per-binding sort column.
   */
  async getBoundVisualIds(scriptId: string): Promise<string[]> {
    const rows = await this.db
      .select({ visualId: scriptVisuals.visualId })
      .from(scriptVisuals)
      .where(eq(scriptVisuals.scriptId, scriptId))
      .all();
    return rows.map((r) => r.visualId);
  }

  /**
   * Bind a visual to a script (idempotent — ignores duplicates via the
   * composite PK). If the script has no primary yet (`default_visual_id` IS
   * NULL), this visual becomes the primary — the first bound visual is
   * auto-selected, matching the creation-wizard + built-in seed behavior, so
   * the "primary ∈ bound set" invariant holds from the first binding.
   */
  async bindVisual(scriptId: string, visualId: string): Promise<void> {
    await this.db.insert(scriptVisuals).values({ scriptId, visualId }).onConflictDoNothing().run();
    const row = await this.db
      .select({ default: scripts.defaultVisualId })
      .from(scripts)
      .where(eq(scripts.id, scriptId))
      .get();
    if (row && row.default === null) {
      await this.db
        .update(scripts)
        .set({ defaultVisualId: visualId, updatedAt: this.clock.now() })
        .where(eq(scripts.id, scriptId))
        .run();
    }
  }

  /**
   * Unbind a visual from a script (idempotent). If the unbound visual was the
   * script's primary, reassign the primary to one of the remaining bound
   * visuals (or null if none remain) so "primary ∈ bound set" still holds.
   */
  async unbindVisual(scriptId: string, visualId: string): Promise<void> {
    await this.db
      .delete(scriptVisuals)
      .where(and(eq(scriptVisuals.scriptId, scriptId), eq(scriptVisuals.visualId, visualId)))
      .run();
    const row = await this.db
      .select({ default: scripts.defaultVisualId })
      .from(scripts)
      .where(eq(scripts.id, scriptId))
      .get();
    if (row && row.default === visualId) {
      const remaining = await this.db
        .select({ visualId: scriptVisuals.visualId })
        .from(scriptVisuals)
        .where(eq(scriptVisuals.scriptId, scriptId))
        .all();
      const next = remaining[0]?.visualId ?? null;
      await this.db
        .update(scripts)
        .set({ defaultVisualId: next, updatedAt: this.clock.now() })
        .where(eq(scripts.id, scriptId))
        .run();
    }
  }

  /**
   * Reverse query — list scripts that have bound a given visual (the visual's
   * "used by" view). Mirrors `listScriptsLinkedToTarget` for the char/persona
   * junction.
   */
  async listScriptsBoundToVisual(visualId: string): Promise<Script[]> {
    const linkedRows = await this.db
      .select({ scriptId: scriptVisuals.scriptId })
      .from(scriptVisuals)
      .where(eq(scriptVisuals.visualId, visualId))
      .all();
    const ids = [...new Set(linkedRows.map((r) => r.scriptId))];
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(scripts)
      .where(inArray(scripts.id, ids))
      .orderBy(asc(scripts.sortOrder), asc(scripts.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  // ─── File payload ──────────────────────────────────────────────────────────

  private toFilePayload(row: typeof scripts.$inferSelect): Record<string, unknown> {
    return {
      name: row.name,
      description: row.description,
      code: row.code,
      enabled: row.enabled === 1,
      scriptKind: row.scriptKind,
      scopeType: row.scopeType,
      sortOrder: row.sortOrder,
      // Home owners are links since migration 0107 (columns dropped) — kept
      // null until the step-2 contract redesign removes the fields.
      characterId: null,
      personaId: null,
      chatId: row.chatId,
      extensions: JSON.parse(row.extensionsJson),
    };
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof scripts.$inferSelect): Script {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      code: row.code,
      enabled: row.enabled === 1,
      scriptKind: row.scriptKind,
      creationIntentId: row.creationIntentId,
      scopeType: row.scopeType,
      sortOrder: row.sortOrder,
      // Home owners are links since migration 0107 (columns dropped) — kept
      // null until the step-2 contract redesign removes the fields.
      characterId: null,
      personaId: null,
      chatId: row.chatId,
      defaultVisualId: row.defaultVisualId,
      copilotProfileId: row.copilotProfileId,
      extensions: JSON.parse(row.extensionsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
