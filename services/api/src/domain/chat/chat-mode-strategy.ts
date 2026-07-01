import type { ChatId, CharacterId, ChatBranchId, MessageId } from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { EventBus } from "@vibe-tavern/domain";
import type { ChatMode } from "@vibe-tavern/domain";
import type { ToolSet } from "ai";
import type { Character, Message as DbMessage } from "@vibe-tavern/db";
import type {
  AssemblePromptForChatInput,
  AssemblePromptForChatResult,
  PromptAssemblyService,
} from "../prompt/prompt-assembly-service.js";
import { assembleCoauthorPrompt } from "./coauthor-prompt.js";

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
 * Stored in `chats.mode`, defaults to "rp" for all existing chats.
 *
 * The canonical type lives in `@vibe-tavern/domain` (CHAT_MODE) so the db
 * layer, the api strategy registry, and wire types all share one source of
 * truth; it is re-exported here for call-site convenience.
 */
export type { ChatMode };

/**
 * Raw state access for strategies that build their own prompt (co-author)
 * instead of delegating to {@link PromptAssemblyService.assembleForChat} (RP).
 * RP ignores this; co-author reads the character, its canonical profile.md,
 * and the chat's own message history to assemble an editor prompt.
 *
 * Carried on {@link ChatModeAssembleInput} so strategies stay stateless;
 * the caller (SessionRuntime.assemblePrompt) constructs it from its stores.
 */
export interface ChatModeAssembleLoaders {
  /** Active-branch messages for the chat (position-ascending); `limit` takes the last N. */
  getMessages(chatId: ChatId, branchId?: ChatBranchId, limit?: number): Promise<DbMessage[]>;
  /** The character row this chat edits (serializes + greeting context). */
  getCharacter(chatId: ChatId): Promise<Character>;
  /** Canonical `profile.md` text for the character (the edit target). */
  getProfileMdText(characterId: CharacterId): Promise<string>;
}

/**
 * Input to {@link ChatModeStrategy.assemble}. Extends the RP assembly input
 * with the {@link PromptAssemblyService} so strategies can delegate to the
 * existing RP loader (`RpModeStrategy`) or reuse its stores/resolver for their
 * own assembly (`CoauthorModeStrategy`). Carrying the service on the input
 * keeps strategies stateless and `getChatModeStrategy` free of constructor
 * deps; the caller (SessionRuntime.assemblePrompt) already holds the service.
 * `loaders` gives non-RP strategies raw state access (see {@link ChatModeAssembleLoaders}).
 */
export interface ChatModeAssembleInput extends AssemblePromptForChatInput {
  promptService: PromptAssemblyService;
  loaders: ChatModeAssembleLoaders;
}

/** Re-exported so callers don't reach into the prompt service module. */
export type ChatModeAssembleResult = AssemblePromptForChatResult & {
  /**
   * AI SDK tools the strategy wants the executor to pass to streamText()/generateText().
   * RP leaves this undefined (no tool-calling); Co-Author supplies its editor tool set.
   * Tools propose edits — they never write to canonical storage (user-mediated Apply is the sole write path).
   */
  tools?: ToolSet;
  /** Max multi-step tool-calling rounds per generation. Only meaningful when `tools` is set. */
  maxSteps?: number;
};

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
   * Assemble the prompt for a turn. This is the load-bearing mode seam: each
   * mode builds its own prompt here. RP delegates to the existing
   * `assembleForChat` unchanged (RP behavior literally does not move);
   * co-author builds an editor prompt over the serialized card. Returning the
   * standard assembled-prompt shape means streaming / abort / reasoning /
   * `drainStream` all work for every mode with no mode-specific branches in
   * the executor.
   */
  assemble(input: ChatModeAssembleInput): Promise<ChatModeAssembleResult>;

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

  async assemble(input: ChatModeAssembleInput): Promise<ChatModeAssembleResult> {
    // RP assembles through the existing pipeline, unchanged. The promptService
    // is pulled off the input and the rest is exactly AssemblePromptForChatInput.
    const { promptService, ...chatInput } = input;
    return promptService.assembleForChat(chatInput);
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
// Co-Author Mode Strategy (stub)
// ────────────────────────────────────────────────────────────────────────────
// Registered now so per-chat resolution (CA-3) is wired end-to-end before the
// real editor assembly lands in CA-5. assemble throws NOT_IMPLEMENTED until
// then; resolveProvider / onMessageAppended mirror RP (co-author reuses the
// universal chat pipeline, only the assembled prompt differs).

export class CoauthorModeStrategy implements ChatModeStrategy {
  readonly mode: ChatMode = "coauthor";

  async resolveProvider(input: {
    chatId: string;
    profile: StoredProviderProfileRecord;
    model: string;
  }): Promise<{ profile: StoredProviderProfileRecord; model: string }> {
    return input;
  }

  async assemble(input: ChatModeAssembleInput): Promise<ChatModeAssembleResult> {
    return assembleCoauthorPrompt(input);
  }

  async onMessageAppended(_input: {
    chatId: string;
    messageId: string;
    events: EventBus;
  }): Promise<void> {
    // Co-author has no post-append background work.
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Strategy factory
// ────────────────────────────────────────────────────────────────────────────

const strategies = new Map<ChatMode, () => ChatModeStrategy>([
  ["rp", () => new RpModeStrategy()],
  ["coauthor", () => new CoauthorModeStrategy()],
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
