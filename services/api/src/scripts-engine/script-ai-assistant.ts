import { streamText } from "ai";
import type { LanguageModelV1 } from "ai";
import { join, resolve } from "node:path";
import { REASONING_END_MARKER, REASONING_START_MARKER } from "../ai/openai-reasoning-fetch.js";

/** Load the system prompt from the adjacent .md file. Cached after first read. */
let _cachedPrompt: string | null = null;

export async function resolveScriptAiPromptPath(): Promise<string> {
  const candidates = [
    process.env.RP_PLATFORM_SCRIPT_AI_PROMPT,
    // Standalone artifact: prompt next to executable.
    join(resolve(process.execPath, ".."), "script-ai-prompt.md"),
    // API artifacts: Bun.build flat output or tsc module output.
    resolve(import.meta.dir, "script-ai-prompt.md"),
    resolve(import.meta.dir, "..", "script-ai-prompt.md"),
    // Source/dev mode still uses the canonical copied runtime asset in out/.
    resolve(import.meta.dir, "..", "..", "..", "..", "out", "services", "api", "script-ai-prompt.md"),
    join(process.cwd(), "out", "services", "api", "script-ai-prompt.md"),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }

  return candidates[candidates.length - 1];
}

export async function getDefaultScriptAiPrompt(): Promise<string> {
  if (_cachedPrompt) return _cachedPrompt;
  const mdPath = await resolveScriptAiPromptPath();
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

export interface ReasoningSplitState {
  buffer: string;
  insideMarkerReasoning: boolean;
  insideThinkTag: boolean;
}

const THINK_START = "<think";
const THINK_END = "</think>";

function findEarliestToken(input: string, tokens: readonly string[]): { token: string; index: number } | null {
  let best: { token: string; index: number } | null = null;
  for (const token of tokens) {
    const index = input.indexOf(token);
    if (index !== -1 && (!best || index < best.index)) {
      best = { token, index };
    }
  }
  return best;
}

function partialPrefixLength(input: string, tokens: readonly string[]): number {
  const max = Math.min(input.length, Math.max(...tokens.map((token) => token.length - 1)));
  for (let length = max; length > 0; length--) {
    const suffix = input.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) return length;
  }
  return 0;
}

function pushChunk(
  out: AiAssistantStreamChunk[],
  type: "text" | "reasoning",
  text: string,
): void {
  if (text) out.push({ type, text });
}

export function splitReasoningFromText(
  state: ReasoningSplitState,
  chunk: string,
  options: { flush?: boolean } = {},
): AiAssistantStreamChunk[] {
  const out: AiAssistantStreamChunk[] = [];
  state.buffer += chunk;

  while (state.buffer.length > 0) {
    if (state.insideThinkTag) {
      const endIndex = state.buffer.indexOf(THINK_END);
      if (endIndex === -1) {
        const keep = options.flush ? 0 : partialPrefixLength(state.buffer, [THINK_END]);
        const emitLength = state.buffer.length - keep;
        pushChunk(out, "reasoning", state.buffer.slice(0, emitLength));
        state.buffer = state.buffer.slice(emitLength);
        break;
      }
      pushChunk(out, "reasoning", state.buffer.slice(0, endIndex));
      state.buffer = state.buffer.slice(endIndex + THINK_END.length);
      state.insideThinkTag = false;
      continue;
    }

    if (state.insideMarkerReasoning) {
      const endIndex = state.buffer.indexOf(REASONING_END_MARKER);
      if (endIndex === -1) {
        const keep = options.flush ? 0 : partialPrefixLength(state.buffer, [REASONING_END_MARKER]);
        const emitLength = state.buffer.length - keep;
        pushChunk(out, "reasoning", state.buffer.slice(0, emitLength));
        state.buffer = state.buffer.slice(emitLength);
        break;
      }
      pushChunk(out, "reasoning", state.buffer.slice(0, endIndex));
      state.buffer = state.buffer.slice(endIndex + REASONING_END_MARKER.length);
      state.insideMarkerReasoning = false;
      continue;
    }

    const token = findEarliestToken(state.buffer, [REASONING_START_MARKER, THINK_START]);
    if (!token) {
      const keep = options.flush ? 0 : partialPrefixLength(state.buffer, [REASONING_START_MARKER, THINK_START]);
      const emitLength = state.buffer.length - keep;
      pushChunk(out, "text", state.buffer.slice(0, emitLength));
      state.buffer = state.buffer.slice(emitLength);
      break;
    }

    pushChunk(out, "text", state.buffer.slice(0, token.index));
    state.buffer = state.buffer.slice(token.index);

    if (state.buffer.startsWith(REASONING_START_MARKER)) {
      state.buffer = state.buffer.slice(REASONING_START_MARKER.length);
      state.insideMarkerReasoning = true;
      continue;
    }

    const thinkTagEnd = state.buffer.indexOf(">");
    if (thinkTagEnd === -1) break;
    state.buffer = state.buffer.slice(thinkTagEnd + 1);
    state.insideThinkTag = true;
  }

  return out;
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

    const splitState: ReasoningSplitState = {
      buffer: "",
      insideMarkerReasoning: false,
      insideThinkTag: false,
    };

    for await (const chunk of result.textStream) {
      for (const parsed of splitReasoningFromText(splitState, chunk)) {
        yield parsed;
      }
    }

    for (const parsed of splitReasoningFromText(splitState, "", { flush: true })) {
      yield parsed;
    }

    yield { type: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  }
}
