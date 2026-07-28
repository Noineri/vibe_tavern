import { brandId, parseStoredAttachments, OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS, normalizeSceneTrackerConfig } from "@vibe-tavern/domain";
import type {
  AssemblePromptResponse,
  CustomInjection,
  PromptLayerDto,
  PromptOrderEntry,
} from "@vibe-tavern/domain";
import type {
  ChatBranchId,
  ChatId,
  LoreEntry,
  LoreEntryId,
  MessageId,
  PromptPresetId,
  PromptTrace,
  PromptTraceId,
  RetrievedMemoryHit,
  ActiveLoreEntry,
  ActivatedLoreDetail,
  ObjectiveTask,
  ObjectiveState,
} from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { assemblePrompt, getSummaryStrategy, setModelHint, type PromptAssemblyContext } from "@vibe-tavern/prompt-pipeline";
import { storeRollToSnapshot } from "../dice/dice-service.js";
import { isRecordSchemaCompatible } from "../insights/scene-cache.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { type FileStore, STORAGE_FOLDERS } from "@vibe-tavern/db";

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
      customInjections: CustomInjection[];
      promptOrder: PromptOrderEntry[];
    } | null>;
  listActiveLoreEntries(input: {
    chatId: ChatId;
    branchId: ChatBranchId;
    recentText: string;
    /** Max context tokens of the active model. Needed for percent-of-context
     * token-budget mode on lorebooks. Optional — when absent, percent-mode
     * lorebooks silently fall back to their fixed `tokenBudget`. */
    maxContextTokens?: number;
  }): Promise<ActiveLoreEntry[]>;
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

export interface AssemblePromptForChatInput {
  chatId: ChatId;
  branchId?: ChatBranchId;
  model: string;
  recentMessageLimit?: number;
  excludeMessageIds?: MessageId[];
  /** Bound the message window to the branch PREFIX through this message inclusive
   *  (no future turns). Used by Scene history backfill so each target is generated
   *  from only the history that preceded it. When set, the global last-user-turn
   *  re-add is suppressed (the target's turn is the natural end of the window). */
  throughMessageId?: MessageId;
  contextBudget?: number | null;
  /** Tokens reserved for the model's response. Subtracted from contextBudget during compaction. */
  responseReserve?: number;
  /** Summary preparation is source-loading policy, not a pipeline mode. */
  summary?: boolean;
  /** SUMMARY_PRIOR_CONTEXT_PLAN (SPC-3): preceding chat-summaries
   *  (`summarizedTo < from` chain, count-capped, oldest→newest) fed into the
   *  summary prompt as read-only continuity. Threaded into pipelineContext
   *  only when `summary` is true; absent on chat turns. */
  priorSummaries?: Array<{ id: string; label?: string; content: string }>;
  /**
   * Optional per-request prompt preset override (Wave Q1b). When set, the
   * assembled prompt uses this preset instead of the chat's `promptPresetId`,
   * WITHOUT mutating the chat row. Undefined → existing cascade (chat's preset →
   * global default). This is the queue's per-job preset key (frozen at enqueue).
   */
  presetId?: PromptPresetId;
}

export type PromptTraceDraft = Omit<PromptTrace, "id" | "messageId" | "createdAt" | "presetName"> & {
  /** Resolved prompt preset id (override → chat → global default), exported
   *  by assembly so the message-meta path records the preset each reply used. */
  presetId: string | null;
  /** Resolved prompt preset NAME (clean: the preset's name, or null when none
   *  was resolved). The prompt_traces column is NOT NULL, so the trace-save
   *  path applies its own `?? "(none)"` display fallback; this field stays
   *  clean so the message-meta path can bake a real name (or null) onto each
   *  variant without inheriting the trace's display sentinel. */
  presetName: string | null;
};

export interface AssemblePromptForChatResult {
  branchId: ChatBranchId;
  prompt: AssemblePromptResponse;
  promptTraceDraft: PromptTraceDraft;
}

/**
 * Insights — Objective Tracker (INSIGHTS_PLAN): resolve the active-task context
 * field injected into the prompt pipeline. Returns null when the feature is off,
 * when no state has been generated yet, or when there is no active/pending task —
 * so the pipeline emits NO objective layer (zero added tokens / DOM). Pure and
 * exported so the selection rule (first 'active', else first 'pending') and the
 * depth/injectPrompt defaults are unit-testable without a DB.
 */
export function resolveObjectiveTaskContext(input: {
  insightsConfig: Record<string, unknown>;
  insightsObjectiveState: Record<string, unknown>;
}): { description: string; injectPrompt: string; injectionDepth: number } | null {
  if (!input.insightsConfig?.objectiveEnabled) return null;
  const state = input.insightsObjectiveState as Partial<ObjectiveState>;
  // Route mode → the active route task; goals mode → the selected (active) short-term goal.
  const items = state?.mode === OBJECTIVE_MODE.goals
    ? (Array.isArray(state?.shortTermGoals) ? (state.shortTermGoals as ObjectiveTask[]) : [])
    : (Array.isArray(state?.tasks) ? (state.tasks as ObjectiveTask[]) : []);
  const active =
    items.find((t) => t && t.status === OBJECTIVE_TASK_STATUS.active) ??
    items.find((t) => t && t.status === OBJECTIVE_TASK_STATUS.pending);
  if (!active || !String(active.description ?? "").trim()) return null;
  const injectionDepth = typeof state?.injectionDepth === "number" ? state.injectionDepth : 1;
  const injectPrompt = typeof state?.injectPrompt === "string" ? state.injectPrompt : "";
  return { description: String(active.description), injectPrompt, injectionDepth };
}

/**
 * Insights — Objective Tracker (OGM, goals mode): resolve the long-term goal
 * context field injected into the prompt pipeline. Returns null outside goals
 * mode, when no long-term goal is set, or when it is completed/abandoned (a
 * finished long-term goal is no longer framing) — the pipeline then emits NO
 * long-term layer. Pure and exported so the gating + depth/injectPrompt
 * defaults are unit-testable without a DB.
 */
export function resolveObjectiveLongTermContext(input: {
  insightsConfig: Record<string, unknown>;
  insightsObjectiveState: Record<string, unknown>;
}): { description: string; injectPrompt: string; injectionDepth: number } | null {
  if (!input.insightsConfig?.objectiveEnabled) return null;
  const state = input.insightsObjectiveState as Partial<ObjectiveState>;
  if (state?.mode !== OBJECTIVE_MODE.goals) return null;
  const goal = state.longTermGoal;
  if (!goal || !String(goal.description ?? "").trim()) return null;
  if (goal.status === OBJECTIVE_TASK_STATUS.completed || goal.status === OBJECTIVE_TASK_STATUS.abandoned) return null;
  const injectionDepth = typeof state?.injectionDepth === "number" ? state.injectionDepth : 1;
  const injectPrompt = typeof state?.injectPrompt === "string" ? state.injectPrompt : "";
  return { description: String(goal.description), injectPrompt, injectionDepth };
}

export interface BuiltPipelineContext {
  /** The full RP world context (character / persona / activated lorebook /
   *  script injections / recent window) under the chat's preset toggles — the
   *  same input a chat turn or a summary build receives. Insight one-shots reuse
   *  it (running buildLayers + stripping the insight self-injection layers). */
  context: PromptAssemblyContext;
  branchId: ChatBranchId;
  chatId: ChatId;
  chatPromptPresetId: string | null;
  promptPresetId: string | null;
  promptPresetName: string | null;
  activeLoreEntries: ActiveLoreEntry[];
  retrievedMemories: RetrievedMemoryHit[];
  scriptResult: Awaited<ReturnType<PromptAssemblyResolver["executeScripts"]>>;
  recentMessageCount: number;
}

export class PromptAssemblyService {
  constructor(
    private readonly stores: StoreContainer,
    private readonly resolver: PromptAssemblyResolver,
    private readonly fileStore: FileStore,
  ) {}

  async assembleForChat(input: AssemblePromptForChatInput): Promise<AssemblePromptForChatResult> {
    const built = await this.buildPipelineContext(input);
    const result = input.summary
      ? getSummaryStrategy().assemble(built.context)
      : assemblePrompt(built.context);

    // Build script injection trace data — one row per script that ran (P4),
    // instead of the old single synthetic '__pipeline' row that flattened all
    // scripts into one concatenated error string. A run gets a trace row when
    // it produced any observable effect (mutation / injection / console) or
    // errored — no-op runs are omitted to keep the trace signal-high.
    const scriptInjections = built.scriptResult.scriptRuns
      .filter(run =>
        run.status === 'errored'
        || run.personalityMutation !== ''
        || run.scenarioMutation !== ''
        || run.injectedMessages.length > 0
        || run.console.length > 0,
      )
      .map(run => ({
        scriptId: run.scriptId,
        scriptName: run.scriptName,
        status: run.status,
        personalityMutation: run.personalityMutation,
        scenarioMutation: run.scenarioMutation,
        injectedMessages: run.injectedMessages,
        console: run.console,
        error: run.error,
        line: run.line,
      }));

    // Per-entry activation reasons for the prompt trace (parallel to
    // activatedLoreEntries; same ids in activation order). Built from the
    // enriched resolver result so the trace UI can show WHY each fired.
    const activatedLoreDetail: ActivatedLoreDetail[] = built.activeLoreEntries.map((entry) => ({
      id: entry.id as string,
      title: entry.title,
      reason: entry.activationReason,
    }));

    return {
      branchId: built.branchId,
      prompt: {
        layers: result.layers.map(mapPromptLayerDto),
        tokenAccounting: {
          total: result.totalTokenEstimate,
          recentHistory: built.recentMessageCount,
        },
        activatedLoreEntries: result.activatedLoreEntries,
        activatedLoreDetail,
        scriptInjections,
        retrievedMemories: built.retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          score: memory.score,
          sourceId: memory.sourceId,
        })),
        finalPayload: result.finalPayload,
        prefill: result.prefill,
      },
      promptTraceDraft: {
        chatId: built.chatId,
        branchId: built.branchId,
        model: input.model,
        presetName: built.promptPresetName,
        // The fully-resolved preset id (override → chat → global default; see
        // the cascade above) and clean preset name. Carried out of assembly so
        // the message-meta path can bake onto each variant the preset that was
        // ACTUALLY used (name as an immutable string, no FK). Read by
        // ChatRuntime.appendAssistantReply / appendMessageVariant.
        presetId: built.promptPresetId ?? null,
        assembledLayers: result.layers.map((layer) => mapPromptLayerDto(layer)),
        tokenAccounting: {
          total: result.totalTokenEstimate,
        },
        activatedLoreEntries: result.activatedLoreEntries.map((id) => brandId<LoreEntryId>(id)),
        activatedLoreDetail,
        scriptInjections,
        retrievedMemories: built.retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          sourceId: memory.sourceId,
          score: memory.score,
          matchedKeys: memory.matchedKeys,
        })),
        finalPayload: result.finalPayload,
        latencyMs: 0,
        prefill: result.prefill,
        compactionSummary: result.compactionSummary,
      },
    };
  }

  /**
   * Build the full RP world context for a chat WITHOUT assembling it. The
   * chat-turn path (assembleForChat) and the insight one-shots (objective
   * check/generate, scene generate) both need the same world (character /
   * persona / activated lorebook / script injections / recent window under
   * the chat preset toggles); insight assemblers reuse buildLayers on this
   * context (minus the insight self-injection layers) and append their
   * instruction. Extracted so the insight path gets the raw context without
   * re-running assembly — no flag on assembleForChat (the assembler choice
   * stays registry-driven; see InsightsAssembler).
   */
  /**
   * Resolve the Scene Tracker injection context for the main model
   * (SCENE_TRACKER_PLAN SCN-7). Reads the chat's tracker config, scans the
   * active branch's last `contextWindow` assistant messages for their SELECTED
   * variant's scene records, keeps only the schema-compatible ones
   * (`isRecordSchemaCompatible` — schema-coherent with the current prompt), and takes the
   * last `injectLastN` in conversation order. Returns the resolved layer input,
   * or null when the tracker is off / injection is disabled / nothing valid is
   * in window. Nonselected variants' records are never substituted.
   */
  private async resolveSceneInjection(
    insightsConfig: Record<string, unknown>,
    branchId: string,
  ): Promise<NonNullable<PromptAssemblyContext["sceneState"]> | null> {
    if (!insightsConfig?.trackerEnabled) return null;
    const config = normalizeSceneTrackerConfig(insightsConfig.tracker);
    if (config.injectLastN <= 0) return null;
    const scanLimit = Math.max(1, config.contextWindow);
    const raw = await this.stores.messages.getSelectedSceneHistory(branchId, scanLimit);
    const valid = raw.filter((target) => isRecordSchemaCompatible(target.record, config));
    // raw is newest-first; take the last `injectLastN` valid, then reverse to
    // oldest→newest (conversation order) for the formatter.
    const selected = valid.slice(0, config.injectLastN).reverse();
    if (selected.length === 0) return null;
    return {
      entries: selected.map((target) => target.record.sceneState),
      format: config.promptFormat,
      injectionDepth: config.injectionDepth,
      injectPrompt: config.injectPrompt ?? "",
    };
  }

  async buildPipelineContext(input: AssemblePromptForChatInput): Promise<BuiltPipelineContext> {
    const chat = await this.stores.chats.getById(input.chatId);
    if (!chat) {
      throw new Error(`Chat '${input.chatId}' was not found.`);
    }

    const branchId = input.branchId ?? (chat.activeBranchId as ChatBranchId);
    const branches = await this.stores.chats.getBranches(chat.id);
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) {
      throw new Error(`Branch '${branchId}' was not found for chat '${chat.id}'.`);
    }
    const branchMessages = await this.stores.messages.getMessages(branchId);

    const character = await this.resolver.getCharacter(chat.characterId);
    const allPersonas = await this.stores.personas.listAll();
    const effectivePersonaId = chat.personaId ?? allPersonas.find(p => p.defaultForNewChats)?.id ?? allPersonas[0]?.id ?? "";
    const persona = await this.resolver.getPersona(effectivePersonaId);
    const promptPresetId = input.presetId ?? chat.promptPresetId
      ?? (await this.stores.presets.listAll()).find(p => p.isDefault)?.id;
    const promptPreset = promptPresetId ? await this.resolver.getPromptPreset(promptPresetId) : null;

    logSendDebug("prompt.assemble.context", {
      chatId: chat.id as ChatId,
      personaId: chat.personaId ?? "(default)",
      personaResolved: persona ? { id: persona.id, name: persona.name, descLength: persona.description.length } : null,
      promptPresetId: chat.promptPresetId,
      promptPresetResolved: promptPreset ? { id: promptPreset.id, name: promptPreset.name, systemLength: promptPreset.text.length } : null,
    });
    const excludedMessageIds = new Set(input.excludeMessageIds ?? []);
    // Scene history backfill: bound the window to the branch prefix through the
    // target message inclusive, so each target is generated from only the history
    // that preceded it (no future-turn bleed). When set, the target's turn is the
    // natural end of the window.
    const prefixBound = (() => {
      if (!input.throughMessageId) return false;
      const idx = branchMessages.findIndex((message) => message.id === input.throughMessageId);
      if (idx < 0) return false;
      for (const message of branchMessages.slice(idx + 1)) excludedMessageIds.add(message.id as MessageId);
      return true;
    })();
    const branchSummaries = input.summary
      ? []
      : await this.stores.chatSummaries.listByChatBranch(chat.id, branchId);
    const enabledSummaries = branchSummaries.filter((summary) => summary.includeInContext && summary.content.trim());
    const excludedRanges = branchSummaries
      .filter((summary) => summary.includeInContext && summary.excludeSummarized && summary.summarizedTo >= summary.summarizedFrom)
      .map((summary) => ({ from: summary.summarizedFrom, to: summary.summarizedTo }));
    const isInExcludedSummaryRange = (position: number) => {
      const oneBasedPosition = position + 1;
      return excludedRanges.some((range) => oneBasedPosition >= range.from && oneBasedPosition <= range.to);
    };
    const filteredMessages = branchMessages.filter((message) =>
      !excludedMessageIds.has(message.id as MessageId) && !isInExcludedSummaryRange(message.position),
    );
    // Send/regenerate require the final user turn even when history filters
    // omit it. Summary callers instead choose an exact range and append their
    // own synthetic final user instruction after assembly, so exclusions win.
    const lastUserMsg = (input.summary || prefixBound)
      ? undefined
      : [...branchMessages].reverse().find((message) => message.role === "user");
    const ensureLastUser = lastUserMsg && !filteredMessages.some((message) => message.id === lastUserMsg.id)
      ? [...filteredMessages, lastUserMsg]
      : filteredMessages;
    const messageLimit = input.recentMessageLimit ?? (chat.messageHistoryLimit || Infinity);
    const windowedMessages = ensureLastUser
      .slice(-(messageLimit === Infinity ? ensureLastUser.length : messageLimit));

    // Batch-load bound Dice rolls for the windowed messages (Wave B5 / DICE-B14).
    // One batched read (no N+1) over already-bound immutable snapshots —
    // no Dice-script execution or rerolling on the assembly / preview / summary /
    // insight read paths. All consumers (generate, contextPreview, summary,
    // objective/scene one-shots) go through buildPipelineContext, so they all
    // read identical stored values.
    const diceRollsByMessage = await this.stores.diceRolls.getRollsForMessages(
      windowedMessages.map((message) => message.id),
    );

    const recentMessages = windowedMessages.map((message) => {
      const rolls = diceRollsByMessage.get(message.id);
      return {
        id: message.id as MessageId,
        role: message.role as 'system' | 'user' | 'assistant' | 'tool',
        content: message.content,
        ...(message.attachmentsJson ? { attachments: parseStoredAttachments(message.attachmentsJson) ?? [] } : {}),
        ...(rolls?.length ? { diceRolls: rolls.map(storeRollToSnapshot) } : {}),
      };
    });

    const recentText = recentMessages.map((message) => message.content).join("\n");
    const activeLoreEntries = await this.resolver.listActiveLoreEntries({
      chatId: chat.id as ChatId,
      branchId,
      recentText,
      maxContextTokens: input.contextBudget ?? undefined,
    });
    const retrievedMemories = await this.resolver.listRetrievedMemories({
      chatId: chat.id as ChatId,
      branchId,
      recentText,
    });

    // Execute scripts AFTER lore activation, BEFORE prompt assembly.
    // Scripts can read active lore entries and mutate character fields.
    // Token estimation in makeLayer() will reflect post-script text.
    const scriptResult = await this.resolver.executeScripts({
      chatId: chat.id as ChatId,
      characterRecord: {
        name: character.name,
        personality: character.personality ?? null,
        scenario: character.scenario ?? null,
      },
      messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
      activeLoreEntries,
      persona: persona ? { name: persona.name, description: persona.description } : undefined,
    });

    // Apply script mutations to character fields in-place
    const mutatedPersonality = scriptResult.personality;
    const mutatedScenario = scriptResult.scenario;

    // Set model hint so estimateTokens uses the model-specific tokenizer
    setModelHint(input.model);

    // ─── A7: media context — gallery descriptions (one read). Pre-filter to
    // described rows the user explicitly selected for inclusion (D7): per-image
    // includeInPrompt is the sole gate now (the deprecated character-level
    // includeGalleryInPrompt field is no longer read). Undescribed images
    // carry no prompt value, and includeInPrompt defaults OFF so a gallery
    // only injects what the user opts in per-image.
    const gallery = (await this.stores.characterAssets.listByCharacter(character.id))
        .filter((row) => row.description?.trim() && row.includeInPrompt)
        .map((row) => ({ caption: row.caption || `gallery-${row.id}`, description: row.description!.trim() }));

    const objectiveTask = resolveObjectiveTaskContext({
      insightsConfig: chat.insightsConfig,
      insightsObjectiveState: chat.insightsObjectiveState,
    });
    const objectiveLongTerm = resolveObjectiveLongTermContext({
      insightsConfig: chat.insightsConfig,
      insightsObjectiveState: chat.insightsObjectiveState,
    });

    // Scene Tracker (SCENE_TRACKER_PLAN SCN-7): query the last `injectLastN`
    // VALID selected-variant records from the active branch (freshness-filtered
    // via isRecordSchemaCompatible — schema-coherent with the current prompt) and hand them to
    // the pipeline as the `sceneState` injection layer. null when the tracker is
    // off, injectLastN is 0, or no current-scene records exist in the window.
    const sceneState = await this.resolveSceneInjection(chat.insightsConfig, branchId);

    const pipelineContext = {
      identity: {
        chatId: chat.id as ChatId,
      },
      character: {
        id: character.id,
        name: character.name,
        description: character.description,
        scenario: mutatedScenario,
        systemPrompt: character.systemPrompt,
        personality: mutatedPersonality,
        mesExample: character.mesExample,
        mesExampleMode: (character.mesExampleMode as "always" | "once" | "depth") ?? "always",
        mesExampleDepth: character.mesExampleDepth ?? 4,
        postHistoryInstructions: character.postHistoryInstructions,
        depthPrompt: character.depthPrompt,
        depthPromptDepth: character.depthPromptDepth,
        depthPromptRole: (character.depthPromptRole as "system" | "user" | "assistant") ?? "system",
        // Media (A7) — avatar/gallery appearance text injection.
        avatarDescription: character.avatarDescription,
        includeAvatarInPrompt: character.includeAvatarInPrompt,
        gallery,
        includeGalleryInPrompt: character.includeGalleryInPrompt,
      },
      persona,
      preset: promptPreset
        ? {
            id: promptPreset.id,
            name: promptPreset.name,
            text: promptPreset.text,
            jailbreak: promptPreset.jailbreak,
            summary: promptPreset.summary,
            tools: promptPreset.tools,
            prefill: promptPreset.prefill,
            authorsNote: promptPreset.authorsNote,
            authorsNoteDepth: promptPreset.authorsNoteDepth,
            authorsNotePosition: (promptPreset.authorsNotePosition as "in_prompt" | "in_chat" | "after_chat") ?? "in_chat",
            authorsNoteRole: (promptPreset.authorsNoteRole as "system" | "user" | "assistant") ?? "system",
            nsfw: promptPreset.nsfw,
            enhanceDefinitions: promptPreset.enhanceDefinitions,
            advancedMode: promptPreset.advancedMode,
            mergeConsecutiveRoles: promptPreset.mergeConsecutiveRoles,
            customInjections: promptPreset.customInjections,
            promptOrder: promptPreset.promptOrder,
          }
        : null,
      lore: activeLoreEntries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        priority: entry.priority,
        position: entry.position,
        depth: entry.depth,
        role: entry.role,
        sortOrder: entry.sortOrder,
      })),
      memory: {
        summary: enabledSummaries.length > 0
          ? enabledSummaries.map((summary) => ({ id: summary.id, kind: summary.source, summary: summary.content }))
          : (chat.summary?.trim() ? [{ id: `chat_summary_${chat.id}`, kind: "chat", summary: chat.summary }] : []),
        retrieval: retrievedMemories.map((memory) => ({
          id: memory.id,
          sourceType: memory.sourceType,
          content: memory.content,
          score: memory.score,
        })),
      },
      objectiveTask,
      objectiveLongTerm,
      sceneState,
      chat: {
        recentMessages,
        scriptInjections: scriptResult.injectedMessages,
      },
      instructions: {
        toolInstructions: [promptPreset?.tools, this.resolver.getToolInstructions()].filter(Boolean).join("\n") || null,
      },
      config: {
        contextBudget: input.contextBudget ?? null,
        responseReserve: input.responseReserve ?? 0,
        model: input.model,
        summary: input.summary,
      },
      // SPC-3: hand the preceding-chain priors to the pipeline ONLY on the
      // summary path. The pipeline emits `prior_summaries_context` from this;
      // absent or empty → no layer (byte-equivalent to the chat turn).
      ...(input.summary && input.priorSummaries?.length
        ? { priorSummaries: input.priorSummaries }
        : {}),
    };

    return {
      context: pipelineContext,
      branchId,
      chatId: chat.id as ChatId,
      chatPromptPresetId: chat.promptPresetId ?? null,
      promptPresetId: promptPresetId ?? null,
      promptPresetName: promptPreset?.name ?? null,
      activeLoreEntries,
      retrievedMemories,
      scriptResult,
      recentMessageCount: recentMessages.length,
    };
  }

  async exportTraceToFile(traceId: string): Promise<string> {
    const trace = await this.stores.traces.getTrace(traceId);
    if (!trace) {
      throw new Error(`Prompt trace '${traceId}' was not found.`);
    }
    // data/traces/{yyyy-mm-dd}/{promptTraceId}.json
    const date = trace.createdAt.split("T")[0];
    const filePath = this.fileStore.resolvePath(
      STORAGE_FOLDERS.traces,
      `${date}/${traceId}.json`,
    );
    await this.fileStore.writeJson(filePath, trace);
    return filePath;
  }
}

function mapPromptLayerDto(layer: {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceName: string;
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
  injectionDepth?: number;
  modes?: string[];
}): PromptLayerDto {
  return {
    id: layer.id,
    sourceType: layer.sourceType,
    sourceId: layer.sourceId,
    sourceName: layer.sourceName,
    position: layer.position,
    priority: layer.priority,
    enabled: layer.enabled,
    reason: layer.reason,
    tokenCount: layer.tokenCount,
    text: layer.text,
    injectionDepth: layer.injectionDepth,
    modes: layer.modes,
  };
}
