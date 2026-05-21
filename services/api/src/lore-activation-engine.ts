/**
 * Lorebook activation engine — pure function module.
 *
 * Takes lorebooks with entries, recent messages, activation state, and macro
 * context → returns activated entries + updated activation state.
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

export interface ActivationInput {
  lorebooks: Array<{
    id: string;
    scanDepth: number;
    tokenBudget: number;
    recursiveScanning: boolean;
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
      role: string;
      group: string;
      groupWeight: number;
      prioritizeInclusion: boolean;
      excludeRecursion: boolean;
      preventRecursion: boolean;
      delayUntilRecursion: boolean;
      recursionLevel: number;
      scanDepthOverride: number | null;
      caseSensitive: boolean;
      matchWholeWords: boolean;
      characterFilter: string[];
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
  /** Character name for characterFilter matching */
  characterName: string;
  /** Optional: character description for matchSources */
  characterDescription?: string;
  /** Optional: persona description for matchSources */
  personaDescription?: string;
  /** Current activation state from chat (deserialized from loreActivationStateJson) */
  activationState: LoreActivationState;
  /** Current turn number (for time window calculations) */
  currentTurn: number;
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
    matchedKeys: string[];
  }>;
  /** Updated activation state (to persist back to chat) */
  updatedState: LoreActivationState;
}

// ─── Main function ───────────────────────────────────────────────────────────

export function resolveActivatedEntries(input: ActivationInput): ActivationResult {
  const { macroMap, characterName, mode, currentTurn, activationState } = input;
  const updatedState: LoreActivationState = { ...activationState };
  const activated: ActivationResult['activatedEntries'] = [];

  for (const lorebook of input.lorebooks) {
    const scanDepth = lorebook.scanDepth;

    for (const entry of lorebook.entries) {
      if (!entry.enabled) continue;

      // 1. Trigger filter
      if (entry.triggers.length > 0 && !entry.triggers.includes(mode)) continue;

      // 2. Character filter
      if (entry.characterFilter.length > 0) {
        const matches = entry.characterFilter.includes(characterName);
        if (entry.characterFilterExclude ? matches : !matches) continue;
      }

      // 3. Constant entries — always active
      if (entry.constant) {
        const state = updatedState[entry.id];
        if (entry.cooldownWindow > 0 && state?.lastMatchedAtTurn != null) {
          const turnsSince = currentTurn - state.lastMatchedAtTurn;
          if (turnsSince < entry.cooldownWindow) continue;
        }
        updatedState[entry.id] = { ...state, activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
        activated.push(toActivatedEntry(entry, lorebook.id, []));
        continue;
      }

      // 4. Time windows — sticky check
      const state = updatedState[entry.id];
      if (entry.stickyWindow > 0 && state?.activatedAtTurn != null) {
        const turnsSinceActivation = currentTurn - state.activatedAtTurn;
        if (turnsSinceActivation < entry.stickyWindow) {
          // Still sticky — force activate, skip probability
          updatedState[entry.id] = { ...state, lastMatchedAtTurn: currentTurn };
          activated.push(toActivatedEntry(entry, lorebook.id, []));
          continue;
        }
      }

      // 5. Cooldown check
      if (entry.cooldownWindow > 0 && state?.lastMatchedAtTurn != null) {
        const turnsSince = currentTurn - state.lastMatchedAtTurn;
        if (turnsSince < entry.cooldownWindow) continue;
      }

      // 6. Delay check
      if (entry.delayWindow > 0 && state?.pendingDelayUntilTurn != null) {
        if (currentTurn < state.pendingDelayUntilTurn) continue;
        // Delay satisfied — activate
        updatedState[entry.id] = { activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
        activated.push(toActivatedEntry(entry, lorebook.id, []));
        continue;
      }

      // 7. Build scan text based on matchSources
      const effectiveScanDepth = entry.scanDepthOverride ?? scanDepth;
      const effectiveMessages = input.messages.slice(-effectiveScanDepth);
      const parts: string[] = [];
      const sources = entry.matchSources.length > 0 ? entry.matchSources : ['chat_messages'];
      if (sources.includes('chat_messages')) {
        parts.push(effectiveMessages.map(m => m.content).join('\n'));
      }
      if (sources.includes('character_desc') && input.characterDescription) {
        parts.push(input.characterDescription);
      }
      if (sources.includes('persona_desc') && input.personaDescription) {
        parts.push(input.personaDescription);
      }
      const scanText = parts.join('\n');

      // 8. Macro resolution in keys
      const resolvedKeys = entry.keys.map(k => applyMacros(k, macroMap));
      const resolvedSecondaryKeys = entry.secondaryKeys.map(k => applyMacros(k, macroMap));

      // 9. Primary key matching
      const matchedKeys = matchKeys(resolvedKeys, scanText, entry.caseSensitive, entry.matchWholeWords);
      if (matchedKeys.length === 0) continue;

      // 10. Secondary key logic
      if (entry.secondaryKeys.length > 0) {
        const secondaryMatches = matchKeys(resolvedSecondaryKeys, scanText, entry.caseSensitive, entry.matchWholeWords);
        if (!checkLogic(entry.logic, secondaryMatches.length, entry.secondaryKeys.length)) continue;
      }

      // 11. Probability check (skip if sticky — already handled above)
      if (entry.probability < 100) {
        if (Math.random() * 100 >= entry.probability) continue;
      }

      // 12. Delay — if delayWindow > 0 and this is first match, set pending
      if (entry.delayWindow > 0 && state?.activatedAtTurn == null) {
        updatedState[entry.id] = { pendingDelayUntilTurn: currentTurn + entry.delayWindow };
        continue;
      }

      // 13. Activate
      updatedState[entry.id] = { activatedAtTurn: currentTurn, lastMatchedAtTurn: currentTurn };
      activated.push(toActivatedEntry(entry, lorebook.id, matchedKeys));
    }
  }

  // Sort by priority descending, then by id ascending for stable ordering
  activated.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  // Token budget per lorebook (simple trim)
  const budgeted = applyTokenBudget(activated, input.lorebooks);

  return { activatedEntries: budgeted, updatedState };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
        const regex = new RegExp(regexMatch[1], regexMatch[2] || (caseSensitive ? '' : 'i'));
        if (regex.test(text)) matched.push(key);
      } catch {
        // Invalid regex — skip
      }
      continue;
    }
    // Plain string match
    const flags = caseSensitive ? '' : 'i';
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  switch (logic) {
    case 'and_any': return matchCount > 0;
    case 'and_all': return matchCount === totalCount;
    case 'not_any': return matchCount === 0;
    case 'not_all': return matchCount < totalCount;
    default: return matchCount > 0;
  }
}

interface EntryLike {
  id: string;
  title: string;
  content: string;
  priority: number;
  position: string;
  depth: number;
}

function toActivatedEntry(entry: EntryLike, lorebookId: string, matchedKeys: string[]) {
  return {
    id: entry.id,
    lorebookId,
    title: entry.title,
    content: entry.content,
    priority: entry.priority,
    position: entry.position,
    depth: entry.depth,
    matchedKeys,
  };
}

function applyTokenBudget(
  entries: ActivationResult['activatedEntries'],
  lorebooks: ActivationInput['lorebooks'],
): ActivationResult['activatedEntries'] {
  // Simple implementation: rough char-to-token ratio (4 chars ≈ 1 token)
  const CHAR_PER_TOKEN = 4;
  const budgetPerLorebook = new Map<string, number>();
  for (const lb of lorebooks) {
    budgetPerLorebook.set(lb.id, lb.tokenBudget);
  }
  const used = new Map<string, number>();
  return entries.filter(e => {
    const budget = budgetPerLorebook.get(e.lorebookId);
    if (budget == null) return true;
    const current = used.get(e.lorebookId) ?? 0;
    const cost = Math.ceil(e.content.length / CHAR_PER_TOKEN);
    if (current + cost > budget) return false;
    used.set(e.lorebookId, current + cost);
    return true;
  });
}
