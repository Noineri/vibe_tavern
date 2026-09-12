/**
 * Lorebook activation engine — pure function module.
 *
 * Takes lorebooks with entries, recent messages, activation state, and macro
 * context → returns activated entries + updated activation state.
 *
 * Supports recursive scanning: after the first pass, text from activated entries
 * is added to the scan buffer and a second pass runs to find entries whose keys
 * match activated entry content (SillyTavern-compatible).
 *
 * No DB access, no side effects. Caller is responsible for persistence.
 */

// ─── Public types ────────────────────────────────────────────────────────────

import { tag } from "@vibe-tavern/domain";
import type { LoreActivationReason } from "@vibe-tavern/domain";

// Lorebook activation is high-frequency (runs on every message send) and the
// per-entry trace is only useful when debugging activation logic. Routed
// through the tagged logger so LOG_LEVEL=info (the default) hides all of it;
// set LOG_LEVEL=debug to bring it back. Replaces raw console.debug calls that
// bypassed the level gate and spammed the console on every turn.
const logger = tag("lore");

export interface LoreActivationState {
  [entryId: string]: {
    activatedAtTurn?: number;
    lastMatchedAtTurn?: number;
    pendingDelayUntilTurn?: number;
  };
}

type ScanState = "normal" | "recursion";

export interface ActivationInput {
  lorebooks: Array<{
    id: string;
    /** Book-level group-scoring default for entries whose own flag is null (ST's global world_info_use_group_scoring, scoped to the book). See LOREBOOK_GROUP_SCORING_PARITY_REPORT (LG-4). */
    useGroupScoring?: boolean;
    scanDepth: number;
    tokenBudget: number;
    /** When non-null (0-100), override the fixed `tokenBudget` with a cap of
     * round(maxContextTokens * percent / 100). Matches SillyTavern's Context%
     * mode. See lorebook-st-parity-audit.md §1.4. */
    tokenBudgetPercent: number | null;
    recursiveScanning: boolean;
    maxRecursionSteps: number;
    includeNames: boolean;
    minActivations: number;
    minActivationsDepthMax: number;
    entries: Array<{
      id: string;
      title: string;
      content: string;
      keys: string[];
      secondaryKeys: string[];
      logic: string;
      position: string;
      depth: number;
      priority: number;
      stickyWindow: number;
      cooldownWindow: number;
      delayWindow: number;
      constant: boolean;
      probability: number;
      ignoreBudget: boolean;
      role: string;
      groupName: string;
      groupWeight: number;
      prioritizeInclusion: boolean;
      /** Tri-state (ST parity): null = inherit the book-level `useGroupScoring` default (below), true/false = explicit. */
      useGroupScoring: boolean | null;
      /** If true, this entry is skipped during recursion scan passes. */
      excludeRecursion: boolean;
      /** If true, this entry's content is NOT added to the recursion buffer. */
      preventRecursion: boolean;
      /** If truthy, this entry only activates during recursion (at or below its recursionLevel). */
      delayUntilRecursion: boolean;
      /** The recursion depth level at which a delay-until-recursion entry activates. */
      recursionLevel: number;
      scanDepthOverride: number | null;
      caseSensitive: boolean;
      matchWholeWords: boolean;
      characterFilter: Array<{ id: string | null; name: string }>;
      characterFilterExclude: boolean;
      matchSources: string[];
      enabled: boolean;
      sortOrder: number;
    }>;
  }>;
  messages: Array<{ role: string; content: string }>;
  /** Macro substitution map, e.g. { "{{user}}": "Alice", "{{char}}": "Bob" } */
  macroMap: Record<string, string>;
  /** Character id for characterFilter matching (id-bound entries). */
  characterId: string;
  /** Character name for characterFilter matching (ghost name-fallback). */
  characterName: string;
  /** Optional: character description for matchSources */
  characterDescription?: string;
  /** Optional: persona description for matchSources */
  personaDescription?: string;
  /** Optional: character personality for matchSources */
  characterPersonality?: string;
  /** Optional: character notes / depth prompt for matchSources */
  characterNote?: string;
  /** Optional: scenario for matchSources */
  scenario?: string;
  /** Optional: creator notes for matchSources */
  creatorNotes?: string;
  /** Current activation state from chat (deserialized from loreActivationStateJson) */
  activationState: LoreActivationState;
  /** Current turn number (for time window calculations) */
  currentTurn: number;
  /** Real token counter. Falls back to ceil(chars / 4) if not provided. */
  estimateTokenCount?: (text: string) => number;
  /** Max context tokens of the active model. Used only when a lorebook has
   * `tokenBudgetPercent` set (percent-of-context mode). */
  maxContextTokens?: number;
}

export interface ActivationResult {
  /** Activated entries, sorted by priority descending */
  activatedEntries: Array<{
    id: string;
    lorebookId: string;
    title: string;
    content: string;
    priority: number;
    position: string;
    depth: number;
    role: string;
    ignoreBudget: boolean;
    matchCount: number;
    matchedKeys: string[];
    /** Group-competition score (ST getScore formula — see computeGroupScore). Kept separate
     *  from matchCount, which stays a trace-only fact of the key-match activation. */
    groupScore: number;
    /** Structured reason this entry activated — surfaced in the prompt trace. */
    reason: LoreActivationReason;
  }>;
  /** Updated activation state (to persist back to chat) */
  updatedState: LoreActivationState;
}

// ─── Internal types ─────────────────────────────────────────────────────────

/** A flat entry with its source lorebook id attached. */
interface FlatEntry {
  id: string;
  lorebookId: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  constant: boolean;
  probability: number;
  ignoreBudget: boolean;
  role: string;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean;
  recursionLevel: number;
  scanDepthOverride: number | null;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  characterFilter: Array<{ id: string | null; name: string }>;
  characterFilterExclude: boolean;
  matchSources: string[];
  enabled: boolean;
  sortOrder: number;
  groupName: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  /** Tri-state (ST parity): null = inherit the book default, true/false = explicit. */
  useGroupScoring: boolean | null;
}

// ─── Main function ───────────────────────────────────────────────────────────

export function resolveActivatedEntries(input: ActivationInput): ActivationResult {
  const { macroMap, characterId, characterName, currentTurn, activationState } = input;
  const updatedState: LoreActivationState = { ...activationState };

  // Flatten all entries from all lorebooks
  const allEntries: FlatEntry[] = [];
  const scanDepths = new Map<string, number>(); // lorebookId → scanDepth
  for (const lorebook of input.lorebooks) {
    scanDepths.set(lorebook.id, lorebook.scanDepth);
    for (const entry of lorebook.entries) {
      allEntries.push({ ...entry, lorebookId: lorebook.id });
    }
  }

  // Flat-entry lookup by id (pass loops need flat flags for group survivors).
  const flatById = new Map(allEntries.map(e => [e.id, e]));

  // Collect distinct delay-until-recursion levels for ordered recursion passes
  const recursionDelayLevels = [...new Set(
    allEntries
      .filter(e => e.delayUntilRecursion)
      .map(e => e.recursionLevel || 1),
  )].sort((a, b) => a - b);

  // Check if any lorebook has recursive scanning enabled
  const anyRecursiveScanning = input.lorebooks.some(lb => lb.recursiveScanning);
  const maxSteps = Math.max(1, ...input.lorebooks.map(lb => lb.maxRecursionSteps || 0));

  // Track already activated entry ids to avoid duplicates
  const activatedIds = new Set<string>();
  // Track entries that failed probability (don't retry them)
  const failedProbabilityIds = new Set<string>();
  const activated: ActivationResult['activatedEntries'] = [];

  // Recursion buffer: text from activated entries (for recursive scanning)
  let recurseBuffer = "";

  // ── Min activations setup ──────────────────────────────────────────────
  const minActivations = Math.max(0, ...input.lorebooks.map(lb => lb.minActivations || 0));
  const depthMax = Math.max(0, ...input.lorebooks.map(lb => lb.minActivationsDepthMax || 0));
  let depthSkew = 0;

  // Book-level group-scoring defaults (per-lorebook, LG-2/LG-4) — consumed by
  // the per-pass inclusion-group pipeline below.
  const bookDefaults = new Map(input.lorebooks.map(lb => [lb.id, lb.useGroupScoring ?? false]));

  // LG-6 (ST parity): sticky-active ≙ a timed effect persisted from a PREVIOUS
  // scan. Snapshot from the INPUT state before any pass writes: an entry that
  // activates fresh THIS scan never sticky-dominates its group this scan (ST
  // records timed effects only for scan survivors, after the whole scan).
  const stickyActiveIds = new Set(
    allEntries.flatMap(e => {
      const state = activationState[e.id];
      if (e.stickyWindow > 0 && state?.activatedAtTurn != null &&
        currentTurn - state.activatedAtTurn < e.stickyWindow) {
        return [e.id];
      }
      return [];
    }),
  );

  // LG-12 (ST parity): sticky-expiry sweep — mirrors ST's scan-start
  // checkTimedEffects (world-info.js 630-655): a stored sticky effect whose
  // window has passed is removed exactly once, at the FIRST scan that
  // observes the end, and the onEnded callback hands the cooldown over to
  // that scan (a fresh full window, protected, direct assignment — 520-536;
  // cooldown suppresses everything except a live sticky, 4739). Clearing the
  // anchor makes the observation one-shot: a cleared anchor cannot re-fire,
  // and the next real activation re-anchors a fresh window (ST
  // #setTimedEffectOfType is only-if-absent, so re-activation never extends a
  // LIVE window — see commitActivationState). Runs over the input state
  // BEFORE any pass, like ST's constructor-time checkTimedEffects, so it
  // fires for every enabled entry regardless of later activation outcomes.
  for (const e of allEntries) {
    const sweepState = activationState[e.id];
    if (e.stickyWindow > 0 && sweepState?.activatedAtTurn != null &&
      currentTurn - sweepState.activatedAtTurn >= e.stickyWindow) {
      updatedState[e.id] = {
        ...sweepState,
        activatedAtTurn: undefined,
        lastMatchedAtTurn: e.cooldownWindow > 0 ? currentTurn : sweepState.lastMatchedAtTurn,
      };
    }
  }

  // ── Normal scan (with min-activations retry loop) ──────────────────────
  let normalScanRetry = true;
  while (normalScanRetry) {
    normalScanRetry = false;

    logger.debug("Pass: Normal scan — %d entries, skew=%d", allEntries.length, depthSkew);
    // LG-5: the pass first COLLECTS its candidates; the inclusion-group
    // pipeline (scoring filter → lock → override → roll) runs over THIS
    // pass's candidates, and only survivors are locked in — their ids join
    // `activatedIds` and their content seeds the recursion buffer. A group
    // loser never reaches the buffer (ST: filterByInclusionGroups runs inside
    // the scan loop, before content is appended to the recurse text).
    const passCandidates: ActivationResult["activatedEntries"] = [];
    for (const entry of allEntries) {
      if (activatedIds.has(entry.id) || failedProbabilityIds.has(entry.id)) continue;

      const result = tryActivateEntry({
        entry, macroMap, characterId, characterName, currentTurn,
        scanText: buildScanText(entry, input.messages, scanDepths, input),
        scanState: "normal",
        currentRecursionLevel: 0,
        updatedState, activatedIds,
      });
      if (result.status === "activated") {
        logger.debug("  activated: %s | title=%s | priority=%d", entry.id, entry.title, entry.priority);
        passCandidates.push(toActivatedEntry(entry, result.matchedKeys, result.matchCount, result.reason, result.groupScore));
      }
    }

    // LG-11 (ST parity, world-info.js 4881-4886): sticky-first candidate
    // ordering — governs the group pipeline's multi-group resolution order,
    // the probability gate, and the budget consumption order. Array#sort is
    // stable per spec, so the scan order survives within each tier (ST's
    // sortedEntries.indexOf tie-break).
    passCandidates.sort((a, b) => Number(stickyActiveIds.has(b.id)) - Number(stickyActiveIds.has(a.id)));
    applyInclusionGroups(passCandidates, activated, allEntries, bookDefaults, stickyActiveIds);
    let normalActivated = 0;
    for (const survivor of passCandidates) {
      // LG-11 (ST parity, verifyProbability 4909-4931): probability rolls
      // AFTER the group pipeline. Group losers never rolled. Sticky-active
      // (an effect persisted from a PREVIOUS scan — the same snapshot basis
      // ST's isEffectActive reads at roll time) auto-passes. A failure is
      // permanent for the whole resolve (ST failedProbabilityChecks) and
      // leaves the survivor's group EMPTY this pass — its competitors were
      // already removed by the filter. A prob-failed survivor seeds no
      // recursion and commits no activation state (ST records timed effects
      // for scan survivors only).
      const survivorFlat = flatById.get(survivor.id);
      if (survivorFlat && survivorFlat.probability < 100 && !stickyActiveIds.has(survivor.id)) {
        if (Math.random() * 100 >= survivorFlat.probability) {
          logger.debug("  fail %s: probability %d%% (post-group) | title=%s", survivor.id, survivorFlat.probability, survivor.title);
          failedProbabilityIds.add(survivor.id);
          continue;
        }
      }
      normalActivated++;
      activatedIds.add(survivor.id);
      activated.push(survivor);
      const flat = flatById.get(survivor.id);
      if (flat) commitActivationState(flat, survivor.reason.kind, currentTurn, updatedState);
      if (!flat?.preventRecursion) {
        recurseBuffer += survivor.content + "\n";
      }
    }

    logger.debug("Pass done: %d activated, %d total", normalActivated, activated.length);

    // Min activations retry
    if (minActivations > 0 && activated.length < minActivations && depthSkew < depthMax) {
      depthSkew++;
      logger.debug("Min activations not met (%d/%d), advancing depth to +%d", activated.length, minActivations, depthSkew);
      normalScanRetry = true;
    }
  }

  // ── Pass 2+: Recursive scans ─────────────────────────────────────────────
  if (!anyRecursiveScanning || recurseBuffer.trim().length === 0) {
    logger.debug("Recursive scanning skipped (enabled=%s, buffer=%d)", anyRecursiveScanning, recurseBuffer.trim().length);
  } else {
    logger.debug("Recursive scanning START — maxSteps=%d, delayLevels=%o", maxSteps, recursionDelayLevels);
    let loopCount = 0;
    let delayLevelIdx = 0;
    let currentRecursionLevel = recursionDelayLevels[0] ?? 1;

    while (loopCount < maxSteps) {
      loopCount++;
      logger.debug("  Recursion pass #%d — level=%d, buffer=%d chars", loopCount, currentRecursionLevel, recurseBuffer.length);
      let newActivations = 0;
      let newRecurseText = "";
      const passCandidates: ActivationResult["activatedEntries"] = [];

      for (const entry of allEntries) {
        // Skip already activated or probability-failed entries
        if (activatedIds.has(entry.id) || failedProbabilityIds.has(entry.id)) continue;

        const result = tryActivateEntry({
          entry, macroMap, characterId, characterName, currentTurn,
          // Recursion scan: combine original scan text with recurse buffer
          scanText: buildScanText(entry, input.messages, scanDepths, input) + "\n" + recurseBuffer,
          scanState: "recursion",
          currentRecursionLevel,
          updatedState, activatedIds,
        });
        if (result.status === "activated") {
          logger.debug("  [recursion] activated: %s | title=%s | priority=%d", entry.id, entry.title, entry.priority);
          passCandidates.push(toActivatedEntry(entry, result.matchedKeys, result.matchCount, result.reason, result.groupScore));
        }
      }

      // LG-5: per-pass group pipeline — losers are removed before their
      // content can seed further recursion, and groups whose winner was
      // locked by an earlier pass reject this pass's new candidates.
      // LG-11: sticky-first ordering (see the normal-scan loop above).
      passCandidates.sort((a, b) => Number(stickyActiveIds.has(b.id)) - Number(stickyActiveIds.has(a.id)));
      applyInclusionGroups(passCandidates, activated, allEntries, bookDefaults, stickyActiveIds);
      for (const survivor of passCandidates) {
        // LG-11: post-group probability gate (see the normal-scan loop above).
        const survivorFlat = flatById.get(survivor.id);
        if (survivorFlat && survivorFlat.probability < 100 && !stickyActiveIds.has(survivor.id)) {
          if (Math.random() * 100 >= survivorFlat.probability) {
            logger.debug("  fail %s: probability %d%% (post-group, recursion) | title=%s", survivor.id, survivorFlat.probability, survivor.title);
            failedProbabilityIds.add(survivor.id);
            continue;
          }
        }
        newActivations++;
        activatedIds.add(survivor.id);
        activated.push(survivor);
        const flat = flatById.get(survivor.id);
        if (flat) commitActivationState(flat, survivor.reason.kind, currentTurn, updatedState);
        if (!flat?.preventRecursion) {
          newRecurseText += survivor.content + "\n";
        }
      }

      logger.debug("  Recursion pass #%d done: %d activated", loopCount, newActivations);

      // Add new content to recurse buffer for next pass
      if (newRecurseText) {
        recurseBuffer += newRecurseText;
      }

      // Advance delay-until-recursion level if available and no new activations
      if (newActivations === 0) {
        delayLevelIdx++;
        if (delayLevelIdx < recursionDelayLevels.length) {
          currentRecursionLevel = recursionDelayLevels[delayLevelIdx];
          continue; // try again with next delay level
        }
        // No more delay levels and no new activations — stop
        break;
      }
    }
  }

  // ── Include names ────────────────────────────────────────────────────────
  // Build lorebookId → includeNames map
  const includeNamesMap = new Map(input.lorebooks.map(lb => [lb.id, lb.includeNames]));
  for (const entry of activated) {
    if (includeNamesMap.get(entry.lorebookId)) {
      entry.content = `[${entry.title}] ${entry.content}`;
    }
  }

  // (Group filtering is NOT run here anymore — LG-5 moved the inclusion-group
  // pipeline into each scan pass, right after the pass's candidates are
  // collected, matching ST's filterByInclusionGroups placement inside the
  // scan loop. Earlier-pass winners are locked and never re-resolved.)

  // Sort by sticky-first, then priority descending, then by id ascending for
  // stable ordering. The sticky tier (LG-11) makes this the BUDGET consumption
  // order: ST consumes the budget in the scan loop's sticky-first candidate
  // order (world-info.js 4881-4893 — newEntries sorted sticky-first, tie =
  // scan order which is already order-descending), so sticky survivors must
  // not lose their queue position to a plain priority sort before
  // applyTokenBudget runs. The pass-local sorts above already carry this; the
  // tier here survives the cross-pass merge (an earlier pass's non-sticky
  // winner must not consume budget ahead of a later pass's sticky survivor).
  activated.sort((a, b) =>
    Number(stickyActiveIds.has(b.id)) - Number(stickyActiveIds.has(a.id)) ||
    b.priority - a.priority ||
    a.id.localeCompare(b.id)
  );

  // Token budget per lorebook
  const budgeted = applyTokenBudget(activated, input.lorebooks, input.estimateTokenCount, input.maxContextTokens);

  logger.debug("DONE: %d entries activated, %d after budget, %d after groups", activated.length, budgeted.length, budgeted.length);

  return { activatedEntries: budgeted, updatedState };
}

// ─── Entry activation logic ─────────────────────────────────────────────────

/**
 * Try to activate a single entry. Returns:
 * - "activated" — entry was activated

 * - "skipped" — entry was skipped for any other reason
 */
type ActivationOutcome =
  | { status: "activated"; matchCount: number; matchedKeys: string[]; reason: LoreActivationReason; groupScore: number }
 
  | { status: "skipped" };

function tryActivateEntry(ctx: {
  entry: FlatEntry;
  macroMap: Record<string, string>;
  characterId: string;
  characterName: string;
  currentTurn: number;
  scanText: string;
  scanState: ScanState;
  currentRecursionLevel: number;
  updatedState: LoreActivationState;
  activatedIds: Set<string>;

}): ActivationOutcome {
  const { entry, macroMap, characterId, characterName, currentTurn, scanText, scanState, currentRecursionLevel, updatedState, activatedIds } = ctx;
  const reason = (msg: string): ActivationOutcome => { logger.debug("  skip %s: %s | title=%s", entry.id, msg, entry.title); return { status: "skipped" }; };

  if (!entry.enabled) return reason("disabled");
  if (activatedIds.has(entry.id)) return { status: "skipped" };

  // 1. Character filter
  // Option B semantics: a filter entry matches the active character if EITHER
  // its bound `id` equals the active `characterId` (rename-resilient), OR it is
  // a ghost (`id === null`) whose `name` equals the active `characterName`
  // (legacy / imported data keeps working by name until bound in the UI).
  if (entry.characterFilter.length > 0) {
    const matches = entry.characterFilter.some(
      (f) => (f.id !== null && f.id === characterId) || (f.id === null && f.name === characterName),
    );
    if (entry.characterFilterExclude ? matches : !matches) return reason("character filter");
  }

  // 3. Recursion-specific filters
  if (scanState === "recursion") {
    if (entry.excludeRecursion) return reason("exclude recursion");
    if (entry.delayUntilRecursion) {
      const entryLevel = entry.recursionLevel || 1;
      if (entryLevel > currentRecursionLevel) return reason("recursion level not reached");
    }
  } else {
    if (entry.delayUntilRecursion && !entry.constant) {
      const state = updatedState[entry.id];
      if (!(entry.stickyWindow > 0 && state?.activatedAtTurn != null &&
            currentTurn - state.activatedAtTurn < entry.stickyWindow)) {
        return reason("delayed until recursion");
      }
    }
  }

  // 3b. Decorators — @@activate / @@dont_activate at start of content
  let decoratorActive = false;
  const rawContent = entry.content.trimStart();
  if (rawContent.startsWith("@@")) {
    const firstLine = rawContent.split("\n")[0].trim();
    if (firstLine === "@@activate" || firstLine === "@@@activate") {
      decoratorActive = true;
    } else if (firstLine === "@@dont_activate" || firstLine === "@@@dont_activate") {
      return reason("@@dont_activate decorator");
    }
  }

  // 4. Constant entries — always active
  if (entry.constant) {
    const state = updatedState[entry.id];
    if (entry.cooldownWindow > 0 && state?.lastMatchedAtTurn != null) {
      const turnsSince = currentTurn - state.lastMatchedAtTurn;
      // LG-12 (ST parity, world-info.js 4739): cooldown suppresses everything
      // EXCEPT an entry with a live sticky (isCooldown && !isSticky) —
      // constants included. The sweep above has already cleared expired
      // sticky anchors, so this alive-check is exact.
      const stickyAlive = entry.stickyWindow > 0 && state?.activatedAtTurn != null &&
        currentTurn - state.activatedAtTurn < entry.stickyWindow;
      if (turnsSince < entry.cooldownWindow && !stickyAlive) return reason("cooldown");
    }
    logger.debug("  actv %s: constant | title=%s", entry.id, entry.title);
    // LG-6: the state write moved to the pass-survivor loop (see
    // commitActivationState) — group losers must not persist activation state.
    return { status: "activated", matchCount: 0, matchedKeys: [], reason: { kind: "constant" }, groupScore: scoreEntryKeysForGroup(entry, scanText, macroMap) };
  }

  // 5. Time windows — sticky check
  const state = updatedState[entry.id];
  if (entry.stickyWindow > 0 && state?.activatedAtTurn != null) {
    const turnsSinceActivation = currentTurn - state.activatedAtTurn;
    if (turnsSinceActivation < entry.stickyWindow) {
      logger.debug("  actv %s: sticky | title=%s", entry.id, entry.title);
      // LG-6: state write moved to the pass-survivor loop.
      return {
        status: "activated",
        matchCount: 0,
        matchedKeys: [],
        reason: { kind: "sticky", turnsSinceActivation, window: entry.stickyWindow },
        groupScore: 0,
      };
    }
  }

  // 6. Cooldown check
  if (entry.cooldownWindow > 0 && state?.lastMatchedAtTurn != null) {
    const turnsSince = currentTurn - state.lastMatchedAtTurn;
    if (turnsSince < entry.cooldownWindow) return reason("cooldown");
  }

  // 7. Delay check
  if (entry.delayWindow > 0 && state?.pendingDelayUntilTurn != null) {
    if (currentTurn < state.pendingDelayUntilTurn) return reason("delay pending");
    // LG-6: state write moved to the pass-survivor loop.
    return { status: "activated", matchCount: 0, matchedKeys: [], reason: { kind: "delay_fulfilled" }, groupScore: 0 };
  }

  // 8. Key matching (skip if @@activate decorator forces activation)
  let matchedKeys: string[] = [];
  let secondaryMatches: string[] = [];
  if (!decoratorActive) {
    const resolvedKeys = entry.keys.map(k => applyMacros(k, macroMap));
    const resolvedSecondaryKeys = entry.secondaryKeys.map(k => applyMacros(k, macroMap));

    matchedKeys = matchKeys(resolvedKeys, scanText, entry.caseSensitive, entry.matchWholeWords);
    if (matchedKeys.length === 0) return reason("no key match");

    // 9. Secondary key logic
    if (entry.secondaryKeys.length > 0) {
      secondaryMatches = matchKeys(resolvedSecondaryKeys, scanText, entry.caseSensitive, entry.matchWholeWords);
      if (!checkLogic(entry.logic, secondaryMatches.length, entry.secondaryKeys.length)) return reason("secondary keys fail");
    }
  } else {
    logger.debug("  actv %s: @@activate decorator | title=%s", entry.id, entry.title);
  }

  // 10. [LG-11] Probability — REMOVED from activation. ST rolls probability
  // in the scan loop AFTER the group pipeline (verifyProbability,
  // world-info.js 4909-4931): group losers never roll, a prob-failed WINNER
  // leaves its group empty, constants roll like everyone else, and
  // sticky-active auto-passes. The gate lives in the pass-survivor loops.

  // 11. Delay — if delayWindow > 0 and this is first match, set pending
  // LG-12: "never activated before" must ALSO hold for lastMatchedAtTurn —
  // the expiry sweep clears activatedAtTurn, and a cleared anchor must not
  // re-arm a delay that already ran (ST's delay is an absolute threshold,
  // never re-armed). Both-null = genuinely first-ever match.
  if (entry.delayWindow > 0 && state?.activatedAtTurn == null && state?.lastMatchedAtTurn == null) {
    updatedState[entry.id] = { pendingDelayUntilTurn: currentTurn + entry.delayWindow };
    return reason("delay window set");
  }

  // 12. Activate
  logger.debug("  actv %s: key match | title=%s", entry.id, entry.title);
  // LG-6: state write moved to the pass-survivor loop.
  return {
    status: "activated",
    matchCount: matchedKeys.length,
    matchedKeys,
    reason: decoratorActive
      ? { kind: "decorator" }
      : { kind: "key_match", matchedKeys, matchCount: matchedKeys.length, scanState },
    // Decorator: VT-specific activation, no ST counterpart to score against.
    groupScore: decoratorActive
      ? 0
      : computeGroupScore(entry.keys.length, matchedKeys.length, entry.secondaryKeys.length, secondaryMatches.length, entry.logic),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildScanText(
  entry: FlatEntry,
  messages: Array<{ role: string; content: string }>,
  scanDepths: Map<string, number>,
  input: ActivationInput,
  depthSkew = 0,
): string {
  const scanDepth = (entry.scanDepthOverride ?? (scanDepths.get(entry.lorebookId) ?? 2)) + depthSkew;
  const effectiveMessages = messages.slice(-scanDepth);
  const parts: string[] = [];
  const sources = entry.matchSources.length > 0 ? entry.matchSources : ["chat_messages"];
  if (sources.includes("chat_messages")) {
    parts.push(effectiveMessages.map(m => m.content).join("\n"));
  }
  if (sources.includes("character_desc") && input.characterDescription) {
    parts.push(input.characterDescription);
  }
  if (sources.includes("persona_desc") && input.personaDescription) {
    parts.push(input.personaDescription);
  }
  if (sources.includes("character_personality") && input.characterPersonality) {
    parts.push(input.characterPersonality);
  }
  if (sources.includes("character_note") && input.characterNote) {
    parts.push(input.characterNote);
  }
  if (sources.includes("scenario") && input.scenario) {
    parts.push(input.scenario);
  }
  if (sources.includes("creator_notes") && input.creatorNotes) {
    parts.push(input.creatorNotes);
  }
  return parts.join("\n");
}

function applyMacros(key: string, macroMap: Record<string, string>): string {
  let result = key;
  for (const [macro, value] of Object.entries(macroMap)) {
    result = result.replaceAll(macro, value);
  }
  // Also resolve case-insensitive {{USER}}, {{CHAR}}, etc.
  result = result.replace(/\{\{(\w+)\}\}/gi, (_match, name: string) => {
    const lower = name.toLowerCase();
    const resolved = macroMap[`{{${lower}}}`];
    return resolved ?? `{{${name}}}`;
  });
  return result;
}

function matchKeys(keys: string[], text: string, caseSensitive: boolean, wholeWords: boolean): string[] {
  const matched: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    // Regex pattern: /pattern/flags
    const regexMatch = key.match(/^\/(.+)\/([gimsuy]*)$/s);
    if (regexMatch) {
      try {
        const regex = new RegExp(regexMatch[1], regexMatch[2] || (caseSensitive ? "" : "i"));
        if (regex.test(text)) matched.push(key);
      } catch {
        // Invalid regex — skip
      }
      continue;
    }
    // Plain string match
    const flags = caseSensitive ? "" : "i";
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = wholeWords ? `\\b${escaped}\\b` : escaped;
    try {
      if (new RegExp(pattern, flags).test(text)) matched.push(key);
    } catch {
      // Skip invalid patterns
    }
  }
  return matched;
}

function checkLogic(logic: string, matchCount: number, totalCount: number): boolean {
  // Normalize to lowercase: the DB default and import parser use lowercase,
  // but legacy editor writes (pre-fix) stored UPPERCASE values. Treat both.
  switch (logic.toLowerCase()) {
    case "and_any": return matchCount > 0;
    case "and_all": return matchCount === totalCount;
    case "not_any": return matchCount === 0;
    case "not_all": return matchCount < totalCount;
    default: return matchCount > 0;
  }
}

/**
 * Group-competition score — SillyTavern getScore (world-info.js 428–470).
 * One point per MATCHED key (occurrences do not stack): primary matches plus
 * secondary matches per selective logic. NOT_* logic never adds secondary
 * (secondary keys are prohibitors there); AND_ALL adds them only when ALL
 * matched; AND_ANY always adds. Entries with no primary keys score 0 —
 * including constants (they compete at their real key matches, or 0).
 */
function computeGroupScore(
  numberOfPrimaryKeys: number,
  primaryScore: number,
  numberOfSecondaryKeys: number,
  secondaryScore: number,
  logic: string,
): number {
  if (numberOfPrimaryKeys === 0) return 0;
  if (numberOfSecondaryKeys > 0) {
    switch (logic) {
      case "and_any": return primaryScore + secondaryScore;
      case "and_all": return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
      default: return primaryScore; // not_any / not_all: ST falls through to primaryScore
    }
  }
  return primaryScore;
}

/** Score an entry's keys against the scan text WITHOUT any activation gate —
 *  used for constants (always active, but their group score is their real key
 *  matches, per ST where scoring runs over every activated entry). */
function scoreEntryKeysForGroup(entry: FlatEntry, scanText: string, macroMap: Record<string, string>): number {
  const resolvedKeys = entry.keys.map(k => applyMacros(k, macroMap));
  const resolvedSecondaryKeys = entry.secondaryKeys.map(k => applyMacros(k, macroMap));
  const primaryMatches = matchKeys(resolvedKeys, scanText, entry.caseSensitive, entry.matchWholeWords).length;
  const secondaryMatches = matchKeys(resolvedSecondaryKeys, scanText, entry.caseSensitive, entry.matchWholeWords).length;
  return computeGroupScore(entry.keys.length, primaryMatches, entry.secondaryKeys.length, secondaryMatches, entry.logic);
}

function toActivatedEntry(
  entry: FlatEntry,
  matchedKeys: string[],
  matchCount: number,
  reason: LoreActivationReason,
  groupScore = 0,
): ActivationResult["activatedEntries"][number] {
  return {
    id: entry.id,
    lorebookId: entry.lorebookId,
    title: entry.title,
    content: entry.content,
    priority: entry.priority,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    ignoreBudget: entry.ignoreBudget,
    matchCount,
    matchedKeys,
    groupScore,
    reason,
  };
}

/**
 * Persist activation state for a pass SURVIVOR (LG-6, ST parity).
 *
 * ST records timed effects (sticky/cooldown) only for entries that survived
 * the whole pass — setTimedEffects runs after the scan, over
 * allActivatedEntries (world-info.js 5155). Writing state at activation time
 * let group losers persist "activated" state, so a scoring loser with a
 * sticky window would auto-activate on every later scan within the window
 * despite never reaching the prompt. Writes now happen in the survivor loop,
 * preserving each activation path's original write shape: constant/sticky
 * merge over the existing state; key-match/decorator/delay-fulfilled replace
 * it. The delay-pending SETUP write stays inside tryActivateEntry
 * (delay-pending entries never become group candidates).
 */
function commitActivationState(
  entry: FlatEntry,
  reasonKind: LoreActivationReason["kind"],
  currentTurn: number,
  updatedState: LoreActivationState,
): void {
  const state = updatedState[entry.id];
  switch (reasonKind) {
    case "constant": {
      // LG-12 (ST parity): only-if-absent anchoring. ST's setTimedEffects
      // sets a sticky/cooldown effect only when none is stored
      // (#setTimedEffectOfType, world-info.js 712-730), so re-activation
      // never extends a live window. An expired sticky anchor was already
      // cleared by the sweep, and an expired cooldown anchor cannot be live
      // here (it would have suppressed this activation) — both cases anchor
      // fresh, matching ST's re-set after an effect was removed.
      const stickyAlive = entry.stickyWindow > 0 && state?.activatedAtTurn != null &&
        currentTurn - state.activatedAtTurn < entry.stickyWindow;
      const cooldownAlive = entry.cooldownWindow > 0 && state?.lastMatchedAtTurn != null &&
        currentTurn - state.lastMatchedAtTurn < entry.cooldownWindow;
      updatedState[entry.id] = {
        ...state,
        activatedAtTurn: stickyAlive ? state.activatedAtTurn : currentTurn,
        lastMatchedAtTurn: cooldownAlive ? state.lastMatchedAtTurn : currentTurn,
      };
      break;
    }
    case "sticky":
      // LG-12: the sticky anchor is alive by construction (this path only
      // runs inside its window) — keep it. The cooldown anchor is
      // only-if-absent: ST does not extend the cooldown while the sticky
      // lives; the sweep's handoff re-anchors it at the sticky end instead.
      updatedState[entry.id] = { ...state, lastMatchedAtTurn: state?.lastMatchedAtTurn ?? currentTurn };
      break;
    default: // key_match / decorator / delay_fulfilled — full replace
      // Reachable only when no sticky is alive and no cooldown is alive (the
      // gates above), so both anchors are genuinely absent or expired — a
      // fresh dual anchor matches ST's only-if-absent set exactly.
      updatedState[entry.id] = { activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
      break;
  }
}

/**
 * Inclusion group pipeline — SillyTavern's filterByInclusionGroups
 * (world-info.js 5269–5363), run PER SCAN PASS over that pass's newly
 * activated candidates (LG-5), with the ST stage order (LG-4):
 *
 *   0. Timed-effects filter (ST filterGroupsByTimedEffects, BEFORE scoring):
 *      a group with sticky-active members (a timed effect persisted from a
 *      previous scan — see the stickyActiveIds snapshot in the caller) keeps
 *      ONLY its sticky members — every non-sticky member is removed and the
 *      group is marked sticky. Sticky groups then skip stages 1–4 entirely
 *      (ST hasStickyMap): no scoring, no override, no roll, and not even the
 *      earlier-pass lock rejects the new sticky members — ALL sticky members
 *      survive together (there is no single winner). ST also removes
 *      cooldown/delay members here as belt-and-braces; in VT those entries
 *      never activate at all, so they are never candidates.
 *   1. Scoring filter (per group): qualification — any member's book default
 *      ON or any member explicitly flagged (ST: global || any entry flag).
 *      Qualifying groups drop ONLY effectively-flagged STRICT losers
 *      (score < max) — unflagged entries are immune, and max-tied entries
 *      all survive. The score is `groupScore` (ST getScore, LG-3) computed
 *      over every member including constants.
 *   2. Lock: a group whose winner was already locked by an EARLIER pass
 *      silently rejects ALL of this pass's candidates for that group (ST:
 *      "Skipping inclusion group check, group was already activated" →
 *      removeAllBut(group, null)). Lock matching is raw-string equality on
 *      the winner's full group field (ST: `x.group === key`), so a
 *      comma-group winner ("g1,g2") does NOT lock "g1" or "g2" individually
 *      — replicated ST quirk.
 *   3. Override: among the survivors, entries with prioritizeInclusion (ST:
 *      groupOverride) compete; the max priority (≙ ST max order) wins. This
 *      runs AFTER scoring — a flagged override member that already lost the
 *      score filter is gone (D4).
 *   4. Weighted random among the remaining survivors — exactly one final
 *      winner per resolved group (max-tied survivors roll, D5).
 *
 * Losers are spliced out of `passCandidates`: they are not locked in, never
 * reach the prompt, and (in the caller) never seed the recursion buffer.
 * Groups with ≤1 candidate are skipped by the roll stages, like ST — but the
 * LOCK stage still fires for them (ST checks the lock before the length
 * guard) — but never for sticky groups (ST checks hasSticky BEFORE the lock).
 */
function applyInclusionGroups(
  passCandidates: ActivationResult["activatedEntries"],
  lockedWinners: ActivationResult["activatedEntries"],
  allEntries: FlatEntry[],
  bookDefaults: Map<string, boolean>,
  stickyActiveIds: ReadonlySet<string>,
): void {
  const entryMap = new Map(allEntries.map(e => [e.id, e]));
  logger.debug("Group filter — %d pass candidates with groups", passCandidates.filter(e => entryMap.get(e.id)?.groupName).length);

  // Group this pass's candidates by group name
  const groups = new Map<string, ActivationResult["activatedEntries"]>();
  for (const entry of passCandidates) {
    const flat = entryMap.get(entry.id);
    if (!flat?.groupName) continue;
    for (const groupName of flat.groupName.split(/,\s*/).filter(Boolean)) {
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(entry);
    }
  }

  if (groups.size === 0) return;

  const removeIds = new Set<string>();
  const bookDefaultOf = (lorebookId: string) => bookDefaults.get(lorebookId) ?? false;
  const effectiveFlag = (e: ActivationResult["activatedEntries"][number]) =>
    entryMap.get(e.id)?.useGroupScoring ?? bookDefaultOf(e.lorebookId);

  // ── Pass 0 — timed-effects filter (ST: filterGroupsByTimedEffects, runs
  // BEFORE scoring). Sticky dominance: non-sticky members of a group with
  // sticky-active members are removed and the group is marked sticky; every
  // later stage bails on sticky groups (all sticky members survive).
  const stickyGroups = new Set<string>();
  for (const [groupName, groupEntries] of groups) {
    const stickyMembers = groupEntries.filter(e => stickyActiveIds.has(e.id));
    if (stickyMembers.length === 0) continue;
    stickyGroups.add(groupName);
    logger.debug(
      "  group '%s': sticky dominates — %d sticky member(s) stay, %d removed",
      groupName, stickyMembers.length, groupEntries.length - stickyMembers.length,
    );
    for (let i = groupEntries.length - 1; i >= 0; i--) {
      const e = groupEntries[i];
      if (!stickyActiveIds.has(e.id)) {
        removeIds.add(e.id);
        groupEntries.splice(i, 1);
      }
    }
  }

  // ── Pass 1 — scoring filter over EVERY group (ST: filterGroupsByScoring).
  // Removal splices ONLY this group's array (ST: `group.splice(i, 1)`): an entry
  // removed here still sits in its OTHER groups' arrays (a "ghost") and keeps
  // competing there — scoring into their maxScore and rolling in their
  // resolution. This is observable ST behavior (multi-group membership), not
  // an implementation detail.
  for (const [groupName, groupEntries] of groups) {
    if (stickyGroups.has(groupName)) continue; // sticky groups skip scoring (ST hasAnySticky)
    // Qualification mirrors ST's `!global && !group.some(x => x.useGroupScoring)
    // → skip`, generalized to per-book defaults for cross-book groups.
    const qualifies = groupEntries.some(e =>
      entryMap.get(e.id)?.useGroupScoring === true || bookDefaultOf(e.lorebookId));
    if (!qualifies) continue;

    const maxScore = Math.max(...groupEntries.map(e => e.groupScore));
    logger.debug("  group '%s': scoring filter, maxScore=%d", groupName, maxScore);
    for (let i = groupEntries.length - 1; i >= 0; i--) {
      const e = groupEntries[i];
      if (effectiveFlag(e) && e.groupScore < maxScore) {
        removeIds.add(e.id);
        groupEntries.splice(i, 1);
      }
    }
  }

  // ── Pass 2 — final resolution per group over the post-scoring arrays
  // (ST: 5284–5362). Stage order per group: LOCK → ≤1 skip → override →
  // roll. The lock fires before the length guard (a single new candidate in
  // a locked group is still removed); groups left with ≤1 candidate are
  // otherwise skipped — a lone survivor just stays (and an empty group means
  // every member lost scoring elsewhere).
  for (const [groupName, groupEntries] of groups) {
    // Sticky (ST hasAnySticky, checked BEFORE the lock): no resolution at all
    // for sticky groups — every sticky member stays, no single winner.
    if (stickyGroups.has(groupName)) continue;

    // Lock (ST: "group was already activated"): raw-string equality on the
    // earlier winner's full group field — a comma-group winner locks only
    // the exact string "g1,g2", never "g1" or "g2" alone.
    const locked = lockedWinners.some(w => entryMap.get(w.id)?.groupName === groupName);
    if (locked) {
      logger.debug("  group '%s': locked by an earlier pass — removing %d new candidate(s)", groupName, groupEntries.length);
      for (const e of groupEntries) removeIds.add(e.id);
      continue;
    }

    if (groupEntries.length <= 1) continue;

    // Override by max priority (ST: prios sorted by order desc; JS sort is
    // stable so ties keep activation order).
    const prios = groupEntries
      .filter(e => entryMap.get(e.id)?.prioritizeInclusion)
      .sort((a, b) => b.priority - a.priority);
    if (prios.length > 0) {
      logger.debug("  group '%s': override winner=%s", groupName, entryMap.get(prios[0].id)?.title);
      for (const e of groupEntries) {
        if (e !== prios[0]) removeIds.add(e.id);
      }
      continue;
    }

    // Weighted random by groupWeight among the group's members.
    const weights = groupEntries.map(e => entryMap.get(e.id)?.groupWeight ?? 100);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const roll = Math.random() * totalWeight;
    let cumWeight = 0;
    let winnerId = groupEntries[0].id;
    for (let i = 0; i < groupEntries.length; i++) {
      cumWeight += weights[i];
      if (roll <= cumWeight) { winnerId = groupEntries[i].id; break; }
    }
    for (const e of groupEntries) {
      if (e.id !== winnerId) removeIds.add(e.id);
    }
  }

  if (removeIds.size > 0) {
    const removeIdx = [...removeIds].map(id => passCandidates.findIndex(e => e.id === id)).filter(i => i >= 0);
    for (const idx of removeIdx.sort((a, b) => b - a)) passCandidates.splice(idx, 1);
  }
}

function applyTokenBudget(
  entries: ActivationResult["activatedEntries"],
  lorebooks: ActivationInput["lorebooks"],
  estimateTokenCount?: (text: string) => number,
  maxContextTokens?: number,
): ActivationResult["activatedEntries"] {
  const count = estimateTokenCount ?? ((text: string) => Math.ceil(text.length / 4));
  // Resolve each lorebook's effective budget: percent mode overrides fixed.
  const budgetPerLorebook = new Map<string, number>();
  for (const lb of lorebooks) {
    if (lb.tokenBudgetPercent != null && typeof maxContextTokens === 'number' && maxContextTokens > 0) {
      budgetPerLorebook.set(lb.id, Math.round(maxContextTokens * lb.tokenBudgetPercent / 100));
    } else {
      budgetPerLorebook.set(lb.id, lb.tokenBudget);
    }
  }
  const used = new Map<string, number>();
  return entries.filter(e => {
    if (e.ignoreBudget) return true;
    const budget = budgetPerLorebook.get(e.lorebookId);
    if (budget == null) return true;
    const current = used.get(e.lorebookId) ?? 0;
    const cost = count(e.content);
    if (current + cost > budget) return false;
    used.set(e.lorebookId, current + cost);
    return true;
  });
}
