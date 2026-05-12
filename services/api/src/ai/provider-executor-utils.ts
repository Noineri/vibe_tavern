/**
 * Shared utilities for stream and non-streaming provider executors.
 *
 * Contains the common message parsing, model resolution, and message
 * preparation logic that was previously duplicated across
 * stream-provider-executor.ts and nonstreaming-provider-executor.ts.
 */

import type { LanguageModelV1 } from "ai";
import { mapProfileToSdkModel } from "./provider-profile-mapper.js";
import { getProviderCapabilities } from "./provider-capabilities.js";
import type { ProviderType } from "@rp-platform/domain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A validated SDK message with known role and string content. */
export interface SdkMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Result of separating system messages from conversation messages. */
export interface PreparedMessages {
  /** Concatenated system prompt (undefined if no system messages). */
  systemPrompt?: string;
  /** Conversation messages (non-system), with optional prefill appended. */
  conversationMessages: SdkMessage[];
}

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

/**
 * Resolve a Vercel AI SDK language model from a stored provider profile.
 * Delegates to the canonical provider-profile-mapper.
 */
export function resolveModel(
  profile: { type: string; endpoint: string; apiKey: string | null },
  model: string,
): LanguageModelV1 {
  const mapping = mapProfileToSdkModel(profile, model);
  return mapping.model;
}

// ---------------------------------------------------------------------------
// toSdkMessages
// ---------------------------------------------------------------------------

/**
 * Convert an AssemblePromptResponse into validated Vercel AI SDK message format.
 *
 * Filters out entries with non-string role/content or unknown roles.
 * Returns an empty array for missing/invalid payloads.
 */
export function toSdkMessages(
  prompt: { finalPayload?: unknown },
): SdkMessage[] {
  const payload = prompt.finalPayload as { messages?: unknown } | undefined;
  const records = Array.isArray(payload?.messages) ? payload.messages : [];

  return records
    .map((record: unknown) => {
      if (!record || typeof record !== "object") return null;
      const r = record as { role?: unknown; content?: unknown };
      if (typeof r.role !== "string" || typeof r.content !== "string") return null;
      if (r.role !== "system" && r.role !== "user" && r.role !== "assistant") return null;
      return { role: r.role as SdkMessage["role"], content: r.content };
    })
    .filter((m): m is SdkMessage => m !== null);
}

// ---------------------------------------------------------------------------
// prepareSdkMessages
// ---------------------------------------------------------------------------

/**
 * Separate system messages from conversation messages and optionally inject
 * a prefill assistant message.
 *
 * This logic was duplicated in both executors — extracted here to ensure
 * consistent behaviour between streaming and non-streaming paths.
 */
export function prepareSdkMessages(
  messages: SdkMessage[],
  options: { prefill?: string; providerType: ProviderType },
): PreparedMessages {
  const capabilities = getProviderCapabilities(options.providerType);

  const systemMessages = messages.filter(m => m.role === "system");
  const conversationMessages = messages.filter(m => m.role !== "system");
  const systemPrompt = systemMessages.map(m => m.content).join("\n\n") || undefined;

  if (options.prefill && capabilities.prefill) {
    conversationMessages.push({ role: "assistant", content: options.prefill });
  }

  return { systemPrompt, conversationMessages };
}
