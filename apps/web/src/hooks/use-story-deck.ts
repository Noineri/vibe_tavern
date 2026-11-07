import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_STORY_DECK } from "@vibe-tavern/domain";
import type { AgentPlanTask, StoryDeck } from "@vibe-tavern/api-contracts";
import {
  getAgentBranchDeck,
  playAgentBranchDeckCard,
  updateAgentBranchDeck,
} from "../api/agent-branch-deck-api.js";

/**
 * The story deck cache for one chat branch (DIRECTOR_DECK_CALENDAR_PLAN
 * DK-6) — the branch plan cache's twin (`use-agent-plan.ts`), keyed the same
 * `chatBranch:` way so the deck's consumers (the curtain's tab count, the
 * deck tab body, DK-8's proposal acceptance) share ONE entry and ONE GET per
 * branch.
 *
 * The first consumer of a branch starts its GET; further consumers subscribe
 * to that entry. The curtain mounts its tab row only while OPEN, so a chat
 * whose curtain never opened fetches nothing (no deck count exists in the
 * collapsed row). A failed GET (server down, transient 5xx) must not become
 * an unhandled rejection: the entry keeps the empty deck, loading stops
 * (one attempt per owner per process — no retry storm) and the failure is
 * logged for diagnosability — `use-agent-plan`'s exact contract.
 *
 * `refreshStoryDeck` is the DK-8 seam: the deck-proposal acceptance
 * re-runs the branch's GET through the SAME cache entry — never a second
 * fetch path, the one path re-run (`refreshAgentPlan`'s shape).
 */
interface StoryDeckCacheEntry {
  deck: StoryDeck;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  listeners: Set<() => void>;
}

const cacheByBranch = new Map<string, StoryDeckCacheEntry>();

function branchKey(chatId: string, branchId: string): string {
  return `chatBranch:${chatId}:${branchId}`;
}

function entryFor(chatId: string, branchId: string): StoryDeckCacheEntry {
  const key = branchKey(chatId, branchId);
  let entry = cacheByBranch.get(key);
  if (!entry) {
    entry = { deck: EMPTY_STORY_DECK, loaded: false, loadPromise: null, listeners: new Set() };
    cacheByBranch.set(key, entry);
  }
  return entry;
}

function notify(entry: StoryDeckCacheEntry): void {
  for (const listener of entry.listeners) listener();
}

function replaceDeck(entry: StoryDeckCacheEntry, deck: StoryDeck): void {
  entry.deck = deck;
  notify(entry);
}

function loadDeck(chatId: string, branchId: string, entry: StoryDeckCacheEntry): void {
  if (entry.loaded || entry.loadPromise) return;
  entry.loadPromise = getAgentBranchDeck(chatId, branchId)
    .then((deck) => replaceDeck(entry, deck))
    .catch((error: unknown) => {
      // A failed GET (server down, transient 5xx) keeps the empty deck and
      // stops loading — no retry storm; the deck tab surfaces the empty
      // state until `refreshStoryDeck` re-runs the GET.
      console.error(`[use-story-deck] failed to load the deck for '${branchKey(chatId, branchId)}':`, error);
    })
    .finally(() => {
      entry.loaded = true;
      entry.loadPromise = null;
      notify(entry);
    });
}

/** DK-8 seam: re-run the branch's GET through the SAME cache entry — the
 *  deck-proposal acceptance calls this after the server persisted the new
 *  cards (a GET in flight wins; its result is at least as fresh as now). */
export function refreshStoryDeck(chatId: string, branchId: string): void {
  const entry = entryFor(chatId, branchId);
  if (entry.loadPromise) return;
  entry.loaded = false;
  loadDeck(chatId, branchId, entry);
}

/**
 * The story deck of one chat branch. `null` ids (no active chat/branch —
 * the section renders nothing then) never fetch: the deck stays empty.
 *
 * `save` (the DK-7 card editor's full-replace PUT) and `play` (DK-7's draw/
 * play flow — the card leaves the deck, the plan gains the event) exist on
 * the hook from DK-6 so those units never touch the fetch seams again; both
 * replace the cache entry with the server's authoritative response.
 */
export function useStoryDeck(
  chatId: string | null,
  branchId: string | null,
): {
  deck: StoryDeck;
  save(deck: StoryDeck): Promise<StoryDeck>;
  play(cardId: string, options?: { replaceForeignGoals?: boolean }): Promise<AgentPlanTask>;
} {
  const key = chatId !== null && branchId !== null ? branchKey(chatId, branchId) : null;
  const [, setVersion] = useState(0);
  // The KEY carries the identity (effect deps), the refs carry the values
  // (call args) — the same KEY/ref split `use-agent-plan` uses (a fresh
  // string pair every render must not resubscribe).
  const idsRef = useRef<{ chatId: string | null; branchId: string | null }>({ chatId, branchId });
  idsRef.current = { chatId, branchId };
  const entry = key !== null ? entryFor(chatId as string, branchId as string) : null;

  useEffect(() => {
    const current = idsRef.current;
    if (current.chatId === null || current.branchId === null) return;
    if (branchKey(current.chatId, current.branchId) !== key) return;
    const currentEntry = entryFor(current.chatId, current.branchId);
    const listener = () => setVersion((version) => version + 1);
    currentEntry.listeners.add(listener);
    loadDeck(current.chatId, current.branchId, currentEntry);
    return () => {
      currentEntry.listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const save = useCallback(async (deck: StoryDeck): Promise<StoryDeck> => {
    const current = idsRef.current;
    if (current.chatId === null || current.branchId === null) {
      throw new Error("use-story-deck: no branch owner (no active chat/branch)");
    }
    const saved = await updateAgentBranchDeck(current.chatId, current.branchId, deck);
    replaceDeck(entryFor(current.chatId, current.branchId), saved);
    return saved;
  }, []);

  const play = useCallback(async (
    cardId: string,
    options?: { replaceForeignGoals?: boolean },
  ): Promise<AgentPlanTask> => {
    const current = idsRef.current;
    if (current.chatId === null || current.branchId === null) {
      throw new Error("use-story-deck: no branch owner (no active chat/branch)");
    }
    const result = await playAgentBranchDeckCard(current.chatId, current.branchId, cardId, options);
    replaceDeck(entryFor(current.chatId, current.branchId), result.deck);
    return result.event;
  }, []);

  return { deck: entry?.deck ?? EMPTY_STORY_DECK, save, play };
}
