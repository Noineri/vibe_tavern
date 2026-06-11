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
import type { VisionGateConfig } from "./vision-gate.js";
import { resolveMultimodalContent } from "./vision-gate.js";
import { log } from "@vibe-tavern/domain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A validated SDK message with known role and string content. */
export interface SdkMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** File attachments on this message, passed through for vision gate resolution. */
  attachments?: import("@vibe-tavern/domain").Attachment[];
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
  conversationMessages: Array<SdkMessage | { role: SdkMessage["role"]; content: Array<{ type: "text"; text: string } | { type: "image"; image: Buffer; mediaType?: string }> }>;
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
      const attachments = Array.isArray((r as { attachments?: unknown }).attachments)
        ? (r as { attachments?: import("@vibe-tavern/domain").Attachment[] }).attachments
        : undefined;
      return { role: r.role as SdkMessage["role"], content: r.content, ...(attachments?.length ? { attachments } : {}) };
    })
    .filter((m): m is SdkMessage => m !== null);
}

// ---------------------------------------------------------------------------
// prepareSdkMessages
// ---------------------------------------------------------------------------

/**
 * Prepare prompt messages for provider execution.
 *
 * For most providers, preserve the exact role/order assembled in the prompt
 * trace — system messages stay in their original positions so that e.g. an
 * author's note after the latest user message remains the final instruction
 * seen by the model.
 *
 * For Google Generative AI, system messages must all be at the start of the
 * conversation. We merge all system messages into a single leading system
 * message, preserving their relative order, followed by the non-system
 * messages in their original order.
 */
export async function prepareSdkMessages(
  messages: SdkMessage[],
  options: {
    prefill?: string;
    providerType: ProviderType;
    visionGate?: VisionGateConfig;
    assetLoader?: (assetId: string) => Promise<Buffer | null>;
  },
): Promise<PreparedMessages> {
  const capabilities = getProviderCapabilities(options.providerType);
  let conversationMessages: SdkMessage[];

  if (options.providerType === "google") {
    // Google requires system messages only at the beginning.
    // Merge all system messages into one, keep non-system in original order.
    const systemParts: string[] = [];
    const nonSystem: SdkMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        nonSystem.push(msg);
      }
    }

    conversationMessages = systemParts.length > 0
      ? [{ role: "system", content: systemParts.join("\n\n") }, ...nonSystem]
      : nonSystem;
  } else {
    conversationMessages = [...messages];
  }

  if (options.prefill && capabilities.prefill) {
    conversationMessages.push({ role: "assistant", content: options.prefill });
  }

  // Resolve multimodal content (image attachments → ImageParts)
  if (options.visionGate && options.assetLoader) {
    conversationMessages = await Promise.all(
      conversationMessages.map(async (msg) => {
        if ("attachments" in msg && msg.attachments?.length) {
          const content = await resolveMultimodalContent(msg, options.visionGate!, options.assetLoader!);
          return { role: msg.role, content };
        }
        return msg;
      }),
    ) as typeof conversationMessages;
  }

  return { systemPrompt: undefined, conversationMessages };
}
