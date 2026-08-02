/**
 * Shared utilities for stream and non-streaming provider executors.
 *
 * Contains the common message parsing, model resolution, and message
 * preparation logic that was previously duplicated across
 * stream-provider-executor.ts and nonstreaming-provider-executor.ts.
 */

import type { LanguageModel, ModelMessage, ToolCallPart, ToolContent, AssistantContent } from "ai";
import { COAUTHOR_TRANSPORT, PROVIDER_TYPE, normalizeProviderType, type CoauthorTransport, type ProviderType, log } from "@vibe-tavern/domain";
import { resolveProtocol } from "../../domain/providers/protocol-registry.js";
import type { ProviderFetch } from "../../domain/providers/provider-fetch-factory.js";
import { createOpenAI } from "@ai-sdk/openai";
import type { VisionGateConfig } from "./vision-gate.js";
import { resolveMultimodalContent } from "./vision-gate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A validated SDK message with a known role. Content shape is role-bound:
 *  string for system/user/assistant; an array of tool-result parts for tool.
 *  `toolCalls` rides only on assistant messages and is folded into `content`
 *  as `ToolCallPart[]` when mapped to an SDK `AssistantModelMessage` (the SDK
 *  has no top-level `toolCalls` field — calls live inside `content`). */
export type SdkMessage =
  | { role: "system"; content: string; attachments?: import("@vibe-tavern/domain").Attachment[] }
  | { role: "user"; content: string; attachments?: import("@vibe-tavern/domain").Attachment[] }
  | { role: "assistant"; content: string; attachments?: import("@vibe-tavern/domain").Attachment[]; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: unknown[]; attachments?: import("@vibe-tavern/domain").Attachment[] };

/** Result of preparing messages for provider execution. */
export interface PreparedMessages {
  /**
   * Top-level system prompt is intentionally unused for chat generation.
   * System messages remain in `conversationMessages` to preserve the exact
   * role/order shown in prompt traces.
   */
  systemPrompt?: undefined;
  /** Prompt messages in trace order, mapped to SDK `ModelMessage[]`. */
  conversationMessages: ModelMessage[];
}

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

/**
 * Resolve a Vercel AI SDK Responses model for the Co-Author Responses transport.
 *
 * Uses `@ai-sdk/openai` directly (not `@ai-sdk/openai-compatible`) because
 * `responses()` is only available on the OpenAI-specific provider. The base URL
 * and API key come from the stored provider profile so aggregator/3rd-party
 * endpoints that proxy the Responses API work too.
 */
function resolveResponsesModel(
  profile: { endpoint: string; apiKey: string | null },
  model: string,
  fetch?: ProviderFetch,
): LanguageModel {
  const endpoint = (profile.endpoint || "").replace(/\/+$/, "");
  const apiKey = profile.apiKey ?? "";
  const provider = createOpenAI({
    apiKey: apiKey || "not-needed",
    baseURL: endpoint || "https://api.openai.com/v1",
    // Inject the proxy-aware fetch so the Responses transport honors the
    // profile's proxy policy; omit when direct to keep the SDK's default fetch.
    ...(fetch ? { fetch } : {}),
  });
  return provider.responses(model);
}

/**
 * Resolve a Vercel AI SDK language model for an explicit execution transport.
 *
 * The default remains the existing protocol adapter so RP, summaries, vision,
 * AI assistants, and provider tests cannot inherit a profile's Co-Author-only
 * preference by accident. Only a caller that explicitly threads `responses`
 * reaches the Responses resolver.
 */
export function resolveModel(
  profile: { providerPreset: string; endpoint: string; apiKey: string | null },
  model: string,
  transport: CoauthorTransport = COAUTHOR_TRANSPORT.chatCompletions,
  fetch?: ProviderFetch,
): LanguageModel {
  const providerType = normalizeProviderType(profile.providerPreset);
  if (transport === COAUTHOR_TRANSPORT.responses) {
    if (providerType !== PROVIDER_TYPE.openaiCompat) {
      throw new Error(`Responses transport is available only for OpenAI-compatible providers; '${profile.providerPreset}' uses '${providerType}'.`);
    }
    return resolveResponsesModel(profile, model, fetch);
  }
  return resolveProtocol(providerType).resolveModel(profile, model, fetch);
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
      const r = record as { role?: unknown; content?: unknown; toolCalls?: unknown };
      if (typeof r.role !== "string") return null;
      if (r.role !== "system" && r.role !== "user" && r.role !== "assistant" && r.role !== "tool") {
        log.tag("sdk-msgs").warn("FILTERED out role=%s", r.role);
        return null;
      }
      
      const isTool = r.role === "tool";
      if (isTool && !Array.isArray(r.content)) return null;
      if (!isTool && typeof r.content !== "string") return null;

      const attachments = Array.isArray((r as { attachments?: unknown }).attachments)
        ? (r as { attachments?: import("@vibe-tavern/domain").Attachment[] }).attachments
        : undefined;

      // Build per-role so the discriminated `SdkMessage` union narrows without
      // casts. `role` is already narrowed to the four valid literals above, so
      // branching on it lets TS pick the right union arm. Tool content is an
      // array (validated) but its element shape is not checked at this layer —
      // the SDK receives it as `ToolContent`; element shape is the prompt
      // assembler's contract (see coauthor-prompt.ts).
      if (r.role === "tool") {
        const msg: SdkMessage = { role: "tool", content: r.content as unknown[] };
        if (attachments?.length) msg.attachments = attachments;
        return msg;
      }
      if (r.role === "assistant") {
        const msg: SdkMessage = { role: "assistant", content: r.content as string };
        if (attachments?.length) msg.attachments = attachments;
        if (Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
          msg.toolCalls = r.toolCalls as ToolCallPart[];
        }
        return msg;
      }
      const msg: SdkMessage = { role: r.role, content: r.content as string };
      if (attachments?.length) msg.attachments = attachments;
      return msg;
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
  const capabilities = resolveProtocol(options.providerType).capabilities;
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

  // Map to SDK `ModelMessage[]`. Attachments only ever live on user
  // messages by design (see `toSdkMessages` + executor filtering), so only
  // user content can become multimodal `UserContent` after vision resolution.
  const conversationModelMessages: ModelMessage[] = await Promise.all(
    conversationMessages.map(async (msg): Promise<ModelMessage> => {
      if (msg.attachments?.length && options.visionGate && options.assetLoader) {
        const parts = await resolveMultimodalContent(msg, options.visionGate, options.assetLoader);
        return { role: "user", content: parts };
      }
      switch (msg.role) {
        case "system":
          return { role: "system", content: msg.content };
        case "assistant": {
          // AssistantModelMessage has NO top-level `toolCalls` field — tool calls
          // live INSIDE `content` as `ToolCallPart[]` (AssistantContent). The
          // prior code attached them as a stray top-level field, which the SDK
          // silently ignored — so co-author turns lost their cross-turn tool-call
          // context in the assembled history. RP is unaffected (no tool calls).
          if (msg.toolCalls?.length) {
            const parts: AssistantContent = [...msg.toolCalls];
            if (msg.content) parts.push({ type: "text", text: msg.content });
            return { role: "assistant", content: parts };
          }
          return { role: "assistant", content: msg.content };
        }
        case "user":
          return { role: "user", content: msg.content };
        case "tool":
          // `msg.content` is an array whose element shape is the prompt
          // assembler's contract (ToolResultPart-shaped); validated there, not
          // re-checked at this provider boundary. Narrow once to ToolContent.
          return { role: "tool", content: msg.content as ToolContent };
      }
    }),
  );

  return { systemPrompt: undefined, conversationMessages: conversationModelMessages };
}
