import type {
  CustomInjection,
  GenerationFormat,
  PromptOrderEntry,
} from "@vibe-tavern/domain";
import type {
  ActiveLoreEntriesResult,
  ChatBranchId,
  ChatId,
  LoreEntry,
  RetrievedMemoryHit,
} from "@vibe-tavern/domain";
import type { MacroVariableScope } from "@vibe-tavern/prompt-pipeline";

/**
 * The prompt-assembly resolver seam — the contract `PromptAssemblyService`
 * consumes and `StaticPromptResolver` (prompt-resolver.ts) implements.
 * Extracted from prompt-assembly-service.ts when the seam grew past that
 * file's size ratchet (SC-4c); re-exported from prompt-assembly-service.ts so
 * every existing importer keeps its path. Every method that writes persisted
 * state takes the assembly's `dryRun` — a read-only assembly must never move
 * chat state, so no implementation can silently keep persisting.
 */
export interface PromptAssemblyResolver {
  getCharacter(
    characterId: string,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
    personality?: string | null;
    mesExample?: string | null;
    mesExampleMode?: string | null;
    mesExampleDepth?: number | null;
    alternateGreetings?: string[];
    postHistoryInstructions?: string | null;
    depthPrompt?: string | null;
    depthPromptDepth?: number | null;
    depthPromptRole?: string | null;
    creatorNotes?: string | null;
    subtitle?: string;
    // Media (A7) — avatar/gallery appearance injection.
    avatarDescription?: string | null;
    includeAvatarInPrompt?: boolean;
    includeGalleryInPrompt?: boolean;
  }>;
  getPersona(
    personaId: string,
  ): Promise<{
      id: string;
      name: string;
      description: string;
      // Media (A7) — avatar appearance injection.
      avatarDescription?: string | null;
      includeAvatarInPrompt?: boolean;
    } | null>;
  getPromptPreset(
    presetId: string,
  ): Promise<{
      id: string;
      name: string;
      text: string;
      jailbreak: string;
      summary: string;
      tools: string;
      prefill: string;
      authorsNote: string;
      authorsNoteDepth: number;
      authorsNotePosition: string;
      authorsNoteRole: string;
      nsfw: string;
      enhanceDefinitions: string;
      /** Whether this preset is in advanced (canvas) mode. */
      advancedMode: boolean;
      mergeConsecutiveRoles: boolean;
      /** Generation format (LOCAL_SUPPORT_PLAN LS-3a). Absent = auto. */
      generationFormat?: GenerationFormat;
      customInjections: CustomInjection[];
      promptOrder: PromptOrderEntry[];
    } | null>;
  listActiveLoreEntries(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
    /** Assembly-derived branch messages to scan for lore activation. */
    scanMessages: Array<{ role: string; content: string }>;
    /** Effective preset Author's Note, resolved by this assembly. */
    authorsNote?: string;
    /** Enabled summary texts from the same set injected into prompt memory. */
    summaries?: string[];
    /** One-shot quiet-prompt text to scan after the global sources. */
    quietPrompt?: string;
    /** Turn clock for sticky/cooldown windows — the FULL branch message count,
     * not the post-exclusion scan count (P13 changes scan input only; timed
     * windows must not shift when the prompt excludes messages). */
    currentTurn?: number;
    /** Resolve active entries without changing branch timed state. */
    dryRun?: boolean;
    /** Max context tokens of the active model. Needed for percent-of-context
     * token-budget mode on lorebooks. Optional — when absent, percent-mode
     * lorebooks silently fall back to their fixed `tokenBudget`. */
    maxContextTokens?: number;
    /** One assembly-scoped variable namespace shared with prompt assembly. */
    macroVariableScope?: MacroVariableScope;
  }): Promise<ActiveLoreEntriesResult>;
  listRetrievedMemories(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
  }): Promise<RetrievedMemoryHit[]>;
  executeScripts(input: {
    chatId: ChatId;
    characterRecord: {
      name: string;
      personality: string | null;
      scenario: string | null;
    };
    messages: Array<{ role: string; content: string }>;
    activeLoreEntries: LoreEntry[];
    persona?: { name: string; description: string };
    /** Run scripts without persisting the updated script state (SC-4c) — the
     * assembly is a read (preview / sidechat / insight one-shot), not a chat
     * turn. Injections and character-field mutations still shape the assembly. */
    dryRun?: boolean;
  }): Promise<{
    personality: string;
    scenario: string;
    injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
    errors: Array<{ scriptId: string; scriptName: string; error: string }>;
    scriptRuns: Array<{
      scriptId: string;
      scriptName: string;
      status: 'ran' | 'errored';
      personalityMutation: string;
      scenarioMutation: string;
      injectedMessages: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
      console: Array<{ level: 'log' | 'warn' | 'error'; args: string }>;
      error?: string;
      line?: number;
    }>;
  }>;
  getToolInstructions(): string | null;
}
