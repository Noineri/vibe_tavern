import { and, eq } from 'drizzle-orm';
import { log, normalizeStoryDeck, type StoryDeck } from '@vibe-tavern/domain';
import { storyBranchDecks } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

const logger = log.tag('story-deck-store');

/** Persistence for the one story deck owned by each (chat, branch) pair
 *  (DIRECTOR_DECK_CALENDAR_PLAN DK-3) — the per-branch twin of
 *  agent-plan-store's chatBranch arm, with no script owner: decks are
 *  branch-runtime state whose rows must not outlive the branch (hard FK
 *  cascade, story_branch_decks). */
export class StoryDeckStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  /** The pair's stored deck, or null when there is no row (never saved, or
   *  cascaded away) or the row's content is unreadable. */
  async get(chatId: string, branchId: string): Promise<StoryDeck | null> {
    const row = await this.db
      .select()
      .from(storyBranchDecks)
      .where(
        and(
          eq(storyBranchDecks.chatId, chatId),
          eq(storyBranchDecks.branchId, branchId),
        ),
      )
      .get();
    if (!row) return null;

    try {
      return normalizeStoryDeck(JSON.parse(row.contentJson));
    } catch (error) {
      logger.warn(
        'get(%s/%s): malformed content_json for row %s (%s)',
        chatId,
        branchId,
        row.id,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /** Full-replace save. The unique (chat_id, branch_id) index makes this one
   *  row per pair. An EMPTY deck saves like any other — the row is KEPT with
   *  the empty content (the plan store's convention: no special empty case);
   *  GET reads it back as the empty deck, and only a missing row reads null. */
  async save(chatId: string, branchId: string, deck: StoryDeck): Promise<void> {
    const now = this.clock.now();
    const contentJson = JSON.stringify(deck);
    await this.db
      .insert(storyBranchDecks)
      .values({
        id: this.idGen.next('story_deck'),
        chatId,
        branchId,
        contentJson,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [storyBranchDecks.chatId, storyBranchDecks.branchId],
        set: {
          contentJson,
          updatedAt: now,
        },
      })
      .run();
  }
}
