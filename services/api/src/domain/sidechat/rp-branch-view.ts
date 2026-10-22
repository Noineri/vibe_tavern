import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { Message, MessageStore, MessageVariant } from "@vibe-tavern/db";
import {
  resolveHistoryAsModelSees,
  type PromptAssemblyContext,
  type RecentMessage,
} from "@vibe-tavern/prompt-pipeline";
import { type ChatBranchLookup, findBranchOfChat } from "../chat/chat-branch-ownership.js";
import type { PromptAssemblyService } from "../prompt/prompt-assembly-service.js";
import { validation } from "../../shared/errors.js";

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
 *
 * Since SC-17 the reader also serves NAMED VARIANTS of named messages (the
 * "discuss in the sidechat" attach flow): pass (messageId, variantId) pairs as
 * the fourth argument and the view carries `namedVariants` — each pair's
 * text transformed by the SAME per-message seam (regex → macros → dice /
 * report), never the raw stored content (a raw `{{user}}` would reach the
 * model). An alternative reads the way the RP model would have received it:
 * its text replaces its message's own row IN PLACE for one extra transform
 * pass — same slot, same role, same depth-sensitive regex window, same
 * message-level dice/report blocks — so the treatment is byte-identical to
 * the selected text's, not an approximation. A pair whose message is not in
 * the branch (or not in the chat), or whose variant is not one of that
 * message's variants, throws the typed validation below BEFORE the caller
 * can freeze anything (SC-17's all-or-nothing rule).
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
  /** The model that wrote the SELECTED variant (the variant row's
   *  `model_id`); null when the row has none — a user message, a hand-seeded
   *  row. The frozen payloads' `model` (SC-23a); read with the variant,
   *  never re-derived. */
  modelId: string | null;
  /** The prompt preset that wrote the SELECTED variant (the variant row's
   *  `preset_name`); null when none. The frozen payloads' `preset` (SC-23a). */
  presetName: string | null;
  /** The transformed content — regex → macros → dice / report blocks. */
  text: string;
}

export interface RpBranchView {
  chatId: string;
  branchId: string;
  /** Position order, oldest first. */
  messages: RpBranchViewMessage[];
  /** Present only when the caller asked for named variants (SC-17): one
   *  entry per requested pair, in request order — grouping into events and
   *  position-ordering them is the freeze module's job (the reader stays a
   *  read). */
  namedVariants?: readonly RpBranchViewNamedVariant[];
}

/** One (messageId, variantId) pair the caller wants the model-view text of
 *  (SC-17). The wire shape of the same name (`attachedVariants` items) is
 *  structurally identical — this is the domain-side spelling. */
export interface AttachedVariantPair {
  readonly messageId: string;
  readonly variantId: string;
}

/** One named variant as the RP model would have received it (SC-17): the
 *  transformed text (same regex → macros → dice/report seam as the selected
 *  text of its message) plus the RP's OWN selection marker, read from the
 *  store row at read time — never from any request. */
export interface RpBranchViewNamedVariant {
  readonly messageId: string;
  readonly variantId: string;
  /** 0-based branch position of the pair's message. */
  readonly position: number;
  /** The transformed variant text — never the raw stored content. */
  readonly text: string;
  /** The RP's own `message_variants.is_selected` for THIS variant. */
  readonly selected: boolean;
  /** The variant row's 0-based `variant_index` — the RP UI's variant number
   *  is `variantIndex + 1`, what `<variant number>` freezes (SC-23a). */
  readonly variantIndex: number;
  /** The model that wrote this variant (the row's `model_id`); null when the
   *  row has none (SC-23a — the frozen `model` attribute). */
  readonly modelId: string | null;
  /** The prompt preset that wrote this variant (the row's `preset_name`);
   *  null when none (SC-23a — the frozen `preset` attribute). */
  readonly presetName: string | null;
}

/** Typed-validation code (SC-17): a requested pair does not resolve within
 *  the thread's own chat + branch — a foreign message, a message of another
 *  branch/chat, or a variant that is not one of its message's variants. The
 *  DomainError carries `kind: "Validation"` (the 400 family) with this code
 *  in `details` — the same lowercase family as `not_an_rp_chat`. */
export const ATTACHED_VARIANT_NOT_IN_BRANCH_CODE = "attached_variant_not_in_branch";

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
 *
 * `named` (SC-17, optional): (messageId, variantId) pairs to resolve into
 * `view.namedVariants`. A pair that does not resolve within this chat's
 * branch throws the typed validation {@link ATTACHED_VARIANT_NOT_IN_BRANCH_CODE}
 * — all pairs are checked inside this one read, before the caller can freeze
 * anything.
 */
export async function readBranchAsModelSees(
  deps: RpBranchViewDeps,
  chatId: ChatId,
  branchId: ChatBranchId,
  named?: readonly AttachedVariantPair[],
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
    const selected = variantsByMessage.get(message.id)?.find((variant) => variant.isSelected);
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
      // downstream pinning; variant reasoning is never read here. The row's
      // model/preset ride the SAME lookup (SC-23a): the selected variant's
      // own provenance, never re-derived elsewhere.
      variantId: selected?.id ?? null,
      modelId: selected?.modelId ?? null,
      presetName: selected?.presetName ?? null,
      text: message.content,
    };
  });

  // Position order (the transform follows the pipeline's recent-message
  // order, whose last-user safeguard can append an earlier-position message).
  messages.sort((a, b) => a.position - b.position);

  // SC-17: the named variants ride the SAME built context (one
  // buildPipelineContext call per read — the store reads above are shared,
  // only the pure per-variant transform passes repeat).
  const namedVariants =
    named !== undefined && named.length > 0
      ? transformNamedVariants(built.context, branchMessages, variantsByMessage, named, chatId)
      : undefined;

  return {
    chatId,
    branchId,
    messages,
    ...(namedVariants !== undefined ? { namedVariants } : {}),
  };
}

/** The refusal a non-resolving pair throws (SC-17) — same shape for a foreign
 *  message, a wrong-chat message, and a foreign variant; the pair rides in
 *  `details` so the 400 can name the offender. */
function attachedVariantRefusal(pair: AttachedVariantPair): never {
  throw validation(
    `The attached variant does not belong to this sidechat thread's chat and branch ` +
      `(message '${pair.messageId}', variant '${pair.variantId}').`,
    { code: ATTACHED_VARIANT_NOT_IN_BRANCH_CODE, messageId: pair.messageId, variantId: pair.variantId },
  );
}

/**
 * Resolve the named (messageId, variantId) pairs (SC-17) through the SAME
 * per-message transform the selected texts went through above: for each
 * pair, the variant's RAW stored content replaces its message's own row IN
 * PLACE (same id, role, depth-sensitive regex window position, and
 * message-level dice/report blocks) in one extra `resolveHistoryAsModelSees`
 * pass over the SAME built context — an alternative reads exactly the way
 * the RP model would have received it had it been the selected text. The
 * real rows' window is untouched (each pass maps a copy), so the view's own
 * messages stay byte-identical to the no-pairs read.
 *
 * Validation (ALL pairs first, SC-17's all-or-nothing rule — a throw on any
 * pair leaves the function with nothing returned, so the caller can freeze
 * nothing):
 * - the message must be one of this branch's rows AND carry this chat's id
 *   (both halves of the plan's "the thread's own chat + branch");
 * - the variant must be one of that message's variants in this branch.
 * Pure — every input is a parameter.
 */
function transformNamedVariants(
  context: PromptAssemblyContext,
  branchMessages: readonly Message[],
  variantsByMessage: ReadonlyMap<string, readonly MessageVariant[]>,
  named: readonly AttachedVariantPair[],
  chatId: ChatId,
): RpBranchViewNamedVariant[] {
  const messageById = new Map(branchMessages.map((message) => [message.id, message]));

  // ALL pairs validated FIRST (the all-or-nothing half of the rule): every
  // membership check runs before any transform pass, so a foreign pair
  // aborts the whole read — nothing computed, nothing returned to freeze.
  const validated = named.map((pair) => {
    const message = messageById.get(pair.messageId);
    // Both membership halves in one guard: absent from the branch's rows, or
    // present but owned by another chat (corruption) — same typed refusal.
    if (message === undefined || message.chatId !== chatId) attachedVariantRefusal(pair);
    const variant = (variantsByMessage.get(pair.messageId) ?? []).find(
      (candidate) => candidate.id === pair.variantId,
    );
    if (variant === undefined) attachedVariantRefusal(pair);
    return { pair, message: message!, variant: variant! };
  });

  const resolved: RpBranchViewNamedVariant[] = [];
  for (const { pair, message, variant } of validated) {
    const base = context.chat.recentMessages.find((row) => row.id === pair.messageId);
    if (base === undefined) {
      // Unreachable by construction (recentMessageLimit is the FULL branch
      // length above) — the same corruption-guard style as the position
      // lookup in the main mapping.
      throw new Error(
        `readBranchAsModelSees: named message "${pair.messageId}" is absent from the pipeline's ` +
          `recent messages — cannot transform variant "${pair.variantId}"`,
      );
    }
    const transformed = resolveHistoryAsModelSees({
      ...context,
      chat: {
        ...context.chat,
        // Replace EVERY row of this message (the send path's last-user
        // safeguard can duplicate an id) — the variant takes its message's
        // own slot, so regex depth filtering sees it exactly where the
        // selected text sat.
        recentMessages: context.chat.recentMessages.map((row): RecentMessage =>
          row.id === pair.messageId ? { ...row, content: variant.content } : row,
        ),
      },
    });
    const row = transformed.find((candidate) => candidate.id === pair.messageId);
    if (row === undefined) {
      throw new Error(
        `readBranchAsModelSees: transformed pass lost named message "${pair.messageId}" — ` +
          "refusing to freeze an untransformed variant text",
      );
    }
    resolved.push({
      messageId: pair.messageId,
      variantId: pair.variantId,
      position: message.position,
      text: row.content,
      selected: variant.isSelected,
      variantIndex: variant.variantIndex,
      modelId: variant.modelId,
      presetName: variant.presetName,
    });
  }
  return resolved;
}
