import type { ChatId, MessageId } from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { EventBus } from "@vibe-tavern/domain";

// ────────────────────────────────────────────────────────────────────────────
// ChatModeStrategy — defines how a chat mode prepares and processes turns.
// ────────────────────────────────────────────────────────────────────────────
// Each mode (RP, Novel, Group, CoAuthor) implements this interface.
// The orchestrator delegates mode-specific decisions to the active strategy.
//
// Design principle: the strategy does NOT own the execution loop.
// It only provides hooks for the parts that differ between modes.
// The orchestrator still owns: provider execution, streaming, SSE, error handling.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The set of supported chat modes.
 * Stored in chat metadata, defaults to "rp" for all existing chats.
 */
export type ChatMode = "rp" | "novel" | "group" | "coauthor";

/**
 * Strategy interface for chat mode behavior.
 * Implementations decide how prompts are assembled and what happens after responses.
 */
export interface ChatModeStrategy {
  /** Which mode this strategy handles. */
  readonly mode: ChatMode;

  /**
   * Resolve which provider profile and model to use for this chat.
   * Default: use the profile/model passed by the caller.
   * Override: Group mode may select a different provider per character.
   */
  resolveProvider(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
  }): Promise<{ profile: StoredProviderProfileRecord; model: string }>;

  /**
   * Called after an assistant message is appended to the chat.
   * Use for background work (auto-summary, objective checks, etc.)
   * that should run in parallel with the user's next action.
   */
  onMessageAppended(input: {
    chatId: string;
    messageId: string;
    events: EventBus;
  }): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// RP Mode Strategy — current default behavior
// ────────────────────────────────────────────────────────────────────────────

/**
 * RP mode strategy. Pass-through for provider resolution.
 * Post-append hook is handled by EventBus subscribers (auto-summary, etc.)
 * so this strategy is intentionally minimal.
 */
export class RpModeStrategy implements ChatModeStrategy {
  readonly mode: ChatMode = "rp";

  async resolveProvider(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
  }): Promise<{ profile: StoredProviderProfileRecord; model: string }> {
    // RP mode: use whatever profile/model the caller selected
    return input;
  }

  async onMessageAppended(_input: {
    chatId: string;
    messageId: string;
    events: EventBus;
  }): Promise<void> {
    // RP mode: no additional post-append work beyond EventBus subscribers
    // (auto-summary is subscribed via events.on("message.appended") in server)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy factory
// ────────────────────────────────────────────────────────────────────────────

const strategies = new Map<ChatMode, () => ChatModeStrategy>([
  ["rp", () => new RpModeStrategy()],
]);

/**
 * Get the strategy for a given chat mode.
 * Throws if the mode is not supported.
 */
export function getChatModeStrategy(mode: ChatMode): ChatModeStrategy {
  const factory = strategies.get(mode);
  if (!factory) throw new Error(`Unsupported chat mode: ${mode}`);
  return factory();
}
