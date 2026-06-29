import type {
  ChatBranchId,
  ChatId,
  MessageId,
} from "./ids.js";
import type { ActivatedLoreDetail } from "./entities.js";

export interface PromptLayerDto {
  id: string;
  sourceType: string;
  sourceId: string;
  /** Human-readable label for the trace UI. */
  sourceName: string;
  position: "before_prompt" | "in_prompt" | "in_chat" | "hidden_system";
  priority: number;
  enabled: boolean;
  reason: string;
  tokenCount: number;
  text: string;
  injectionDepth?: number;
  modes?: string[];
}

export interface AssemblePromptResponse {
  layers: PromptLayerDto[];
  tokenAccounting: Record<string, number>;
  activatedLoreEntries: string[];
  /**
   * Per-entry activation detail for the trace UI (why each entry activated).
   * Optional — older traces / partial responses omit it. Parallel to
   * `activatedLoreEntries` (same ids, in activation order).
   */
  activatedLoreDetail?: ActivatedLoreDetail[];
  scriptInjections: Array<{
    scriptId: string;
    scriptName: string;
    personalityMutation: string;
    scenarioMutation: string;
    /** Per-script injected messages (P4). Absent on traces persisted before
     *  the per-script-row change — those carry only the aggregate. */
    injectedMessages?: Array<{ content: string; role: 'system' | 'user' | 'assistant' }>;
    /** Per-script console capture (P1). Absent on old traces. */
    console?: Array<{ level: 'log' | 'warn' | 'error'; args: string }>;
    /** Per-script run status (P4). Absent on old traces (which used a single
     *  synthetic '__pipeline' row that always represented the whole pipeline). */
    status?: 'ran' | 'errored';
    /** Source line of the error, when `status === 'errored'`. */
    line?: number;
    error?: string;
  }>;
  retrievedMemories: Array<Record<string, unknown>>;
  finalPayload: Record<string, unknown>;
  prefill?: string | null;
  /** Human-readable compaction summary shown as a warning badge in the trace UI. Not sent to the model. */
  compactionSummary?: string | null;
  /** Snapshot of what was actually sent to the provider (system role, sampler config, message count). */
  sentConfig?: {
    systemRole: string | undefined;
    samplerConfig: Record<string, unknown>;
    messageCount: number;
    visionDescriptions?: Array<{
      attachmentId: string;
      name: string;
      type: "image" | "video";
      description: string;
    }>;
  };
}

export interface PromptTraceRecordDto extends AssemblePromptResponse {
  id: string;
  chatId: ChatId;
  branchId: ChatBranchId;
  messageId: MessageId;
  model: string;
  presetName: string;
  latencyMs: number;
  createdAt: string;
}

export interface PromptPresetDto {
  id: string;
  name: string;
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: "in_prompt" | "in_chat" | "after_chat";
  authorsNoteRole: "system" | "user" | "assistant";
  summary: string;
  tools: string;
  nsfw: string;
  enhanceDefinitions: string;
  customInjections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  advancedMode: boolean;
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Prompt Slot (unified visual position) ─────────────────────────────────

/** Which of the three canvas zones a prompt block lives in. */
export type PromptZone = "before_chat" | "in_chat" | "after_chat";

/** Absolute visual position on the prompt canvas. */
export interface PromptSlot {
  /** Canvas zone. */
  zone: PromptZone;
  /**
   * Messages from end (1–N) for in_chat zone.
   * null for before_chat and after_chat zones.
   */
  depth: number | null;
  /** Sort order within the same zone+depth bucket. Lower = earlier. */
  order: number;
}

// ─── Advanced Prompt Order (attached to PromptPreset) ───────────────────────

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
  /** Sort order within the same zone (+ depth bucket). Dense ascending 0,1,2,… within a zone. */
  order: number;
  /** Visual canvas zone. */
  zone: PromptZone;
  /** Chat depth for `in_chat` items (`null` for `before_chat`/`after_chat`). `in_chat` items MUST carry `depth ≥ 1` so they never collide with `after_chat` (pinned to depth 0) — see ordering model. */
  depth: number | null;
  kind: "built_in" | "custom";
}

// ─── Custom Injections (attached to PromptPreset) ───────────────────────────
//
// Content-only (CANVAS_SINGLE_SOURCE_PLAN, I2). Positional state (zone/depth/
// order/enabled) lives ONLY on the matching `PromptOrderEntry` in `promptOrder`.
// `role` is content metadata (the message role in assembly) and is taken from
// the ST preset block at import — distinct from ST's role-*grouping* algorithm
// (merging same-role prompts on a depth), which is intentionally NOT replicated.

export interface CustomInjection {
  identifier: string;
  name: string;
  content: string;
  role: 'system' | 'user' | 'assistant';
}

export interface ProviderProbeResponse {
  success: boolean;
  error?: string;
  modelCount?: number;
}
