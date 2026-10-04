/**
 * Chat lorebook binding resolution — the ONE source of "which lorebooks
 * participate in a chat" (LOREBOOK_LIST_FILTERS_REPORT step 2). Extracted
 * verbatim from `LorebookStore.listAllActiveForChat` so the prompt pipeline's
 * activation read and the «Текущие» list query consume the SAME binding rules
 * with no second, route-side copy of the participation logic.
 *
 * Binding sources (unchanged from the pre-extraction resolver): the global
 * pool ∪ entity-FK homes (character OR persona column) ∪ `lorebook_links`
 * junction rows (character ∪ persona targets) ∪ chat-FK rows.
 *
 * The `enabled` flag is deliberately NOT filtered here — which bound rows
 * survive is caller policy, and the two callers differ on purpose:
 *   - the pipeline read (`LorebookStore.listAllActiveForChat`) keeps only
 *     ENABLED rows (activation semantics: a disabled book never activates);
 *   - the «Текущие» list (`LorebookStore.listParticipatingForChat`) keeps
 *     character/persona/chat-BOUND books even while disabled (they are
 *     attached to this chat — the enabled toggle is how the author turns
 *     them on) and drops books that participate only through the global
 *     pool while disabled (owner ruling, 2026-10-03).
 */
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { lorebooks, lorebookLinks } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';

export const LOREBOOK_BINDING_KIND = {
  chat: 'chat',
  persona: 'persona',
  character: 'character',
  global: 'global',
} as const;

export type LorebookBindingKind = typeof LOREBOOK_BINDING_KIND[keyof typeof LOREBOOK_BINDING_KIND];

/** One lorebook row bound to a chat, with its resolved bindings. */
export interface BoundLorebookRow {
  row: typeof lorebooks.$inferSelect;
  /** Most specific binding (chat > persona > character > global) — the
   * pipeline's per-book ordering cue, unchanged from the inline resolver. */
  bindingKind: LorebookBindingKind;
  /** True when at least one NON-global source binds this book to the chat
   * (entity-FK home, lorebook_links row, or chat FK). */
  entityBound: boolean;
}

/**
 * Resolve every lorebook bound to the chat, in the resolver's deterministic
 * order (`sortOrder`, `name`, `id`), each with its most specific binding kind.
 * Enabled-state is carried on the row for the caller's policy — see the
 * module header.
 */
export async function resolveBoundLorebookRows(
  db: AppDb,
  characterId: string,
  personaId: string | null,
  chatId: string,
): Promise<BoundLorebookRow[]> {
  // One book can match through several bindings. Preserve every matching
  // source, then select its most specific kind after loading the rows.
  const bindingKindsByLorebookId = new Map<string, Set<LorebookBindingKind>>();
  const addBinding = (lorebookId: string, bindingKind: LorebookBindingKind): void => {
    const bindingKinds = bindingKindsByLorebookId.get(lorebookId) ?? new Set<LorebookBindingKind>();
    bindingKinds.add(bindingKind);
    bindingKindsByLorebookId.set(lorebookId, bindingKinds);
  };

  // 1. Global lorebooks
  const globalRows = await db
    .select({ id: lorebooks.id })
    .from(lorebooks)
    .where(eq(lorebooks.scopeType, 'global'))
    .all();
  for (const r of globalRows) addBinding(r.id, LOREBOOK_BINDING_KIND.global);

  // 2. Entity-scoped lorebooks: FK-owned (home scope) AND junction-linked.
  //    The resolver consults BOTH — the previous junction-only query silently
  //    dropped FK-owned lorebooks because `createLorebook` does NOT mirror the
  //    FK into `lorebook_links`, so an entity-FK lorebook created the normal
  //    way was visible in editor tabs but never activated in chat.
  //    Mirrors `ScriptStore`'s chat resolver (FK ∪ junction, Set dedup).
  //    The home FK is whichever owner column is set, so one pass covers both:
  //    (characterId = :cid OR personaId = :pid) — a book M:N-bound to BOTH a
  //    character and a persona activates for a chat matching either target.
  const entityFkCondition = personaId
    ? and(eq(lorebooks.scopeType, 'entity'), or(eq(lorebooks.characterId, characterId), eq(lorebooks.personaId, personaId)))
    : and(eq(lorebooks.scopeType, 'entity'), eq(lorebooks.characterId, characterId));
  const entityFkRows = await db
    .select({ id: lorebooks.id, characterId: lorebooks.characterId, personaId: lorebooks.personaId })
    .from(lorebooks)
    .where(entityFkCondition)
    .all();
  for (const r of entityFkRows) {
    addBinding(
      r.id,
      personaId && r.personaId === personaId
        ? LOREBOOK_BINDING_KIND.persona
        : LOREBOOK_BINDING_KIND.character,
    );
  }
  const charLinks = await db
    .select({ lorebookId: lorebookLinks.lorebookId })
    .from(lorebookLinks)
    .innerJoin(lorebooks, eq(lorebookLinks.lorebookId, lorebooks.id))
    .where(and(eq(lorebookLinks.targetType, 'character'), eq(lorebookLinks.targetId, characterId)))
    .all();
  for (const r of charLinks) addBinding(r.lorebookId, LOREBOOK_BINDING_KIND.character);

  // 3. Persona junction links (target-typed, unchanged by the collapse).
  if (personaId) {
    const personaLinks = await db
      .select({ lorebookId: lorebookLinks.lorebookId })
      .from(lorebookLinks)
      .innerJoin(lorebooks, eq(lorebookLinks.lorebookId, lorebooks.id))
      .where(and(eq(lorebookLinks.targetType, 'persona'), eq(lorebookLinks.targetId, personaId)))
      .all();
    for (const r of personaLinks) addBinding(r.lorebookId, LOREBOOK_BINDING_KIND.persona);
  }

  // 4. Chat-scoped lorebooks (direct FK — not via links)
  const chatRows = await db
    .select({ id: lorebooks.id })
    .from(lorebooks)
    .where(and(eq(lorebooks.scopeType, 'chat'), eq(lorebooks.chatId, chatId)))
    .all();
  for (const r of chatRows) addBinding(r.id, LOREBOOK_BINDING_KIND.chat);

  if (bindingKindsByLorebookId.size === 0) return [];

  // Batch-load lorebooks in a stable order. This is the deterministic
  // book-resolution order used if an ST strategy needs a first bound book.
  const idArray = [...bindingKindsByLorebookId.keys()];
  const bookRows = await db
    .select()
    .from(lorebooks)
    .where(inArray(lorebooks.id, idArray))
    .orderBy(asc(lorebooks.sortOrder), asc(lorebooks.name), asc(lorebooks.id))
    .all();

  const result: BoundLorebookRow[] = [];
  for (const bookRow of bookRows) {
    const bindingKinds = bindingKindsByLorebookId.get(bookRow.id);
    const bindingKind = bindingKinds?.has(LOREBOOK_BINDING_KIND.chat)
      ? LOREBOOK_BINDING_KIND.chat
      : bindingKinds?.has(LOREBOOK_BINDING_KIND.persona)
        ? LOREBOOK_BINDING_KIND.persona
        : bindingKinds?.has(LOREBOOK_BINDING_KIND.character)
          ? LOREBOOK_BINDING_KIND.character
          : LOREBOOK_BINDING_KIND.global;
    const entityBound = bindingKinds?.has(LOREBOOK_BINDING_KIND.chat)
      || bindingKinds?.has(LOREBOOK_BINDING_KIND.persona)
      || bindingKinds?.has(LOREBOOK_BINDING_KIND.character)
      || false;
    result.push({ row: bookRow, bindingKind, entityBound });
  }
  return result;
}
