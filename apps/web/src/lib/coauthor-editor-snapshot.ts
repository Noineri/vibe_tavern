import type { AgentReviewSnapshot, ReviewOutcome, ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";

import { experienceReviewRoundId } from "./experience-copilot-review-snapshot.js";

export interface CoauthorCardReviewInput {
  base: string;
  proposed: string;
  selectedHunkIds: ReadonlySet<number>;
  hunkIds: readonly number[];
  /** A frontmatter-only profile edit has no body hunk but is still a real card proposal. */
  hasProposal: boolean;
}

export interface CoauthorLoreReviewInput {
  offeredIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  identity: string;
}

export interface CoauthorTrackerReviewInput {
  selected: boolean;
  identity: string;
}

export interface CoauthorReviewInput {
  card?: CoauthorCardReviewInput;
  lore?: CoauthorLoreReviewInput;
  tracker?: CoauthorTrackerReviewInput;
}

export interface CoauthorApplyResult {
  cardApplied: boolean;
  loreApplied: boolean;
  trackerApplied: boolean;
}

const WHOLE_CARD_CHANGE = -1;

/** Stable fallbacks keep Zustand selectors from allocating on every render. */
export const EMPTY_COAUTHOR_ACTIVITIES: CoauthorToolActivity[] = [];
export const EMPTY_COAUTHOR_CONTEXT_LINKS: ReadonlyArray<{ targetType: "character" | "persona" | "lorebook" | "script"; targetId: string }> = Object.freeze([]);

function cardIds(input: CoauthorCardReviewInput): readonly number[] {
  return input.hunkIds.length > 0 ? input.hunkIds : [WHOLE_CARD_CHANGE];
}

function cardRecord(input: CoauthorCardReviewInput, outcome: ReviewOutcome, applied: boolean): ReviewTargetRecord {
  const ids = cardIds(input);
  const selected = new Set(input.selectedHunkIds);
  if (input.hunkIds.length === 0) selected.add(WHOLE_CARD_CHANGE);
  const selectedCount = ids.filter((id) => selected.has(id)).length;
  const rejected = ids.length - selectedCount;
  const accepted = applied ? selectedCount : 0;
  return {
    target: "card",
    roundId: experienceReviewRoundId(input.base, input.proposed),
    outcome,
    hunks: { accepted, rejected, pending: applied ? 0 : selectedCount },
  };
}

function loreRecord(input: CoauthorLoreReviewInput, outcome: ReviewOutcome, applied: boolean): ReviewTargetRecord {
  const selected = input.offeredIds.filter((id) => input.selectedIds.has(id)).length;
  return {
    target: "lore",
    roundId: experienceReviewRoundId("lore", input.identity),
    outcome,
    items: { offered: input.offeredIds.length, selected, applied: applied ? selected : 0 },
  };
}

function trackerRecord(input: CoauthorTrackerReviewInput, outcome: ReviewOutcome): ReviewTargetRecord {
  return {
    target: "tracker_template",
    roundId: experienceReviewRoundId("tracker_template", input.identity),
    outcome,
    selected: input.selected,
  };
}

/** Builds live selection state. Selection is not application: every target awaits Apply or Reject. */
export function buildCoauthorAwaitingReview(input: CoauthorReviewInput): AgentReviewSnapshot {
  const targets: ReviewTargetRecord[] = [];
  if (input.card?.hasProposal) targets.push(cardRecord(input.card, "awaiting", false));
  if (input.lore) targets.push(loreRecord(input.lore, "awaiting", false));
  if (input.tracker) targets.push(trackerRecord(input.tracker, "awaiting"));
  return { targets };
}

/** Builds authoritative post-RPC records from the exact request frozen by Apply. */
export function buildCoauthorAppliedReview(input: CoauthorReviewInput, result: CoauthorApplyResult): AgentReviewSnapshot {
  const targets: ReviewTargetRecord[] = [];
  if (input.card?.hasProposal) {
    const ids = cardIds(input.card);
    const selected = input.card.hunkIds.length === 0 || ids.every((id) => input.card!.selectedHunkIds.has(id));
    targets.push(cardRecord(input.card, result.cardApplied ? (selected ? "applied" : "applied-partial") : "rejected", result.cardApplied));
  }
  if (input.lore) {
    const selected = input.lore.offeredIds.filter((id) => input.lore!.selectedIds.has(id)).length;
    targets.push(loreRecord(input.lore, result.loreApplied ? (selected === input.lore.offeredIds.length ? "applied" : "applied-partial") : "rejected", result.loreApplied));
  }
  if (input.tracker) targets.push(trackerRecord(input.tracker, result.trackerApplied ? "applied" : "rejected"));
  return { targets };
}

/** Reject is local but final: preserve the user's selections while recording no application. */
export function buildCoauthorRejectedReview(input: CoauthorReviewInput): AgentReviewSnapshot {
  const targets: ReviewTargetRecord[] = [];
  if (input.card?.hasProposal) targets.push(cardRecord(input.card, "rejected", false));
  if (input.lore) targets.push(loreRecord(input.lore, "rejected", false));
  if (input.tracker) targets.push(trackerRecord(input.tracker, "rejected"));
  return { targets };
}

export interface CoauthorEditorCard {
  name: string;
  body: string;
  greetings: string[];
  cardClean: boolean;
}

interface Holder {
  characterId: string;
  readCard: () => CoauthorEditorCard;
}

interface Ledger {
  pending: ReviewTargetRecord[];
  outcomes: Partial<Record<ReviewTargetRecord["target"], ReviewTargetRecord>>;
  superseded: ReviewTargetRecord[];
}

const holders = new Map<string, Holder>();
const ledgers = new Map<string, Ledger>();

function key(chatId: string, characterId: string): string {
  return `${chatId}\u0000${characterId}`;
}

function ledgerFor(identity: string): Ledger {
  let ledger = ledgers.get(identity);
  if (!ledger) {
    ledger = { pending: [], outcomes: {}, superseded: [] };
    ledgers.set(identity, ledger);
  }
  return ledger;
}

function replacePending(identity: string, records: readonly ReviewTargetRecord[]): void {
  const ledger = ledgerFor(identity);
  for (const record of records) {
    const prior = ledger.outcomes[record.target];
    if (prior && prior.roundId !== record.roundId) {
      ledger.superseded = [...ledger.superseded.filter((item) => item.target !== record.target), { ...prior, outcome: "superseded", supersededByRound: record.roundId }];
      delete ledger.outcomes[record.target];
    }
  }
  ledger.pending = [...records];
}

/** Registers a mounted editor. Cleanup never removes a replacement registration. */
export function registerCoauthorEditor(chatId: string, characterId: string, readCard: () => CoauthorEditorCard): () => void {
  const identity = key(chatId, characterId);
  const holder: Holder = { characterId, readCard };
  holders.set(identity, holder);
  return () => {
    if (holders.get(identity) === holder) holders.delete(identity);
  };
}

/** Keeps the registration lifecycle scoped to the currently mounted co-author form. */
export function useCoauthorEditorRegistration(
  chatId: string | null,
  characterId: string,
  enabled: boolean,
  readCard: () => CoauthorEditorCard,
): void {
  useEffect(() => {
    if (!chatId || !enabled) return;
    return registerCoauthorEditor(chatId, characterId, readCard);
  }, [chatId, characterId, enabled, readCard]);
}

/** Owns the pending-review lifecycle independently of the ephemeral turn store. */
export function useCoauthorPendingReview(
  chatId: string | null,
  characterId: string,
  enabled: boolean,
  input: CoauthorReviewInput,
): { reviewSignature: string; markResolved: (signature: string) => void } {
  const review = useMemo(() => buildCoauthorAwaitingReview(input), [input]);
  const reviewSignature = JSON.stringify(review.targets.map((target) => [target.target, target.roundId]));
  const resolvedReviewSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chatId || !enabled) return;
    if (reviewSignature === "[]") {
      resolvedReviewSignatureRef.current = null;
      publishCoauthorPendingReview(chatId, characterId, { targets: [] });
      return;
    }
    if (resolvedReviewSignatureRef.current === reviewSignature) return;
    publishCoauthorPendingReview(chatId, characterId, review);
  }, [characterId, chatId, enabled, review, reviewSignature]);
  const markResolved = useCallback((signature: string) => {
    resolvedReviewSignatureRef.current = signature;
  }, []);
  return { reviewSignature, markResolved };
}

export function publishCoauthorPendingReview(chatId: string, characterId: string, review: AgentReviewSnapshot): void {
  replacePending(key(chatId, characterId), review.targets);
}

/** Stores a successful Apply or final Reject independently of the ephemeral turn store. */
export function resolveCoauthorReview(chatId: string, characterId: string, review: AgentReviewSnapshot): void {
  const ledger = ledgerFor(key(chatId, characterId));
  for (const record of review.targets) ledger.outcomes[record.target] = record;
  ledger.pending = [];
}

/** Reads exactly the mounted editor for this chat. No holder means legacy omission. */
export function readCoauthorEditorState(chatId: string): { card: CoauthorEditorCard; review: AgentReviewSnapshot } | undefined {
  const match = [...holders.entries()].find(([identity]) => identity.startsWith(`${chatId}\u0000`));
  if (!match) return undefined;
  const [identity, holder] = match;
  const ledger = ledgerFor(identity);
  return {
    card: holder.readCard(),
    review: { targets: [...ledger.superseded, ...Object.values(ledger.outcomes), ...ledger.pending] },
  };
}

export function clearCoauthorEditorSnapshotStateForTests(): void {
  holders.clear();
  ledgers.clear();
}
