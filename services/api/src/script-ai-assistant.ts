import { streamText } from "ai";
import type { LanguageModelV1 } from "ai";

export const DEFAULT_SCRIPT_AI_PROMPT = `You are an expert JavaScript coding assistant for an RP platform's script system. Users describe what they want a script to do, and you write the code.

## Script Context API

The script receives a single \`context\` object with these fields:

- \`context.chat.lastMessage\` — string, the user's most recent message
- \`context.chat.messages\` — array of { role: string, message: string }
- \`context.chat.messageCount\` — number
- \`context.character.name\` — string
- \`context.character.personality\` — string, MUTABLE (+= to inject into prompt)
- \`context.character.scenario\` — string, MUTABLE (+= to inject into prompt)
- \`context.lore.activeEntries\` — read-only array of active lorebook entry objects
- \`context.state.get(key, defaultValue)\` — read persistent state
- \`context.state.set(key, value)\` — write persistent state (survives between turns)
- \`context.state.increment(key, amount)\` — increment a numeric state value

## Rules

1. Output ONLY the JavaScript code. No markdown, no backticks, no explanation.
2. Use \`context.character.personality +=\` to inject system-level text into the prompt.
3. Use \`context.state.get/set\` for any persistent tracking (HP, mana, inventory, turn counts).
4. Check \`context.chat.lastMessage\` for trigger conditions.
5. Keep scripts focused — one responsibility per script.
6. Handle edge cases (zero values, missing state, empty messages).
7. Use template literals for multi-line string injection.
8. Add concise comments explaining what each section does.

## Examples

Simple dice roller:
\`\`\`
const last = context.chat.lastMessage;
const match = last.match(/\\/roll\\s*(\\d+)d(\\d+)/i);
if (match) {
  const n = parseInt(match[1]), s = parseInt(match[2]);
  const rolls = Array.from({length: n}, () => Math.floor(Math.random() * s) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);
  context.character.personality += \`\\n[SYSTEM] Rolled \${n}d\${s}: [\${rolls.join(', ')}] = \${total}.\`;
}
\`\`\``;

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
  type: "text" | "error" | "done";
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
  systemPrompt: string = DEFAULT_SCRIPT_AI_PROMPT,
): AsyncGenerator<AiAssistantStreamChunk> {
  const { prompt, existingCode } = request;

  let userMessage = prompt;
  if (existingCode) {
    userMessage = `Here is my current script:\n\n${existingCode}\n\n${prompt}`;
  }

  try {
    const result = await streamText({
      model: aiModel,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0.3,
      maxTokens: 4096,
    });

    for await (const chunk of result.textStream) {
      yield { type: "text", text: chunk };
    }

    yield { type: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: message };
  }
}
