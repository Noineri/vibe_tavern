import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { MessageStore } from "@vibe-tavern/db";
import { resolveHistoryAsModelSees, type RecentMessage } from "@vibe-tavern/prompt-pipeline";
import { type ChatBranchLookup, findBranchOfChat } from "../chat/chat-branch-ownership.js";
import type { PromptAssemblyService } from "../prompt/prompt-assembly-service.js";

/**
 * Whole-branch RP view (SIDECHAT_PLAN SC-2a): read a branch's messages
 * EXACTLY the way the RP model is given them. Stored `messages.content` is
 * NOT that text — identity macros stay raw in storage (a greeting is stored
 * as "… {{user}} …") and the RP prompt transforms each history message at
 * assembly (prompt-placement regex presets on the RAW text → macro
 * resolution → the dice block and the experience-report block appended).
 *
 * This reader reuses the send path's own derivations instead of re-deriving
 * any of them: the messages, dice/report reads, regex presets, and the macro
 * variable context all come from `buildPipelineContext` (the same seam every
 * consumer — generate / context preview / summary / insight one-shots — goes
 * through), and the per-message transform is
 * `resolveHistoryAsModelSees` (prompt-pipeline's single source for "what the
 * model sees of a history message", SC-2a's extraction from assemble.ts).
 *
 * The WHOLE branch is returned — no history window, no count limit. Budgeting
 * a window over this view is Wave 2's job (SC-2b/2c); no cap is applied here
 * on purpose. Since SC-6 the freeze also keeps summary-covered messages
 * (`keepSummaryCoveredMessages`): coverage is the sidechat ASSEMBLY's
 * read-time rule, never the freeze's — a summary disabled after the first
 * sync must find its messages in place, not arrive as a new delta at the end
 * of the timeline.
 */
export interface RpBranchViewMessage {
  id: string;
  /** 0-based branch position, as stored on the message row. */
  position: number;
  role: RecentMessage["role"];
  /**
   * The message's speaker name (assistant → character name, user → persona
   * name, system/tool → null) — same ST speaker-name rule the lore-scan
   * prefix applies (prompt-resolver.ts `recentMessagesWithNames`).
   */
  authorName: string | null;
  /** The message's currently SELECTED variant (swipe) id; null when the
   *  message has no variants (not expected — every insert creates one). */
  variantId: string | null;
  /** The transformed content — regex → macros → dice / report blocks. */
  text: string;
}

export interface RpBranchView {
  chatId: string;
  branchId: string;
  /** Position order, oldest first. */
  messages: RpBranchViewMessage[];
}

/** The stores/services this reader reads — a `Pick` so tests and callers can
 *  pass narrow seams instead of whole containers. */
export interface RpBranchViewDeps {
  /** Ownership pair check — the shared SC-0l module, never a private copy. */
  chats: ChatBranchLookup;
  messages: Pick<MessageStore, "getMessages" | "getVariantsByBranch">;
  /** The RP assembly service — supplies the send path's own inputs. */
  assembly: PromptAssemblyService;
}

/**
 * Read the branch as the RP model sees it. Returns null when the branch does
 * not exist or belongs to another chat (the ownership pair resolves through
 * {@link findBranchOfChat}, which keeps both cases indistinguishable); this
 * is a soft domain-layer read, not a route — the caller owns the reaction.
 */
export async function readBranchAsModelSees(
  deps: RpBranchViewDeps,
  chatId: ChatId,
  branchId: ChatBranchId,
): Promise<RpBranchView | null> {
  const branch = await findBranchOfChat(deps.chats, chatId, branchId);
  if (!branch) return null;

  // The raw rows give the view's position + variant columns (the pipeline's
  // RecentMessage carries neither) and the full branch length below.
  const branchMessages = await deps.messages.getMessages(branchId);

  // Same inputs a chat turn uses, with three read-path-only choices:
  // - recentMessageLimit = the FULL branch length, so the chat's
  //   messageHistoryLimit never windows the read (the whole branch is the
  //   contract; budgeting is Wave 2);
  // - dryRun lore activation, so a read never advances sticky/cooldown timed
  //   state (same dryRun the context-preview path passes);
  // - keepSummaryCoveredMessages (SC-6), so the freeze keeps EVERY message —
  //   the RP prompt's summary exclusion is applied when the sidechat
  //   assembles over this frozen timeline, never at the freeze (a summary
  //   disabled later must find its messages in place).
  // The empty model string is the established no-model sentinel
  // (session-runtime's buildPipelineContext wrapper); token hints are
  // irrelevant to this text-only read.
  const built = await deps.assembly.buildPipelineContext({
    chatId,
    branchId,
    model: "",
    dryRun: true,
    recentMessageLimit: branchMessages.length,
    keepSummaryCoveredMessages: true,
  });

  const transformed = resolveHistoryAsModelSees(built.context);

  const positionById = new Map(branchMessages.map((message) => [message.id, message.position]));
  const variantsByMessage = await deps.messages.getVariantsByBranch(branchId);
  const characterName = built.context.character.name;
  const personaName = built.context.persona?.name ?? null;

  const messages = transformed.map((message): RpBranchViewMessage => {
    // Invariant: every RecentMessage came from this branch's rows (plus the
    // send path's own last-user-turn safeguard, which also re-uses an
    // existing branch message id) — so the position lookup always hits.
    const position = positionById.get(message.id)!;
    return {
      id: message.id,
      position,
      role: message.role,
      authorName: message.role === "assistant"
        ? characterName
        : message.role === "user"
          ? personaName ?? "User"
          : null,
      // The selected variant IS the message's content (messages.content is
      // synced with it on every select/edit) — the id rides along for
      // downstream pinning; variant reasoning is never read here.
      variantId: variantsByMessage.get(message.id)?.find((variant) => variant.isSelected)?.id ?? null,
      text: message.content,
    };
  });

  // Position order (the transform follows the pipeline's recent-message
  // order, whose last-user safeguard can append an earlier-position message).
  messages.sort((a, b) => a.position - b.position);

  return { chatId, branchId, messages };
}
