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
 *   2. user/assistant pairs: the chat's own last-N messages (conversation history)
 *
 * Everything else on AssemblePromptResponse (layers, lore, scripts, memories)
 * is empty — co-author is a flat editor chat, not the RP cascade. The trace
 * UI simply shows fewer rows.
 */

import type { ChatBranchId, ChatId, LoreEntryId } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import type { ChatModeAssembleInput, ChatModeAssembleResult } from "./chat-mode-strategy.js";
import { buildCoauthorTools, COAUTHOR_MAX_STEPS } from "./coauthor-tools.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

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
      .then((msgs) =>
        msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ),
  ]);
  const profileMd = await loaders.getProfileMdText(character.id as unknown as import("@vibe-tavern/domain").CharacterId);
  const currentCard = renderCurrentCard(profileMd, character);

  // Load the base editor prompt + the active skill overlay (autodetected from
  // the latest user message). Both are cached by loadPromptAsset.
  const [basePrompt, skillPrompt] = await Promise.all([
    loadPromptAsset(BASE_PROMPT_FILE),
    loadPromptAsset(`coauthor/skills/${detectSkill(latestUserMessage(history))}.md`),
  ]);

  const systemContent = [basePrompt, "", "# Active skill", skillPrompt, "", currentCard].join("\n");

  const finalPayload = {
    messages: [
      { role: "system", content: systemContent },
      ...history,
    ],
  };

  const prompt: AssemblePromptResponse = {
    layers: [],
    tokenAccounting: {},
    activatedLoreEntries: [],
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
      tokenAccounting: {},
      activatedLoreEntries: [] as LoreEntryId[],
      activatedLoreDetail: [],
      scriptInjections: [],
      retrievedMemories: [],
      finalPayload,
      latencyMs: 0,
    },
    tools: buildCoauthorTools(),
    maxSteps: COAUTHOR_MAX_STEPS,
  };
}
