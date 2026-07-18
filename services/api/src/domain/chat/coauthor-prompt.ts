/**
 * Co-Author prompt assembly (CA-6).
 *
 * Builds the editor prompt the model sees, plus the tool set it calls. Pure —
 * all state comes in through {@link ChatModeAssembleInput.loaders}. Tools
 * propose edits (they never write); the user commits via the Apply RPC (CA-7).
 *
 * Prompt shape (what the model sees, via `prompt.finalPayload.messages` — the
 * only field the executor's `toSdkMessages` reads):
 *   1. system: base editor prompt + available-skills catalog + current card (profile.md + greetings)
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
import type { ChatModeAssembleInput, ChatModeAssembleResult, CoauthorContextItem, CoauthorBoundResources } from "./chat-mode-strategy.js";
import { buildCoauthorTools } from "./coauthor-tools.js";
import { estimateTokens, planHistoryCompaction, setModelHint } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";
import { dirname } from "node:path";
import { getCoauthorModule, isSeedModule } from "../coauthor/modules/module-registry.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";
import type { SkillCatalogEntry } from "../coauthor/skills/skill-scanner.js";

/** How many of the chat's most recent messages to include as conversation history. */
const HISTORY_LIMIT = 20;

/** The assembled co-author history message shape (matches SDK message parts
 *  one-to-one). Tool calls/results use the SDK v6 field names: a tool call
 *  carries `input` (the parsed args), a tool result carries `output`. Earlier
 *  these were built with `args`/`result` names and the mismatch was masked by
 *  `as any` at the provider mapping layer — so the provider silently dropped
 *  them. Typed here so the compiler catches any future drift. */
type CoauthorHistoryMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] };

/** Narrow opaque JSON read from tool_calls_json back to AI SDK options. */
function asToolProviderOptions(value: unknown): ToolCallPart["providerOptions"] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ToolCallPart["providerOptions"]
    : undefined;
}

/**
 * Render the 'Available skills' catalog section (Wave 2 / CTX-S4). Metadata
 * only — id, description, and the portable root-relative manifest path the
 * model reads via `read_skill_file`. No skill BODY is loaded eagerly; the
 * model matches the request, reads the relevant SKILL.md, and follows links to
 * assets/references only as needed. Empty string when no skills are available
 * (the section is omitted entirely so the prompt is unchanged for a fresh
 * install with no built-ins).
 */
function renderSkillCatalog(entries: readonly SkillCatalogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [
    "# Available skills (Agent Skills flow)",
    "Skills are loaded on demand, IDE/CLI-style. To use one: pick the skill whose description matches the user's request, call `read_skill_file` with its manifest `path` to read its `SKILL.md`, obey that workflow, and read only the referenced assets/references the current task actually needs. Do NOT read a skill you do not need.",
    "",
    ...entries.map((e) => {
      const shadow = e.shadowsBuiltin ? " (user override of built-in)" : "";
      const desc = e.description.trim() || "(no description)";
      return `- **${e.id}**${shadow} — ${desc}  → read \`${e.rootRelativeManifestPath}\``;
    }),
  ];
  return lines.join("\n");
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

/** Render the chat's pinned Level-1 context entities as read-only reference
 *  blocks (CE-C1; generalizes CA-13's lorebook-only section). Each item is
 *  tagged with its kind so a mixed character/persona/lorebook/script set is
 *  unambiguous to the model. Empty string when nothing is pinned — so the
 *  section is omitted entirely and the prompt is unchanged. */
function renderContextBlocks(items: CoauthorContextItem[]): string {
  if (items.length === 0) return "";
  const TYPE_TAG = {
    character: "Character",
    persona: "Persona",
    lorebook: "Lorebook",
    script: "Script",
  } as const;
  const blocks = items.map((it) => {
    const title = it.title?.trim() ? it.title.trim() : "(untitled)";
    return `## [${TYPE_TAG[it.type]}] ${title}\n${it.content}`;
  });
  return ["# Pinned context (read-only reference — do NOT edit)", ...blocks].join("\n");
}

/** CE-C2: bound-lorebook awareness — names plus entry title/ID pairs (a
 * compact table of contents). IDs are intentionally visible: CE-B1's
 * cross-turn edit and re-delegation tools take a persisted `entryId`, so a
 * title alone leaves the model unable to target the entry. Entry CONTENT is
 * still NOT injected (that is Level 1 when the user pins the book). */
function renderBoundLorebooksAwareness(lorebooks: CoauthorBoundResources["lorebooks"]): string {
  if (lorebooks.length === 0) return "";
  const blocks = lorebooks.map((lb) => {
    const entries = lb.entries.length > 0
      ? lb.entries.map((entry) => `  - ${entry.title} [entryId: ${entry.id}]`).join("\n")
      : "  (no enabled entries)";
    return `## ${lb.name}\n${entries}`;
  });
  return [
    "# Bound lorebooks (awareness — titles + stable entry IDs only; use the shown entryId for an existing entry; ask the user to pin a book for full content)",
    ...blocks,
  ].join("\n");
}

/** CE-C3: bound-script awareness — name + description (summary) only. The
 *  script CODE is NOT injected; if the model needs it, the user pins the
 *  script as Level-1 context. */
function renderBoundScriptsAwareness(scripts: CoauthorBoundResources["scripts"]): string {
  if (scripts.length === 0) return "";
  const blocks = scripts.map((sc) => {
    const summary = sc.summary || "(no description)";
    return `## ${sc.name}\n${summary}`;
  });
  return [
    "# Bound scripts (awareness — summaries only; ask the user to pin a script for its full code)",
    ...blocks,
  ].join("\n");
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
  const { chatId, model, loaders, loreDelegate, loreEntityLookup } = input;

  // Pull the card state + conversation history up front. Co-author is a flat
  // editor chat — no branches, no compaction. (Skills are catalog-only in the
  // prompt; the model reads them on demand via read_skill_file — CTX-S4.)
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
            msg.toolCalls = m.toolCalls.map((tc) => {
              const providerOptions = asToolProviderOptions(tc.providerOptions);
              return {
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.name,
                input: tc.args,
                ...(providerOptions ? { providerOptions } : {}),
              };
            });
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
  // basePrompt is INLINE on the module (CS-24). Skills are no longer eagerly
  // loaded or keyword-detected: the catalog (metadata only) is injected below
  // and the model reads SKILL.md/references on demand via read_skill_file.
  const userModules = isSeedModule(chat.coauthorModuleId)
    ? []
    : await loaders.getCoauthorUserModules();
  const module = await getCoauthorModule(chat.coauthorModuleId, userModules);
  const [profileMd, contextItems, skillCatalog, branchSummaries, boundResources] = await Promise.all([
    loaders.getProfileMdText(character.id as unknown as import("@vibe-tavern/domain").CharacterId),
    loaders.getCoauthorContextItems(chatId),
    loaders.getSkillCatalog(),
    loaders.getChatSummaries(chatId, input.branchId ?? (chat.activeBranchId as ChatBranchId)),
    loaders.getCoauthorBoundResources(character.id as unknown as import("@vibe-tavern/domain").CharacterId),
  ]);
  const basePrompt = module.basePrompt;
  // Shared editor preamble (Role + tool mechanics + editing discipline) loaded
  // from coauthor/base.md. This is the universal co-author framing; the module's
  // basePrompt specializes it with mode-specific behavior. Prepending it here
  // keeps the tool mechanics in one place (DRY) and ensures every module — seed
  // or user, original or duplicated (M3) — carries the editing contract.
  const coauthorBase = await loadPromptAsset("coauthor/base.md");
  const currentCard = renderCurrentCard(profileMd, character);
  const contextBlock = renderContextBlocks(contextItems);
  const boundLorebooksBlock = renderBoundLorebooksAwareness(boundResources.lorebooks);
  const boundScriptsBlock = renderBoundScriptsAwareness(boundResources.scripts);
  const skillCatalogBlock = renderSkillCatalog(skillCatalog);
  // Derive the skill roots (user + built-in) from the catalog entries' skill
  // dirs so read_skill_file resolves paths against the same roots the catalog
  // was built from. Empty when no skills are available (reads then reject).
  const skillRoots = [...new Set(skillCatalog.map((e) => dirname(e.skillDir)))];

  const enabledSummaries = branchSummaries.filter((s) => s.includeInContext && s.content.trim());
  const memoryItems = enabledSummaries.length > 0
    ? enabledSummaries.map((s) => `[${s.source}] ${s.content.trim()}`)
    : (chat.summary?.trim() ? [`[chat] ${chat.summary.trim()}`] : []);
  const memoryBlock = memoryItems.length > 0
    ? ["# Conversation Summary", ...memoryItems].join("\n")
    : "";

  const sections = [coauthorBase, "", basePrompt];
  if (skillCatalogBlock) {
    sections.push("", skillCatalogBlock);
  }
  sections.push("", currentCard);
  // CE-C2/C3: bound-resource awareness sits right after the character card —
  // these are the character's OWNED lorebooks/scripts (a table of contents),
  // distinct from Level-1 pinned context (full content) appended further down.
  if (boundLorebooksBlock) {
    sections.push("", boundLorebooksBlock);
  }
  if (boundScriptsBlock) {
    sections.push("", boundScriptsBlock);
  }
  if (memoryBlock) {
    sections.push("", memoryBlock);
  }
  if (contextBlock) {
    // Omitted entirely when nothing is pinned — the prompt is then
    // unchanged for chats with no context bound.
    sections.push("", contextBlock);
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
    id: "coauthor-base",
    sourceType: "coauthor_module",
    sourceId: "base",
    sourceName: "Co-Author base (editor contract)",
    position: "in_prompt",
    priority: 1100,
    text: coauthorBase,
    enabled: true,
    reason: "",
    tokenCount: estimateTokens(coauthorBase)
  });

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

  if (skillCatalogBlock) {
    layers.push({
      id: "skill_catalog",
      sourceType: "coauthor_skill",
      sourceId: "catalog",
      sourceName: `Available skills (${skillCatalog.length})`,
      position: "in_prompt",
      priority: 950,
      text: skillCatalogBlock,
      enabled: true,
      reason: "",
      tokenCount: estimateTokens(skillCatalogBlock)
    });
  }

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

  // CE-C2: bound-lorebook awareness (names + entry titles). Sits just below the
  // character card — these are the character's owned books as a table of
  // contents. Distinct from `pinned_context` (Level 1, full content) below.
  if (boundLorebooksBlock) {
    layers.push({
      id: "bound_lorebooks",
      sourceType: "coauthor_context",
      sourceId: "bound_lorebooks",
      sourceName: `Bound Lorebooks (${boundResources.lorebooks.length})`,
      position: "in_prompt",
      priority: 890,
      text: boundLorebooksBlock,
      enabled: true,
      reason: "",
      tokenCount: estimateTokens(boundLorebooksBlock)
    });
  }

  // CE-C3: bound-script awareness (names + summaries). Symmetric to bound lorebooks.
  if (boundScriptsBlock) {
    layers.push({
      id: "bound_scripts",
      sourceType: "coauthor_context",
      sourceId: "bound_scripts",
      sourceName: `Bound Scripts (${boundResources.scripts.length})`,
      position: "in_prompt",
      priority: 885,
      text: boundScriptsBlock,
      enabled: true,
      reason: "",
      tokenCount: estimateTokens(boundScriptsBlock)
    });
  }

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

  if (contextBlock) {
    layers.push({
      id: "pinned_context",
      sourceType: "coauthor_context",
      sourceId: "context",
      sourceName: `Pinned Context (${contextItems.length})`,
      position: "in_prompt",
      priority: 800,
      text: contextBlock,
      enabled: true,
      reason: "",
      tokenCount: estimateTokens(contextBlock)
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
    // Pinned context AND bound-resource awareness (renderContextBlocks /
    // renderBoundLorebooksAwareness / renderBoundScriptsAwareness above) live
    // only in the system message; these trace fields stay empty so the trace UI
    // doesn't fabricate activation reasons for entries that were picked/bound,
    // not keyword-activated.
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
    tools: buildCoauthorTools({ toolSet: module.toolSet, profileMd, skillRoots, loreDelegate, loreEntityLookup }),
    maxSteps: module.maxSteps,
    coauthorModuleId: module.id,
    coauthorSkillId: null,
  };
}
