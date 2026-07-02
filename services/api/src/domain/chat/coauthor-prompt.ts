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
import { estimateTokens, findSafeCompactionBoundary, setModelHint } from "@vibe-tavern/prompt-pipeline";

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

function detectSkill(userText: string): string {
  const lower = userText.toLowerCase();
  for (const { skill, keywords } of SKILL_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return skill;
  }
  return FALLBACK_SKILL;
}

/** Extract the most recent user message text for skill autodetection (empty-safe). */
function latestUserMessage(history: Array<{ role: string; content: string }>): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
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

function estimateCoauthorMessageTokens(msg: any): number {
  let contentStr = "";
  if (Array.isArray(msg.content)) {
    contentStr = JSON.stringify(msg.content);
  } else {
    contentStr = msg.content || "";
  }
  if (msg.toolCalls) {
    contentStr += JSON.stringify(msg.toolCalls);
  }
  return estimateTokens(`${String(msg.role).toUpperCase()}: ${contentStr}`);
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
  const [character, history] = await Promise.all([
    loaders.getCharacter(chatId),
    loaders
      .getMessages(chatId, undefined, HISTORY_LIMIT)
      .then((msgs) => {
        const excludeSet = new Set<string>(input.excludeMessageIds || []);
        return msgs
          .filter((m) => !excludeSet.has(m.id))
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
          .map((m) => {
            if (m.role === "tool") {
              return {
                role: "tool",
                content: [{
                  type: "tool-result",
                  toolCallId: m.toolCallId,
                  toolName: "", // toolName is optional or not strictly needed here, but required by some older SDK versions. AI SDK v3/v6 usually uses toolCallId to correlate. 
                  result: m.content
                }]
              };
            }
            const base: any = { role: m.role as "user" | "assistant", content: m.content };
            if (m.toolCalls && m.toolCalls.length > 0) {
              base.toolCalls = (m.toolCalls as any[]).map(tc => ({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.name,
                args: tc.args
              }));
            }
            return base;
          });
      }),
  ]);
  // Card state + lorebook context + prompt assets are all independent once
  // we have the history (skill autodetect reads it), so fan them out together.
  // Lore is read-only reference (CA-13): the entries of the lorebooks the user
  // explicitly bound to this chat (right-panel picker) — NOT RP keyword
  // activation. Co-author is an editor, not a roleplay.
  const skillId = detectSkill(latestUserMessage(history));
  const [profileMd, loreEntries, basePrompt, skillPrompt] = await Promise.all([
    loaders.getProfileMdText(character.id as unknown as import("@vibe-tavern/domain").CharacterId),
    loaders.getCoauthorLorebookEntries(chatId),
    loadPromptAsset(BASE_PROMPT_FILE),
    loadPromptAsset(`coauthor/skills/${skillId}.md`),
  ]);
  const currentCard = renderCurrentCard(profileMd, character);
  const loreBlock = renderLoreContext(loreEntries);

  const sections = [basePrompt, "", "# Active skill", skillPrompt, "", currentCard];
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
  let totalTokenEstimate = nonHistoryTokens + history.reduce((sum, msg) => sum + estimateCoauthorMessageTokens(msg), 0);

  if (
    typeof input.contextBudget === "number" &&
    input.contextBudget > 0 &&
    history.length > 3
  ) {
    const fullHistoryTokens = totalTokenEstimate - nonHistoryTokens;

    if (totalTokenEstimate > input.contextBudget) {
      const responseReserve = input.responseReserve ?? 0;
      const historyBudget = Math.max(0, input.contextBudget - nonHistoryTokens - responseReserve);

      let accTokens = 0;
      let keepCount = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        const msgTokens = estimateCoauthorMessageTokens(history[i]);
        if (accTokens + msgTokens > historyBudget && keepCount >= 2) break;
        accTokens += msgTokens;
        keepCount++;
      }
      keepCount = Math.max(keepCount, 2);

      const keepFrom = findSafeCompactionBoundary(history, keepCount);
      if (keepFrom > 0) {
        recentMessagesForHistory = history.slice(keepFrom);
        const preservedTokens = recentMessagesForHistory.reduce((sum, msg) => sum + estimateCoauthorMessageTokens(msg), 0);
        totalTokenEstimate = nonHistoryTokens + preservedTokens;
        compactionSummary =
          `Kept ${recentMessagesForHistory.length} of ` +
          `${history.length} recent messages ` +
          `(~${preservedTokens} tokens after compaction, ` +
          `${nonHistoryTokens + fullHistoryTokens} tokens before, ` +
          `budget: ${input.contextBudget}, reserve: ${responseReserve})`;
      }
    }
  }

  const finalPayload = {
    messages: [
      { role: "system", content: systemContent },
      ...recentMessagesForHistory,
    ],
  };

  const prompt: AssemblePromptResponse = {
    layers: [],
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
      assembledLayers: [],
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
    tools: buildCoauthorTools(),
    maxSteps: COAUTHOR_MAX_STEPS,
  };
}
