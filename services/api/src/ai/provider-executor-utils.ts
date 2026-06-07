/**
 * Shared utilities for stream and non-streaming provider executors.
 *
 * Contains the common message parsing, model resolution, and message
 * preparation logic that was previously duplicated across
 * stream-provider-executor.ts and nonstreaming-provider-executor.ts.
 */

import type { LanguageModel } from "ai";
import { mapProfileToSdkModel } from "./provider-profile-mapper.js";
import { getProviderCapabilities } from "./provider-capabilities.js";
import type { ProviderType } from "@vibe-tavern/domain";
import { log } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A validated SDK message with known role and string content. */
export interface SdkMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Result of preparing messages for provider execution. */
export interface PreparedMessages {
  /**
   * Top-level system prompt is intentionally unused for chat generation.
   * System messages remain in `conversationMessages` to preserve the exact
   * role/order shown in prompt traces.
   */
  systemPrompt?: undefined;
  /** Prompt messages in trace order, with optional prefill appended. */
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
  profile: { providerPreset: string; endpoint: string; apiKey: string | null },
  model: string,
): LanguageModel {
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
      if (r.role !== "system" && r.role !== "user" && r.role !== "assistant") {
        log.tag("sdk-msgs").warn("FILTERED out role=%s, content.length=%d", r.role, (r.content as string)?.length ?? 0);
        return null;
      }
      return { role: r.role as SdkMessage["role"], content: r.content };
    })
    .filter((m): m is SdkMessage => m !== null);
}

// ---------------------------------------------------------------------------
// prepareSdkMessages
// ---------------------------------------------------------------------------

/**
 * Preserve prompt message role/order exactly as assembled in the prompt trace,
 * and optionally inject a provider-supported assistant prefill at the end.
 *
 * Do not extract system messages into the top-level `system` option: that
 * changes recency/ordering semantics (e.g. an authors note after the latest
 * user message stops being the final instruction seen by the model).
 */
export function prepareSdkMessages(
  messages: SdkMessage[],
  options: { prefill?: string; providerType: ProviderType },
): PreparedMessages {
  const capabilities = getProviderCapabilities(options.providerType);
  const conversationMessages = [...messages];

  if (options.prefill && capabilities.prefill) {
    conversationMessages.push({ role: "assistant", content: options.prefill });
  }

  return { systemPrompt: undefined, conversationMessages };
}
