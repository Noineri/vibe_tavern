import type { PromptLayerPosition } from "@vibe-tavern/domain";

export type { PromptLayerPosition };

/**
 * Which generation scenario this prompt assembly is for.
 *
 * - `chat`          — normal user turn (system layers + history + new user message)
 * - `continue`      — continuation without a new user message
 * - `regenerate`    — regenerating a specific message in-place
 * - `summary`       — summarization pass (only summary-relevant layers active)
 * - `tool_call`     — tool-calling pass (tool instructions active)
 * - `ai_assistant`  — AI assistant modes (script, lore, impersonate)
 */
export type AssemblyMode = "chat" | "continue" | "regenerate" | "summary" | "tool_call" | "ai_assistant";

/**
 * AI assistant operating modes.
 *
 * Each mode determines the system prompt, user message format, output parsing,
 * and which context layers are available.
 */
export type AiAssistantMode = "script" | "lore_entry" | "lore_keys" | "chat_impersonate" | "md_import";

export interface PromptLayer {
  id: string;
  sourceType: string;
  sourceId: string;
  /** Human-readable label for the trace UI (e.g. lore entry keyword, "System Prompt"). */
  sourceName: string;
  position: PromptLayerPosition;
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
  /**
   * For `in_chat` layers: number of messages from the end of the history
   * where this layer should be inserted.
   * Undefined = treat as a block placed before the history.
   */
  injectionDepth?: number;
  /**
   * Sub-position for finer ordering within the same position group.
   * Lower = earlier in the prompt. Used for ST WI Anchor compatibility
   * (e.g. after_char=10, top_an=15, author_note=20, bottom_an=25, before_examples=30).
   * Layers without subPosition sort after those with it (by priority).
   */
  subPosition?: number;
  /**
   * Stable insertion order within the same position/sub-position bucket.
   * Used for SillyTavern World Info entries where per-entry insertion_order
   * must decide final prompt order independently of lorebook/link order.
   */
  insertionOrder?: number;
  /**
   * Which {@link AssemblyMode}s this layer is active in.
   * Undefined = active in all modes (backward compat).
   */
  modes?: AssemblyMode[];
  /**
   * Message role for in_chat layers inserted into history.
   * Defaults to "system" if not specified.
   */
  role?: "system" | "user" | "assistant";
}

export interface RecentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface PromptAssemblyContext {
  identity: {
    chatId: string;
  };
  character: {
    id: string;
    name: string;
    description: string;
    scenario?: string | null;
    systemPrompt?: string | null;
    personality?: string | null;
    mesExample?: string | null;
    /** Controls when mes_example is included: "always" = every turn, "once" = first turn only, "depth" = inject at N messages from end. Defaults to "always". */
    mesExampleMode?: "always" | "once" | "depth" | "disabled" | null;
    /** When mesExampleMode is "depth": how many messages from end of history to inject. Defaults to 4. */
    mesExampleDepth?: number | null;
    postHistoryInstructions?: string | null;
    /** Character depth prompt — injected at a specific depth in chat. */
    depthPrompt?: string | null;
    depthPromptDepth?: number | null;
    depthPromptRole?: "system" | "user" | "assistant" | null;
  };
  persona?: {
    id: string;
    name: string;
    description: string;
    pronouns?: string | null;
  } | null;
  preset?: {
    id: string;
    name?: string;
    text: string;
    jailbreak?: string | null;
    summary?: string | null;
    tools?: string | null;
    prefill?: string | null;
    /** Author's note — a short blurb injected into the chat history at a specified depth. */
    authorsNote?: string | null;
    /** How many messages from the end of history to insert the author's note at. Defaults to 4. */
    authorsNoteDepth?: number | null;
    /** Where to place the author's note: in_prompt (system block), in_chat (at depth), or after_chat (depth=0). Defaults to in_chat. */
    authorsNotePosition?: "in_prompt" | "in_chat" | "after_chat" | null;
    /** Chat-completion role for Author's Note. Defaults to system, matching SillyTavern. */
    authorsNoteRole?: "system" | "user" | "assistant" | null;
    /** NSFW / jailbreak-adjacent prompt block (ST identifier: nsfw). Placed after worldInfoAfter, before chatHistory by default. */
    nsfw?: string | null;
    /** Enhance Definitions prompt (ST identifier: enhanceDefinitions). Disabled by default in ST. Placed after scenario, before nsfw. */
    enhanceDefinitions?: string | null;
    /** Custom injection blocks (advanced mode). */
    customInjections?: Array<{
      identifier?: string;
      name: string;
      content: string;
      depth: number;
      role: string;
      enabled: boolean;
      injectionPosition?: 0 | 1 | "relative" | "absolute";
      injectionOrder?: number;
      promptOrderIndex?: number;
      promptOrderPlacement?: "before_chat" | "after_chat";
    }>;
    promptOrder?: Array<{ identifier: string; enabled: boolean; order?: number; kind?: "built_in" | "custom" }>;
  } | null;
  /** Assembly mode. Defaults to `"chat"` when not specified. */
  mode?: AssemblyMode;
  /** AI assistant context. Only used when mode is "ai_assistant". */
  aiAssistant?: {
    /** Which assistant mode is active — determines system prompt, output format, etc. */
    mode: AiAssistantMode;
    /** Layer IDs the user toggled on (subset of available layers for this mode). */
    enabledLayers: string[];
    /** Current field content being edited/refined (auto-attached, not toggleable). */
    existingContent?: string;
    /** User's instruction / prompt text. */
    instruction: string;
    /** Resolved system prompt (after fallback chain: preset override → default .md). */
    systemPrompt: string;
  };
  lore?: Array<{
    id: string;
    title: string;
    content: string;
    priority: number;
    position?: string;
    /** Injection depth for at_depth position. Defaults to 4. */
    depth?: number;
    /** Message role (system, user, assistant). Defaults to system. */
    role?: string;
    /** User-defined display order within the same lorebook. Lower = earlier. */
    sortOrder?: number;
  }>;
  memory?: {
    summary?: Array<{
      id: string;
      kind: string;
      summary: string;
    }>;
    retrieval?: Array<{
      id: string;
      sourceType: string;
      content: string;
      score: number;
    }>;
  };
  chat: {
    recentMessages: RecentMessage[];
    /** Messages injected by scripts via context.chat.injectMessage() */
    scriptInjections?: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
  };
  instructions?: {
    toolInstructions?: string | null;
  };
  config?: {
    contextBudget?: number | null;
    /** Tokens reserved for the model's response. Subtracted from contextBudget during compaction. */
    responseReserve?: number;
    model?: string;
  };
}

export interface PromptAssemblyResult {
  layers: PromptLayer[];
  totalTokenEstimate: number;
  activatedLoreEntries: string[];
  usedMemoryBlocks: string[];
  /** Layers that were discarded during assembly (e.g. empty lore or memory content). */
  droppedLayers: Array<{
    id: string;
    reason: string;
  }>;
  finalPayload: Record<string, unknown>;
  /** Assistant prefill text, passed through from preset for executor use. */
  prefill?: string | null;
  /** Human-readable compaction summary for the trace UI. Not sent to the model. */
  compactionSummary?: string | null;
}
