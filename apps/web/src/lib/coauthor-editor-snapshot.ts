import type { AgentReviewSnapshot, ReviewOutcome, ReviewTargetRecord } from "@vibe-tavern/api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import type { CoauthorProposal } from "./coauthor-apply-aggregate.js";
import { allEntryIds, allLorebookIds } from "./lore-selection.js";

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

/**
 * Stable empty array for the turn-store selector fallback. Returning a fresh
 * `[]` here would create a new reference every render → Zustand's `Object.is`
 * check sees a change → infinite re-render loop ("Maximum update depth").
 */
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
  const rejected = outcome === "rejected" ? ids.length : ids.length - selectedCount;
  const accepted = applied ? selectedCount : 0;
  return {
    target: "card",
    roundId: experienceReviewRoundId(input.base, input.proposed),
    outcome,
    hunks: { accepted, rejected, pending: applied || outcome === "rejected" ? 0 : selectedCount },
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

export interface CoauthorReviewSelectionInput {
  card?: { identity: string; defaults: ReadonlySet<number> };
  lore?: { identity: string; lorebookDefaults: ReadonlySet<string>; entryDefaults: ReadonlySet<string> };
  tracker?: { identity: string; defaultSelected: boolean };
}

export interface CoauthorReviewSelectionSource {
  card?: { base: string; proposed: string; hunkIds: readonly number[] };
  lore?: { identity: string; lorebookIds: ReadonlySet<string>; entryIds: ReadonlySet<string> };
  tracker?: { identity: string };
}

/** Derives compact target identities and the established wholesale defaults. */
export function buildCoauthorReviewSelectionInput(
  card: CoauthorReviewSelectionSource["card"],
  lore: CoauthorReviewSelectionSource["lore"],
  tracker: CoauthorReviewSelectionSource["tracker"],
): CoauthorReviewSelectionInput {
  return {
    card: card
      ? {
          identity: experienceReviewRoundId(card.base, card.proposed),
          defaults: new Set(card.hunkIds),
        }
      : undefined,
    lore: lore
      ? {
          identity: experienceReviewRoundId("lore", lore.identity),
          lorebookDefaults: new Set(lore.lorebookIds),
          entryDefaults: new Set(lore.entryIds),
        }
      : undefined,
    tracker: tracker
      ? { identity: experienceReviewRoundId("tracker_template", tracker.identity), defaultSelected: true }
      : undefined,
  };
}

/** Keeps the form's review identity derivation beside the retained selection lifecycle. */
export function buildCoauthorReviewSelectionInputFromProposal(
  proposal: CoauthorProposal | null,
  base: string,
  proposedBody: string,
  hunkIds: readonly number[],
): CoauthorReviewSelectionInput {
  return buildCoauthorReviewSelectionInput(
    proposal?.hasProposal && (proposal.applyRequest.profileMd !== undefined || proposal.applyRequest.firstMessage !== undefined)
      ? {
          base,
          proposed: `${proposedBody}\u0000${proposal.applyRequest.profileMd ?? ""}\u0000${JSON.stringify(proposal.applyRequest.alternateGreetings ?? [])}`,
          hunkIds,
        }
      : undefined,
    proposal?.loreBundle
      ? {
          identity: JSON.stringify(proposal.loreBundle),
          lorebookIds: allLorebookIds(proposal.loreBundle),
          entryIds: allEntryIds(proposal.loreBundle),
        }
      : undefined,
    proposal?.trackerTemplate ? { identity: JSON.stringify(proposal.trackerTemplate) } : undefined,
  );
}

interface CoauthorReviewSelections {
  card?: { identity: string; selectedIds: Set<number> };
  lore?: { identity: string; lorebookIds: Set<string>; entryIds: Set<string> };
  tracker?: { identity: string; selected: boolean };
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

interface ReviewSession {
  activities: CoauthorToolActivity[];
}

export interface CoauthorEditorSnapshotStateForTests {
  holders: Map<string, Holder>;
  ledgers: Map<string, Ledger>;
  reviewSessions: Map<string, ReviewSession>;
  reviewSelections: Map<string, CoauthorReviewSelections>;
}

const holders = new Map<string, Holder>();
const ledgers = new Map<string, Ledger>();
const reviewSessions = new Map<string, ReviewSession>();
const reviewSelections = new Map<string, CoauthorReviewSelections>();
const reviewSelectionListeners = new Map<string, Set<() => void>>();

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
    const pending = ledger.pending.find((item) => item.target === record.target);
    if (pending && pending.roundId !== record.roundId) {
      ledger.superseded = [...ledger.superseded.filter((item) => item.target !== record.target), { ...pending, outcome: "superseded", supersededByRound: record.roundId }];
    }
  }
  ledger.pending = [...records];
}

/** Retains the source proposal across the turn store's intentional early clear. */
export function publishCoauthorReviewSession(chatId: string, characterId: string, activities: readonly CoauthorToolActivity[]): void {
  reviewSessions.set(key(chatId, characterId), { activities: [...activities] });
}

/** The form rehydrates this scoped source after a clear/remount without copying it into canonical data. */
export function readCoauthorReviewSession(chatId: string | null, characterId: string): CoauthorToolActivity[] {
  if (!chatId) return EMPTY_COAUTHOR_ACTIVITIES;
  return reviewSessions.get(key(chatId, characterId))?.activities ?? EMPTY_COAUTHOR_ACTIVITIES;
}

/**
 * The send lifecycle clears its ephemeral activity store before HTTP. Retain
 * the actual source proposal outside that store so a clear/remount can still
 * render the same review and publish its awaiting selection.
 */
export function useCoauthorRetainedActivities(
  chatId: string | null,
  characterId: string,
  enabled: boolean,
  liveActivities: CoauthorToolActivity[],
): CoauthorToolActivity[] {
  const retainedActivities = readCoauthorReviewSession(chatId, characterId);
  useEffect(() => {
    if (chatId && enabled && liveActivities.length > 0) {
      publishCoauthorReviewSession(chatId, characterId, liveActivities);
    }
  }, [characterId, chatId, enabled, liveActivities]);
  return liveActivities.length > 0 ? liveActivities : retainedActivities;
}

function clearCoauthorReviewSession(chatId: string, characterId: string): void {
  reviewSessions.delete(key(chatId, characterId));
}

function notifyCoauthorReviewSelection(identity: string): void {
  for (const listener of reviewSelectionListeners.get(identity) ?? []) listener();
}

function readCoauthorReviewSelections(identity: string): CoauthorReviewSelections {
  return reviewSelections.get(identity) ?? {};
}

function writeCoauthorReviewSelections(identity: string, next: CoauthorReviewSelections): void {
  reviewSelections.set(identity, next);
  notifyCoauthorReviewSelection(identity);
}

/**
 * Preserves review choices by scoped, content-derived target identity without
 * copying proposal documents into the review metadata. Missing or replaced
 * targets read as the established wholesale defaults until a user changes them.
 */
export function useCoauthorReviewSelections(
  chatId: string | null,
  characterId: string,
  enabled: boolean,
  input: CoauthorReviewSelectionInput,
): {
  selectedHunkIds: Set<number>;
  selectedLorebookIds: Set<string>;
  selectedEntryIds: Set<string>;
  trackerTemplateSelected: boolean;
  setSelectedHunkIds: (next: Set<number> | ((previous: Set<number>) => Set<number>)) => void;
  setSelectedLorebookIds: (next: Set<string> | ((previous: Set<string>) => Set<string>)) => void;
  setSelectedEntryIds: (next: Set<string> | ((previous: Set<string>) => Set<string>)) => void;
  setTrackerTemplateSelected: (next: boolean | ((previous: boolean) => boolean)) => void;
} {
  const scope = chatId && enabled ? key(chatId, characterId) : null;
  const [, setRevision] = useState(0);
  useEffect(() => {
    if (!scope) return;
    const listeners = reviewSelectionListeners.get(scope) ?? new Set<() => void>();
    const listener = () => setRevision((revision) => revision + 1);
    listeners.add(listener);
    reviewSelectionListeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) reviewSelectionListeners.delete(scope);
    };
  }, [scope]);

  const selections = scope ? readCoauthorReviewSelections(scope) : {};
  const selectedHunkIds = input.card && selections.card?.identity === input.card.identity
    ? new Set(selections.card.selectedIds)
    : new Set(input.card?.defaults ?? []);
  const selectedLorebookIds = input.lore && selections.lore?.identity === input.lore.identity
    ? new Set(selections.lore.lorebookIds)
    : new Set(input.lore?.lorebookDefaults ?? []);
  const selectedEntryIds = input.lore && selections.lore?.identity === input.lore.identity
    ? new Set(selections.lore.entryIds)
    : new Set(input.lore?.entryDefaults ?? []);
  const trackerTemplateSelected = input.tracker && selections.tracker?.identity === input.tracker.identity
    ? selections.tracker.selected
    : input.tracker?.defaultSelected ?? false;

  const setSelectedHunkIds = useCallback((next: Set<number> | ((previous: Set<number>) => Set<number>)) => {
    if (!scope || !input.card) return;
    const current = readCoauthorReviewSelections(scope);
    const previous = current.card?.identity === input.card.identity ? new Set(current.card.selectedIds) : new Set(input.card.defaults);
    writeCoauthorReviewSelections(scope, { ...current, card: { identity: input.card.identity, selectedIds: new Set(typeof next === "function" ? next(previous) : next) } });
  }, [input.card, scope]);
  const setSelectedLorebookIds = useCallback((next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    if (!scope || !input.lore) return;
    const current = readCoauthorReviewSelections(scope);
    const previous = current.lore?.identity === input.lore.identity ? new Set(current.lore.lorebookIds) : new Set(input.lore.lorebookDefaults);
    const entryIds = current.lore?.identity === input.lore.identity ? current.lore.entryIds : input.lore.entryDefaults;
    writeCoauthorReviewSelections(scope, { ...current, lore: { identity: input.lore.identity, lorebookIds: new Set(typeof next === "function" ? next(previous) : next), entryIds: new Set(entryIds) } });
  }, [input.lore, scope]);
  const setSelectedEntryIds = useCallback((next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    if (!scope || !input.lore) return;
    const current = readCoauthorReviewSelections(scope);
    const previous = current.lore?.identity === input.lore.identity ? new Set(current.lore.entryIds) : new Set(input.lore.entryDefaults);
    const lorebookIds = current.lore?.identity === input.lore.identity ? current.lore.lorebookIds : input.lore.lorebookDefaults;
    writeCoauthorReviewSelections(scope, { ...current, lore: { identity: input.lore.identity, lorebookIds: new Set(lorebookIds), entryIds: new Set(typeof next === "function" ? next(previous) : next) } });
  }, [input.lore, scope]);
  const setTrackerTemplateSelected = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    if (!scope || !input.tracker) return;
    const current = readCoauthorReviewSelections(scope);
    const previous = current.tracker?.identity === input.tracker.identity ? current.tracker.selected : input.tracker.defaultSelected;
    writeCoauthorReviewSelections(scope, { ...current, tracker: { identity: input.tracker.identity, selected: typeof next === "function" ? next(previous) : next } });
  }, [input.tracker, scope]);

  return { selectedHunkIds, selectedLorebookIds, selectedEntryIds, trackerTemplateSelected, setSelectedHunkIds, setSelectedLorebookIds, setSelectedEntryIds, setTrackerTemplateSelected };
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
export function resolveCoauthorReview(
  chatId: string,
  characterId: string,
  review: AgentReviewSnapshot,
  options: { clearSession?: boolean } = {},
): void {
  const ledger = ledgerFor(key(chatId, characterId));
  const selections = readCoauthorReviewSelections(key(chatId, characterId));
  const nextSelections = { ...selections };
  for (const record of review.targets) {
    const newer = ledger.pending.find((pending) => pending.target === record.target && pending.roundId !== record.roundId);
    if (newer) {
      ledger.superseded = [
        ...ledger.superseded.filter((item) => item.target !== record.target),
        { ...record, outcome: "superseded", supersededByRound: newer.roundId },
      ];
    } else {
      ledger.outcomes[record.target] = record;
    }
    ledger.pending = ledger.pending.filter((pending) => pending.target !== record.target || pending.roundId !== record.roundId);
    if (record.target === "card" && selections.card?.identity === record.roundId) delete nextSelections.card;
    if (record.target === "lore" && selections.lore?.identity === record.roundId) delete nextSelections.lore;
    if (record.target === "tracker_template" && selections.tracker?.identity === record.roundId) delete nextSelections.tracker;
  }
  if (Object.keys(nextSelections).length === 0) reviewSelections.delete(key(chatId, characterId));
  else reviewSelections.set(key(chatId, characterId), nextSelections);
  if (options.clearSession !== false) clearCoauthorReviewSession(chatId, characterId);
}

/**
 * Settles the Apply lifecycle against the exact activity array captured at
 * request start. A missing current turn is the normal send-boundary clear for
 * that same review; a different current array belongs to a newer proposal.
 */
export function settleCoauthorAppliedReview(
  chatId: string,
  characterId: string,
  originActivities: CoauthorToolActivity[],
  review: AgentReviewSnapshot,
): void {
  const currentTurn = useCoauthorTurnStore.getState().turnsByChat[chatId];
  const originTurnWasReplaced = currentTurn !== undefined && currentTurn !== originActivities;
  resolveCoauthorReview(chatId, characterId, review, { clearSession: !originTurnWasReplaced });
  if (currentTurn === originActivities) {
    useCoauthorTurnStore.getState().clearTurn(chatId);
  } else if (currentTurn) {
    // A newer same-chat proposal owns the retained source from now on. Keeping
    // the origin here would make its stale overlay reappear after that newer
    // turn is later cleared for an ordinary send.
    publishCoauthorReviewSession(chatId, characterId, currentTurn);
  }
}

/** Reads exactly the mounted active editor. A mismatched scope means legacy omission. */
export function readCoauthorEditorState(chatId: string, characterId: string): { card: CoauthorEditorCard; review: AgentReviewSnapshot } | undefined {
  const identity = key(chatId, characterId);
  const holder = holders.get(identity);
  if (!holder) return undefined;
  const ledger = ledgerFor(identity);
  return {
    card: holder.readCard(),
    review: { targets: [...ledger.superseded, ...Object.values(ledger.outcomes), ...ledger.pending] },
  };
}

export function clearCoauthorEditorSnapshotStateForTests(): void {
  holders.clear();
  ledgers.clear();
  reviewSessions.clear();
  reviewSelections.clear();
}

/** Test-only worker-state seam: suites restore rather than leak a naked reset. */
export function snapshotCoauthorEditorSnapshotStateForTests(): CoauthorEditorSnapshotStateForTests {
  return {
    holders: new Map(holders),
    ledgers: new Map(ledgers),
    reviewSessions: new Map(reviewSessions),
    reviewSelections: new Map(reviewSelections),
  };
}

/** Restores the exact module-held state captured before a test suite changed it. */
export function restoreCoauthorEditorSnapshotStateForTests(snapshot: CoauthorEditorSnapshotStateForTests): void {
  holders.clear();
  ledgers.clear();
  reviewSessions.clear();
  reviewSelections.clear();
  for (const [identity, holder] of snapshot.holders) holders.set(identity, holder);
  for (const [identity, ledger] of snapshot.ledgers) ledgers.set(identity, ledger);
  for (const [identity, session] of snapshot.reviewSessions) reviewSessions.set(identity, session);
  for (const [identity, selections] of snapshot.reviewSelections) reviewSelections.set(identity, selections);
}
