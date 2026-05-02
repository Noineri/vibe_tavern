/**
 * Non-streaming provider executor using Vercel AI SDK generateText().
 *
 * Makes a single non-streaming API call and returns the complete response.
 * Avoids SSE stream collection issues with providers that don't terminate
 * their streaming responses correctly (e.g. nanoGPT).
 */

import { generateText } from "ai";
import type { GenerationResult } from "./provider-execution-types.js";
import type { ProviderExecutionInput } from "./provider-execution-types.js";
import { mapProfileToSdkModel } from "./provider-profile-mapper.js";
import { cancelled, providerError } from "../errors.js";
import { logSendDebug } from "../send-debug-log.js";

function resolveModel(profile: { type: string; endpoint: string; apiKey: string | null }, model: string) {
  const mapping = mapProfileToSdkModel(profile, model);
  return mapping.model;
}

function toSdkMessages(prompt: { finalPayload?: unknown }): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const payload = prompt.finalPayload as { messages?: unknown } | undefined;
  const records = Array.isArray(payload?.messages) ? payload.messages : [];

  return records
    .map((record: unknown) => {
      if (!record || typeof record !== "object") return null;
      const r = record as { role?: unknown; content?: unknown };
      if (typeof r.role !== "string" || typeof r.content !== "string") return null;
      if (r.role !== "system" && r.role !== "user" && r.role !== "assistant") return null;
      return { role: r.role as "system" | "user" | "assistant", content: r.content };
    })
    .filter((m): m is { role: "system" | "user" | "assistant"; content: string } => m !== null);
}

export async function nonstreamingProviderExecute(
  input: ProviderExecutionInput,
): Promise<GenerationResult> {
  try {
    const model = resolveModel(input.profile, input.model);
    const messages = toSdkMessages(input.prompt);

    const systemMessages = messages.filter(m => m.role === "system");
    const conversationMessages = messages.filter(m => m.role !== "system");
    const systemPrompt = systemMessages.map(m => m.content).join("\n\n") || undefined;

    const result = await generateText({
      model,
      messages: conversationMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      abortSignal: input.signal,
      temperature: input.profile.temperature ?? undefined,
      topP: input.profile.topP ?? undefined,
      maxTokens: input.profile.maxTokens ?? undefined,
    });

    logSendDebug("provider.nonstream.result", {
      textLength: result.text.length,
      textPreview: result.text.slice(0, 200),
      reasoningLength: (result as any).reasoning?.length ?? undefined,
      reasoningDetailsCount: (result as any).reasoningDetails?.length ?? undefined,
      finishReason: result.finishReason,
      usage: result.usage
        ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, totalTokens: result.usage.totalTokens }
        : null,
      providerMetadata: result.providerMetadata
        ? JSON.stringify(result.providerMetadata).slice(0, 500)
        : null,
      stepsCount: (result as any).steps?.length ?? undefined,
    });

    return {
      text: result.text,
      usage: result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
    };
  } catch (error) {
    if (input.signal?.aborted) throw cancelled();
    throw providerError(error instanceof Error ? error.message : String(error));
  }
}
