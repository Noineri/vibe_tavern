/**
 * Provider execution contract types for the Vercel AI SDK migration.
 *
 * These types define the normalized boundary between the application and
 * provider adapters. FW-AI2 will implement adapters that conform to this
 * contract. The existing ProviderManager.generateReply() path remains
 * unchanged until FW-AI2 swaps it.
 */

import type { AssemblePromptResponse } from "@rp-platform/domain";
import type { ProviderType } from "@rp-platform/domain";
import type { StoredProviderProfileRecord } from "@rp-platform/domain";

// ---------------------------------------------------------------------------
// Provider profile reference (subset needed for generation)
// ---------------------------------------------------------------------------

/** Lightweight profile reference passed into the execution boundary. */
/**
 * @deprecated Use StoredProviderProfileRecord from @rp-platform/domain instead.
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
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  minP?: number | null;
  topK?: number | null;
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
  /** Usage metadata if the provider returns it. */
  usage?: GenerationUsage;
}

export interface GenerationUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// ---------------------------------------------------------------------------
// Streaming execution types (FW-AI2)
// ---------------------------------------------------------------------------

/** Single chunk emitted by the streaming executor. */
export interface ProviderStreamChunk {
  type: "text-delta";
  delta: string;
}

/** Final metadata resolved when the stream completes. */
export interface ProviderStreamFinish {
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "cancelled";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/** Result returned by the streaming executor. */
export interface ProviderStreamResult {
  stream: AsyncIterable<ProviderStreamChunk>;
  finished: Promise<ProviderStreamFinish>;
  text: Promise<string>;
}

/** Input to the streaming executor. */
export interface ProviderExecutionInput {
  profile: StoredProviderProfileRecord;
  model: string;
  prompt: AssemblePromptResponse;
  signal?: AbortSignal;
  prefill?: string;
  /** Override the profile's maxTokens for this specific call (e.g. summarization). */
  overrideMaxTokens?: number;
}

/** Streaming executor function signature. */
export type ProviderExecutor = (input: ProviderExecutionInput) => Promise<ProviderStreamResult>;

// ---------------------------------------------------------------------------
// Provider error categories
// ---------------------------------------------------------------------------

export type ProviderErrorCategory =
  | "network"
  | "authentication"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "timeout"
  | "aborted"
  | "empty_response"
  | "parse_error"
  | "unknown";

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
