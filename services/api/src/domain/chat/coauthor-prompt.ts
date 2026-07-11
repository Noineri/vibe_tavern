/**
 * Co-Author prompt assembly (CA-6).
 *
 * Builds the editor prompt the model sees, plus the tool set it calls. Pure —
 * all state comes in through {@link ChatModeAssembleInput.loaders}. Tools
 * propose edits (they never write); the user commits via the Apply RPC (CA-7).
 *
 * Prompt shape (what the model sees, via `prompt.finalPayload.messages` — the
 * only field the executor's `toSdkMessages` reads):
 *   1. system: base editor prompt + active skill + current card (profile.md + greetings)
 *      [+ the chat's BOUND lorebook entries as read-only reference, when any are bound — CA-13]
 *   2. user/assistant pairs: the chat's own last-N messages (conversation history)
 *
 * Lore is NOT RP keyword activation here. Co-author is an editor, not a
 * roleplay: the user curates which lorebooks feed the editor via the
 * right-panel picker (the same resolveContext-over-an-explicit-id-list pattern
 * the AI-assistant lorebook-writer uses), and those books' enabled entries are
 * rendered into the system message as read-only reference (never an edit
 * target — tools propose only profile/greetings). The activation-engine trace
 * fields stay empty; the trace UI simply shows fewer rows.
 */

import type { ChatBranchId, ChatId, LoreEntryId } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import type { ChatModeAssembleInput, ChatModeAssembleResult } from "./chat-mode-strategy.js";
import { buildCoauthorTools, COAUTHOR_MAX_STEPS } from "./coauthor-tools.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";
import { estimateTokens, planHistoryCompaction, setModelHint } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";
import { getCoauthorModule, isSeedModule } from "../coauthor/modules/module-registry.js";

/** How many of the chat's most recent messages to include as conversation history. */
const HISTORY_LIMIT = 20;

// Skill prompt files live under services/api/assets/coauthor/skills/.
const BASE_PROMPT_FILE = "coauthor/base.md";
const FALLBACK_SKILL = "profile-overview";

/**
 * Keyword → skill autodetection. First match wins (order matters: more
 * specific keys first). When nothing matches, {@link FALLBACK_SKILL} is used.
 * (The explicit user-pick half of skill resolution needs a chat-level setting
 * that does not exist yet — it lands in a later wave. Autodetect-on-message
 * ships now so a message like "make the personality deeper" routes correctly.)
 */
const SKILL_KEYWORDS: Array<{ skill: string; keywords: string[] }> = [
  { skill: "personality-deepen", keywords: ["personality", "deepen", "flat", "generic", "more interesting", "deeper", "flesh out"] },
];

function detectSkill(userText: string, allowedSkillIds: string[]): string {
  const lower = userText.toLowerCase();
  for (const { skill, keywords } of SKILL_KEYWORDS) {
    if (allowedSkillIds.includes(skill) && keywords.some((k) => lower.includes(k))) return skill;
  }
  return allowedSkillIds[0] ?? FALLBACK_SKILL;
}

/** Extract the most recent user message text for skill autodetection (empty-safe). */
/** The assembled co-author history message shape (matches SDK message parts
 *  one-to-one). Tool calls/results use the SDK v6 field names: a tool call
 *  carries `input` (the parsed args), a tool result carries `output`. Earlier
 *  these were built with `args`/`result` names and the mismatch was masked by
 *  `as any` at the provider mapping layer — so the provider silently dropped
 *  them. Typed here so the compiler catches any future drift. */
type CoauthorHistoryMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] };

function latestUserMessage(history: CoauthorHistoryMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") return m.content;
  }
  return "";
}

/** Render the current card (profile.md + greetings) as read-only context for the model. */
function renderCurrentCard(profileMd: string, character: { firstMessage: string | null; alternateGreetings: string[] }): string {
  const greetings = [character.firstMessage ?? "", ...character.alternateGreetings];
  const greetingLines = greetings.map((g, i) => {
    const label = i === 0 ? "PRIMARY (firstMessage)" : `ALT ${i}`;
    return `### Greeting ${label}\n${g || "(empty)"}`;
  });
  return [`# Current profile.md`, "```yaml", profileMd, "```", "", "# Current greetings", ...greetingLines].join("\n");
}

/** Co-author lorebook entry as the editor sees it (CA-13): just the fields
 *  the prompt needs. The loader dedupes + filters enabled books/entries. */
type CoauthorLoreEntry = { id: string; title: string; content: string };

/** Render the chat's bound lorebook entries as read-only reference context
 *  (CA-13). Empty string when none are bound — so the section is omitted
 *  entirely and the prompt is unchanged for chats with no lore bound. */
function renderLoreContext(entries: CoauthorLoreEntry[]): string {
  if (entries.length === 0) return "";
  const blocks = entries.map((e) => {
    const title = e.title?.trim() ? e.title.trim() : "(untitled)";
    return `## ${title}\n${e.content}`;
  });
  return ["# Lorebook context (read-only reference — do NOT edit)", ...blocks].join("\n");
}

function formatCoauthorHistoryMessages(messages: ReadonlyArray<CoauthorHistoryMessage>): string {
  return messages.map((message) => {
    const content = message.role === "tool"
      ? JSON.stringify(message.content)
      : `${message.content || ""}${message.toolCalls ? JSON.stringify(message.toolCalls) : ""}`;
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
}

function estimateCoauthorHistoryTokens(messages: ReadonlyArray<CoauthorHistoryMessage>): number {
  return estimateTokens(formatCoauthorHistoryMessages(messages));
}

/**
 * Assemble the co-author editor prompt. See module doc. The tool set is built
 * fresh per turn (cheap; no shared mutable state); `tools`/`maxSteps` ride on
 * the result and are threaded into the executor by CA-5's wiring.
 */
export async function assembleCoauthorPrompt(input: ChatModeAssembleInput): Promise<ChatModeAssembleResult> {
  const { chatId, model, loaders } = input;

  // Pull the card state + conversation history up front. The skill overlay is
  // chosen from the latest user message, so history must be resolved before the
  // asset load. Co-author is a flat editor chat — no branches, no compaction.
  const [chat, character, history] = await Promise.all([
    loaders.getChat(chatId),
    loaders.getCharacter(chatId),
    loaders
      .getMessages(chatId, undefined, HISTORY_LIMIT)
      .then((msgs) => {
        const excludeSet = new Set<string>(input.excludeMessageIds || []);
        const historyMsgs = msgs
          .filter((m) => !excludeSet.has(m.id))
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool");
        // Resolve the tool NAME for each tool-result. The DB stores only the
        // `toolCallId` on the `role:"tool"` row; the human-readable name lives
        // on the owning assistant message's `toolCallsJson` (`{id, name, args}`).
        // The Google provider maps `toolName` → `function_response.name`, which
        // Gemini REQUIRES non-empty — an unresolved name here surfaces as a 400
        // `function_response.name: Name cannot be empty` on the next turn. The
        // carrier assistant is always co-located with its tool result (the
        // tool-call/result pair invariant forbids splitting them), so the map
        // lookup always hits in a well-formed history.
        const toolNameById = new Map<string, string>();
        for (const m of historyMsgs) {
          if (m.toolCalls) {
            for (const tc of m.toolCalls) toolNameById.set(tc.id, tc.name);
          }
        }
        return historyMsgs.map((m): CoauthorHistoryMessage => {
          if (m.role === "tool") {
            // SDK v6 ToolResultPart.output is a discriminated union
            // (`{type:'text',value}` | `{type:'json',value}` | ...) — a plain
            // string is NOT valid. Wrap the persisted string result as a text
            // output.
            return {
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId: m.toolCallId ?? "",
                toolName: toolNameById.get(m.toolCallId ?? "") ?? "",
                output: { type: "text", value: m.content },
              }],
            };
          }
          // SDK v6 ToolCallPart: `input` (the parsed args), not `args`.
          const msg: CoauthorHistoryMessage = { role: m.role as "user" | "assistant", content: m.content };
          if (m.toolCalls && m.toolCalls.length > 0) {
            msg.toolCalls = m.toolCalls.map(tc => ({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.args,
            }));
          }
          return msg;
        });
      }),
  ]);
  // Card state + lorebook context + prompt assets are all independent once
  // we have the history (skill autodetect reads it), so fan them out together.
  // Lore is read-only reference (CA-13): the entries of the lorebooks the user
  // explicitly bound to this chat (right-panel picker) — NOT RP keyword
  // activation. Co-author is an editor, not a roleplay.
  // Resolve the active module. Seed modules (the common case) need no DB read —
  // only user-created modules do, so gate the loader call on isSeedModule.
  // basePrompt is now INLINE on the module (CS-24); the old loadPromptAsset
  // call for the base prompt is gone (skill prompts still load from disk).
  const userModules = isSeedModule(chat.coauthorModuleId)
    ? []
    : await loaders.getCoauthorUserModules();
  const module = await getCoauthorModule(chat.coauthorModuleId, userModules);
  const skillId = detectSkill(latestUserMessage(history), module.skillIds);
  const [profileMd, loreEntries, skillPrompt, branchSummaries] = await Promise.all([
    loaders.getProfileMdText(character.id as unknown as import("@vibe-tavern/domain").CharacterId),
    loaders.getCoauthorLorebookEntries(chatId),
    loadPromptAsset(`coauthor/skills/${skillId}.md`),
    loaders.getChatSummaries(chatId, input.branchId ?? (chat.activeBranchId as ChatBranchId)),
  ]);
  const basePrompt = module.basePrompt;
  const currentCard = renderCurrentCard(profileMd, character);
  const loreBlock = renderLoreContext(loreEntries);

  const enabledSummaries = branchSummaries.filter((s) => s.includeInContext && s.content.trim());
  const memoryItems = enabledSummaries.length > 0
    ? enabledSummaries.map((s) => `[${s.source}] ${s.content.trim()}`)
    : (chat.summary?.trim() ? [`[chat] ${chat.summary.trim()}`] : []);
  const memoryBlock = memoryItems.length > 0
    ? ["# Conversation Summary", ...memoryItems].join("\n")
    : "";

  const sections = [basePrompt, "", "# Active skill", skillPrompt, "", currentCard];
  if (memoryBlock) {
    sections.push("", memoryBlock);
  }
  if (loreBlock) {
    // Omitted entirely when no entries are active — the prompt is then
    // unchanged for chats with no lore / no matches.
    sections.push("", loreBlock);
  }
  const systemContent = sections.join("\n");

  setModelHint(model);

  let recentMessagesForHistory = history;
  let compactionSummary: string | undefined;

  const nonHistoryTokens = estimateTokens(systemContent);
  let totalTokenEstimate = nonHistoryTokens + estimateCoauthorHistoryTokens(history);
  const compactionPlan = planHistoryCompaction({
    messages: history,
    nonHistoryTokens,
    contextBudget: input.contextBudget,
    responseReserve: input.responseReserve,
    countHistoryTokens: estimateCoauthorHistoryTokens,
  });
  if (compactionPlan) {
    recentMessagesForHistory = compactionPlan.messages;
    totalTokenEstimate = nonHistoryTokens + compactionPlan.preservedHistoryTokens;
    compactionSummary =
      `Kept ${recentMessagesForHistory.length} of ` +
      `${history.length} recent messages ` +
      `(~${compactionPlan.preservedHistoryTokens} tokens after compaction, ` +
      `${compactionPlan.totalBeforeCompaction} tokens before, ` +
      `budget: ${input.contextBudget}, reserve: ${compactionPlan.responseReserve})`;
  }

  const finalPayload = {
    messages: [
      { role: "system", content: systemContent },
      ...recentMessagesForHistory,
    ],
  };

  const layers: import("@vibe-tavern/domain").PromptLayerDto[] = [];
  
  layers.push({
    id: `module-${module.id}`,
    sourceType: "coauthor_module",
    sourceId: module.id,
    sourceName: `Module: ${module.name}`,
    position: "in_prompt",
    priority: 1000,
    text: basePrompt,
    enabled: true,
    reason: "",
    tokenCount: estimateTokens(basePrompt)
  });

  layers.push({
    id: `skill-${skillId}`,
    sourceType: "coauthor_skill",
    sourceId: skillId,
    sourceName: `Skill: ${skillId}`,
    position: "in_prompt",
    priority: 950,
    text: skillPrompt,
    enabled: true,
    reason: "",
    tokenCount: estimateTokens(skillPrompt)
  });

  layers.push({
    id: "current_card",
    sourceType: "coauthor_profile",
    sourceId: character.id,
    sourceName: "Profile & Greetings",
    position: "in_prompt",
    priority: 900,
    text: currentCard,
    enabled: true,
    reason: "",
    tokenCount: estimateTokens(currentCard)
  });

  if (memoryBlock) {
    layers.push({
      id: "summary_memory",
      sourceType: "summary_memory",
      sourceId: "summary",
      sourceName: "Conversation Summary",
      position: "in_prompt",
      priority: 850,
      text: memoryBlock,
      enabled: true,
      reason: "",
      tokenCount: estimateTokens(memoryBlock)
    });
  }

  if (loreBlock) {
    layers.push({
      id: "lore_entries",
      sourceType: "lore_entry",
      sourceId: "lore",
      sourceName: "Lorebook Context",
      position: "in_prompt",
      priority: 800,
      text: loreBlock,
      enabled: true,
      reason: "",
      tokenCount: estimateTokens(loreBlock)
    });
  }

  const preservedTokens = estimateCoauthorHistoryTokens(recentMessagesForHistory);
  layers.push({
    id: "chat_history",
    sourceType: "chat_history",
    sourceId: "history",
    sourceName: `Conversation History (${recentMessagesForHistory.length} msgs)`,
    position: "in_chat",
    priority: 100,
    text: "",
    enabled: true,
    reason: "",
    tokenCount: preservedTokens
  });

  if (compactionSummary) {
    layers.push({
      id: "compaction",
      sourceType: "compaction",
      sourceId: "compaction",
      sourceName: "Context Compaction",
      position: "hidden_system",
      priority: 50,
      text: compactionSummary,
      enabled: true,
      reason: "",
      tokenCount: 0
    });
  }

  const prompt: AssemblePromptResponse = {
    layers,
    tokenAccounting: {
      total: totalTokenEstimate,
      recentHistory: recentMessagesForHistory.length,
    },
    // Co-author does NOT run the activation engine — no activation trace.
    // Lore context lives only in the system message (renderLoreContext above);
    // these trace fields stay empty so the trace UI doesn't fabricate
    // activation reasons for entries that were picked, not activated.
    activatedLoreEntries: [],
    activatedLoreDetail: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload,
  };

  return {
    branchId: input.branchId ?? ("" as ChatBranchId),
    prompt,
    promptTraceDraft: {
      chatId: chatId,
      branchId: (input.branchId ?? ("" as ChatBranchId)),
      model,
      presetName: "(coauthor)",
      presetId: null,
      assembledLayers: layers,
      tokenAccounting: {
        total: totalTokenEstimate,
      },
      activatedLoreEntries: [] as LoreEntryId[],
      activatedLoreDetail: [],
      scriptInjections: [],
      retrievedMemories: [],
      finalPayload,
      latencyMs: 0,
      compactionSummary,
    },
    tools: buildCoauthorTools({ toolSet: module.toolSet, profileMd }),
    maxSteps: module.maxSteps,
    coauthorModuleId: module.id,
    coauthorSkillId: skillId,
  };
}
