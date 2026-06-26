/**
 * Provider execution contract types for the Vercel AI SDK migration.
 *
 * These types define the normalized boundary between the application and
 * provider adapters. FW-AI2 will implement adapters that conform to this
 * contract. The existing ProviderManager.generateReply() path remains
 * unchanged until FW-AI2 swaps it.
 */

import type { AssemblePromptResponse } from "@vibe-tavern/domain";
import type { ProviderType } from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import type { ProviderErrorCategory } from "@vibe-tavern/api-contracts";
import type { ToolSet } from "ai";

// ---------------------------------------------------------------------------
// Provider profile reference (subset needed for generation)
// ---------------------------------------------------------------------------

/** Lightweight profile reference passed into the execution boundary. */
/**
 * @deprecated Use StoredProviderProfileRecord from @vibe-tavern/domain instead.
 * Kept for backward compatibility with existing non-streaming path.
 */
export interface ProviderProfileRef {
  id: string;
  type: ProviderType;
  endpoint: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Generation input
// ---------------------------------------------------------------------------

/** Model selection and generation parameters. */
export interface GenerationModelSettings {
  model: string;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  minP?: number | null;
  topK?: number | null;
  topA?: number | null;
  typicalP?: number | null;
  tfsZ?: number | null;
  repeatLastN?: number | null;
  mirostat?: number | null;
  mirostatTau?: number | null;
  mirostatEta?: number | null;
  dryMultiplier?: number | null;
  dryBase?: number | null;
  dryAllowedLength?: number | null;
  drySequenceBreakers?: string[] | null;
  xtcThreshold?: number | null;
  xtcProbability?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  repetitionPenalty?: number | null;
  stopSequences?: string[] | null;
  seed?: number | string | null;
  reasoningEffort?: string | null;
}

/** Full input to the provider execution boundary. */
export interface GenerationInput {
  profile: ProviderProfileRef;
  settings: GenerationModelSettings;
  prompt: AssemblePromptResponse;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Generation result
// ---------------------------------------------------------------------------

/** Non-streaming generation result. */
export interface GenerationResult {
  /** The generated text content. */
  text: string;
  /** Reasoning/thinking content if the model returns it. */
  reasoning?: string;
  /** Usage metadata if the provider returns it. */
  usage?: GenerationUsage;
  /** Snapshot of what was sent to the provider. */
  sentConfig?: SentConfigSnapshot;
}

export interface GenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Snapshot of what was actually sent to the provider for a generation call. */
export interface SentConfigSnapshot {
  /** Whether any system-role messages were sent in the message array. */
  systemRole: "system" | undefined;
  /** Sampler config that was spread into streamText()/generateText(). */
  samplerConfig: Record<string, unknown>;
  /** Number of messages sent to the provider, preserving prompt trace order. */
  messageCount: number;
  /** Optional human-readable description snapshot for vision fallback attachments. */
  visionDescriptions?: Array<{
    attachmentId: string;
    name: string;
    type: "image" | "video";
    description: string;
  }>;
}

// ---------------------------------------------------------------------------
// Streaming execution types (FW-AI2)
// ---------------------------------------------------------------------------

/** Single chunk emitted by the streaming executor. */
export type ProviderStreamChunk =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; textDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; isError?: boolean };

/** Final metadata resolved when the stream completes. */
export interface ProviderStreamFinish {
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "cancelled";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/** Result returned by the streaming executor. */
export interface ProviderStreamResult {
  stream: AsyncIterable<ProviderStreamChunk>;
  finished: Promise<ProviderStreamFinish>;
  text: Promise<string>;
  /** Final reasoning text collected from the stream (resolved after stream ends). */
  reasoning: Promise<string | undefined>;
  /** True if a redacted-reasoning chunk was encountered. */
  hasRedactedReasoning: boolean;
  /** Snapshot of what was sent to the provider. */
  sentConfig?: SentConfigSnapshot;
}

/** Input to the streaming executor. */
export interface ProviderExecutionInput {
  profile: StoredProviderProfileRecord;
  model: string;
  prompt: AssemblePromptResponse;
  signal?: AbortSignal;
  prefill?: string;
  /** Override the profile's maxOutputTokens for this specific call (e.g. summarization). */
  overrideMaxTokens?: number;
  /** AI SDK tools to pass to streamText(). AI SDK handles validation, execution, and multi-turn loop. */
  tools?: ToolSet;
  /** Max multi-step tool-calling rounds per generation. */
  maxSteps?: number;
  /** Cached models for the active provider, used for vision capability lookup. */
  cachedModels?: Array<{ modelSlug: string; capabilities?: { vision?: boolean } }>;
  /** Vision model slug from the provider profile, used for image description fallback. */
  visionModel?: string | null;
  /** Asset loader for reading attachment files. */
  assetLoader?: (assetId: string) => Promise<Buffer | null>;
  /** Callback to persist attachment descriptions back to the user message. */
  onAttachmentDescriptions?: (descriptions: Array<{ attachmentId: string; description: string }>) => Promise<void>;
  /** System prompt for the vision describe model. Resolved from preset or default MD. */
  visionDescribePrompt?: string;
}

/** Streaming executor function signature. */
export type ProviderExecutor = (input: ProviderExecutionInput) => Promise<ProviderStreamResult>;

// ---------------------------------------------------------------------------
// Provider error categories
// ---------------------------------------------------------------------------

/**
 * Re-exported from {@link @vibe-tavern/api-contracts} so backend call sites that
 * already import it from this module keep compiling. The canonical definition
 * lives in the shared wire-types module because the category now crosses the
 * RPC boundary (SSE `error` event + JSON error body).
 */
export type { ProviderErrorCategory };

/** Normalized error thrown by the execution boundary. */
export class ProviderExecutionError extends Error {
  readonly category: ProviderErrorCategory;
  readonly providerType: ProviderType;
  readonly statusCode?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    category: ProviderErrorCategory,
    providerType: ProviderType,
    options?: { statusCode?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "ProviderExecutionError";
    this.category = category;
    this.providerType = providerType;
    this.statusCode = options?.statusCode;
    this.cause = options?.cause;
  }
}
