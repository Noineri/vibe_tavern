import { streamText } from "ai";
import type { LanguageModelV1 } from "ai";
import { resolve } from "node:path";

/** Load the system prompt from the adjacent .md file. Cached after first read. */
let _cachedPrompt: string | null = null;

export async function getDefaultScriptAiPrompt(): Promise<string> {
  if (_cachedPrompt) return _cachedPrompt;
  const mdPath = resolve(import.meta.dir, "script-ai-prompt.md");
  _cachedPrompt = await Bun.file(mdPath).text();
  return _cachedPrompt;
}

export interface AiAssistantRequest {
  /** User's description of what the script should do */
  prompt: string;
  /** Optional existing code to refine/modify */
  existingCode?: string;
  /** Provider profile ID to use */
  providerProfileId: string;
  /** Model name override (optional, uses profile default) */
  model?: string;
}

export interface AiAssistantStreamChunk {
  type: "text" | "reasoning" | "error" | "done";
  text?: string;
  error?: string;
}

/**
 * Stream AI-generated script code via SSE.
 * Takes a pre-resolved AI model instance.
 */
export async function* streamScriptCode(
  request: AiAssistantRequest,
  aiModel: LanguageModelV1,
  systemPrompt?: string,
): AsyncGenerator<AiAssistantStreamChunk> {
  const { prompt, existingCode } = request;
  const system = systemPrompt ?? await getDefaultScriptAiPrompt();

  let userMessage = prompt;
  if (existingCode) {
    userMessage = `Here is my current script:\n\n${existingCode}\n\nModification request:\n${prompt}\n\nReturn the complete updated JavaScript script only. Do not return a patch, diff, markdown, or explanation. Preserve unrelated code exactly where possible.`;
  }

  try {
    const result = await streamText({
      model: aiModel,
      system,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0.3,
    });

    let reasoningBuffer = "";
    let insideReasoning = false;

    for await (const chunk of result.textStream) {
        // Detect reasoning markers from openai-reasoning-fetch.ts
        if (chunk.includes('REASONING_START')) {
          insideReasoning = true;
          const after = chunk.split('REASONING_START').pop() ?? '';
          reasoningBuffer += after;
          yield { type: "reasoning", text: after };
          continue;
        }
        if (insideReasoning && chunk.includes('REASONING_END')) {
          insideReasoning = false;
          const before = chunk.split('REASONING_END')[0];
          reasoningBuffer += before;
          if (before) yield { type: "reasoning", text: before };
          // Text after REASONING_END is actual code
          const after = chunk.split('REASONING_END').slice(1).join('REASONING_END');
          if (after) yield { type: "text", text: after };
          continue;
        }
        if (insideReasoning) {
          reasoningBuffer += chunk;
          yield { type: "reasoning", text: chunk };
        } else {
          // Also strip <think[\\s\\S]*?<\\/think> tags (DeepSeek style)
          const cleaned = chunk.replace(/<think[\s\S]*?<\/think>/g, '');
          if (cleaned) yield { type: "text", text: cleaned };
        }
    }

    yield { type: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  }
}
