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
    scanDepth: number;
    tokenBudget: number;
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
      useGroupScoring: boolean;
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
      triggers: string[];
      matchSources: string[];
      enabled: boolean;
      sortOrder: number;
    }>;
  }>;
  messages: Array<{ role: string; content: string }>;
  /** Current assembly mode: "normal" | "continue" | "regenerate" | "summary" | "tool_call" */
  mode: string;
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
  triggers: string[];
  matchSources: string[];
  enabled: boolean;
  sortOrder: number;
  groupName: string;
  groupWeight: number;
  prioritizeInclusion: boolean;
  useGroupScoring: boolean;
}

// ─── Main function ───────────────────────────────────────────────────────────

export function resolveActivatedEntries(input: ActivationInput): ActivationResult {
  const { macroMap, characterId, characterName, mode, currentTurn, activationState } = input;
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

  // ── Normal scan (with min-activations retry loop) ──────────────────────
  let normalScanRetry = true;
  while (normalScanRetry) {
    normalScanRetry = false;

    console.debug("[lore] Pass: Normal scan — %d entries, skew=%d", allEntries.length, depthSkew);
    let normalActivated = 0;
    for (const entry of allEntries) {
      if (activatedIds.has(entry.id) || failedProbabilityIds.has(entry.id)) continue;

      const result = tryActivateEntry({
      entry, macroMap, characterId, characterName, mode, currentTurn,
      scanText: buildScanText(entry, input.messages, scanDepths, input),
      scanState: "normal",
      currentRecursionLevel: 0,
      updatedState, activatedIds, failedProbabilityIds,
    });
    if (result.status === "activated") {
      normalActivated++;
      console.debug("[lore]   activated: %s | title=%s | priority=%d", entry.id, entry.title, entry.priority);
      activatedIds.add(entry.id);
      activated.push(toActivatedEntry(entry, result.matchedKeys, result.matchCount));
      if (!entry.preventRecursion) {
        recurseBuffer += entry.content + "\n";
      }
    } else if (result.status === "failed_probability") {
      failedProbabilityIds.add(entry.id);
    }
    }

	console.debug("[lore] Pass done: %d activated, %d total", normalActivated, activated.length);

    // Min activations retry
    if (minActivations > 0 && activated.length < minActivations && depthSkew < depthMax) {
      depthSkew++;
      console.debug("[lore] Min activations not met (%d/%d), advancing depth to +%d", activated.length, minActivations, depthSkew);
      normalScanRetry = true;
    }
  }

  // ── Pass 2+: Recursive scans ─────────────────────────────────────────────
  if (!anyRecursiveScanning || recurseBuffer.trim().length === 0) {
    console.debug("[lore] Recursive scanning skipped (enabled=%s, buffer=%d)", anyRecursiveScanning, recurseBuffer.trim().length);
  } else {
    console.debug("[lore] Recursive scanning START — maxSteps=%d, delayLevels=%o", maxSteps, recursionDelayLevels);
    let loopCount = 0;
    let delayLevelIdx = 0;
    let currentRecursionLevel = recursionDelayLevels[0] ?? 1;

    while (loopCount < maxSteps) {
      loopCount++;
      console.debug("[lore]   Recursion pass #%d — level=%d, buffer=%d chars", loopCount, currentRecursionLevel, recurseBuffer.length);
      let newActivations = 0;
      let newRecurseText = "";

      for (const entry of allEntries) {
        // Skip already activated or probability-failed entries
        if (activatedIds.has(entry.id) || failedProbabilityIds.has(entry.id)) continue;

        const result = tryActivateEntry({
          entry, macroMap, characterId, characterName, mode, currentTurn,
          // Recursion scan: combine original scan text with recurse buffer
          scanText: buildScanText(entry, input.messages, scanDepths, input) + "\n" + recurseBuffer,
          scanState: "recursion",
          currentRecursionLevel,
          updatedState, activatedIds, failedProbabilityIds,
        });
        if (result.status === "activated") {
          console.debug("[lore]   [recursion] activated: %s | title=%s | priority=%d", entry.id, entry.title, entry.priority);
          activatedIds.add(entry.id);
          activated.push(toActivatedEntry(entry, result.matchedKeys, result.matchCount));
          newActivations++;
          if (!entry.preventRecursion) {
            newRecurseText += entry.content + "\n";
          }
        } else if (result.status === "failed_probability") {
          failedProbabilityIds.add(entry.id);
        }
      }

      console.debug("[lore]   Recursion pass #%d done: %d activated", loopCount, newActivations);

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

  // ── Group filter ─────────────────────────────────────────────────────────
  // Entries in the same group compete: only the highest-priority (or weighted random) winner stays.
  applyInclusionGroups(activated, allEntries);

  // Sort by priority descending, then by id ascending for stable ordering
  activated.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  // Token budget per lorebook
  const budgeted = applyTokenBudget(activated, input.lorebooks, input.estimateTokenCount);

  console.debug("[lore] DONE: %d entries activated, %d after budget, %d after groups", activated.length, budgeted.length, budgeted.length);

  return { activatedEntries: budgeted, updatedState };
}

// ─── Entry activation logic ─────────────────────────────────────────────────

/**
 * Try to activate a single entry. Returns:
 * - "activated" — entry was activated
 * - "failed_probability" — probability check failed (don't retry)
 * - "skipped" — entry was skipped for any other reason
 */
type ActivationOutcome =
  | { status: "activated"; matchCount: number; matchedKeys: string[] }
  | { status: "failed_probability" }
  | { status: "skipped" };

function tryActivateEntry(ctx: {
  entry: FlatEntry;
  macroMap: Record<string, string>;
  characterId: string;
  characterName: string;
  mode: string;
  currentTurn: number;
  scanText: string;
  scanState: ScanState;
  currentRecursionLevel: number;
  updatedState: LoreActivationState;
  activatedIds: Set<string>;
  failedProbabilityIds: Set<string>;
}): ActivationOutcome {
  const { entry, macroMap, characterId, characterName, mode, currentTurn, scanText, scanState, currentRecursionLevel, updatedState, activatedIds } = ctx;
  const reason = (msg: string): ActivationOutcome => { console.debug("[lore]   skip %s: %s | title=%s", entry.id, msg, entry.title); return { status: "skipped" }; };

  if (!entry.enabled) return reason("disabled");
  if (activatedIds.has(entry.id)) return { status: "skipped" };

  // 1. Trigger filter
  if (entry.triggers.length > 0 && !entry.triggers.includes(mode)) return reason("trigger filter");

  // 2. Character filter
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
      if (turnsSince < entry.cooldownWindow) return reason("cooldown");
    }
    console.debug("[lore]   actv %s: constant | title=%s", entry.id, entry.title);
    updatedState[entry.id] = { ...state, activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
    return { status: "activated", matchCount: 0, matchedKeys: [] };
  }

  // 5. Time windows — sticky check
  const state = updatedState[entry.id];
  if (entry.stickyWindow > 0 && state?.activatedAtTurn != null) {
    const turnsSinceActivation = currentTurn - state.activatedAtTurn;
    if (turnsSinceActivation < entry.stickyWindow) {
      console.debug("[lore]   actv %s: sticky | title=%s", entry.id, entry.title);
      updatedState[entry.id] = { ...state, lastMatchedAtTurn: currentTurn };
      return { status: "activated", matchCount: 0, matchedKeys: [] };
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
    updatedState[entry.id] = { activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
    return { status: "activated", matchCount: 0, matchedKeys: [] };
  }

  // 8. Key matching (skip if @@activate decorator forces activation)
  let matchedKeys: string[] = [];
  if (!decoratorActive) {
    const resolvedKeys = entry.keys.map(k => applyMacros(k, macroMap));
    const resolvedSecondaryKeys = entry.secondaryKeys.map(k => applyMacros(k, macroMap));

    matchedKeys = matchKeys(resolvedKeys, scanText, entry.caseSensitive, entry.matchWholeWords);
    if (matchedKeys.length === 0) return reason("no key match");

    // 9. Secondary key logic
    if (entry.secondaryKeys.length > 0) {
      const secondaryMatches = matchKeys(resolvedSecondaryKeys, scanText, entry.caseSensitive, entry.matchWholeWords);
      if (!checkLogic(entry.logic, secondaryMatches.length, entry.secondaryKeys.length)) return reason("secondary keys fail");
    }
  } else {
    console.debug("[lore]   actv %s: @@activate decorator | title=%s", entry.id, entry.title);
  }

  // 10. Probability check
  if (entry.probability < 100) {
    if (Math.random() * 100 >= entry.probability) {
      console.debug("[lore]   fail %s: probability %d%% | title=%s", entry.id, entry.probability, entry.title);
      return { status: "failed_probability" };
    }
  }

  // 11. Delay — if delayWindow > 0 and this is first match, set pending
  if (entry.delayWindow > 0 && state?.activatedAtTurn == null) {
    updatedState[entry.id] = { pendingDelayUntilTurn: currentTurn + entry.delayWindow };
    return reason("delay window set");
  }

  // 12. Activate
  console.debug("[lore]   actv %s: key match | title=%s", entry.id, entry.title);
  updatedState[entry.id] = { activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
  return { status: "activated", matchCount: matchedKeys.length, matchedKeys };
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

function toActivatedEntry(entry: FlatEntry, matchedKeys: string[], matchCount: number): ActivationResult["activatedEntries"][number] {
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
  };
}

/**
 * Inclusion group filter (SillyTavern-compatible).
 *
 * Entries sharing the same `group` compete against each other:
 * 1. If a group has an entry with `prioritizeInclusion`, it wins automatically.
 * 2. Otherwise, weighted random selection based on `groupWeight`.
 * 3. Entries without a group are unaffected.
 */
function applyInclusionGroups(
  activated: ActivationResult["activatedEntries"],
  allEntries: FlatEntry[],
): void {
  const entryMap = new Map(allEntries.map(e => [e.id, e]));
  console.debug("[lore] Group filter — %d activated entries with groups", activated.filter(e => entryMap.get(e.id)?.groupName).length);

  // Group activated entries by group name
  const groups = new Map<string, ActivationResult["activatedEntries"]>();
  for (const entry of activated) {
    const flat = entryMap.get(entry.id);
    if (!flat?.groupName) continue;
    for (const groupName of flat.groupName.split(/,\s*/).filter(Boolean)) {
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(entry);
    }
  }

  if (groups.size === 0) return;

  const removeIds = new Set<string>();

  for (const [groupName, groupEntries] of groups) {
    if (groupEntries.length <= 1) continue;

    // prioritizeInclusion (ST: groupOverride) → auto-wins
    const prioWinner = groupEntries.find(e => entryMap.get(e.id)?.prioritizeInclusion);
    if (prioWinner) {
      console.debug("[lore]   group '%s': prio winner=%s, removing %d others", groupName, entryMap.get(prioWinner.id)?.title, groupEntries.length - 1);
      for (const e of groupEntries) {
        if (e.id !== prioWinner.id) removeIds.add(e.id);
      }
      continue;
    }

    // useGroupScoring — highest matchCount wins (NOT total keys.length;
    // the previous implementation scored on the entry's total key count,
    // which let a 10-key entry with zero matches beat a 2-key entry with both
    // matched. matchCount is carried on the activated entry via toActivatedEntry.)
    const anyGroupScoring = groupEntries.some(e => entryMap.get(e.id)?.useGroupScoring);
    if (anyGroupScoring) {
      const maxScore = Math.max(...groupEntries.map(e => e.matchCount));
      console.debug("[lore]   group '%s': score-based, maxScore=%d", groupName, maxScore);
      let foundWinner = false;
      for (const e of groupEntries) {
        if (!foundWinner && e.matchCount >= maxScore) {
          foundWinner = true;
        } else {
          removeIds.add(e.id);
        }
      }
      continue;
    }

    // Weighted random by groupWeight
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
    const removeIdx = [...removeIds].map(id => activated.findIndex(e => e.id === id)).filter(i => i >= 0);
    for (const idx of removeIdx.sort((a, b) => b - a)) activated.splice(idx, 1);
  }
}

function applyTokenBudget(
  entries: ActivationResult["activatedEntries"],
  lorebooks: ActivationInput["lorebooks"],
  estimateTokenCount?: (text: string) => number,
): ActivationResult["activatedEntries"] {
  const count = estimateTokenCount ?? ((text: string) => Math.ceil(text.length / 4));
  const budgetPerLorebook = new Map<string, number>();
  for (const lb of lorebooks) {
    budgetPerLorebook.set(lb.id, lb.tokenBudget);
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
