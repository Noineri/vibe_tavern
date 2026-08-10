/**
 * AI-assistant interactive_rules mode tests (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 8 / IR-82).
 *
 * Verifies the code-generating sibling of dice_script:
 *  - `interactive_rules` is a complete assistant mode (registered in the
 *    assembler registry + mode config with its own asset).
 *  - Prompt selection resolves to `interactive-rules.md` on disk (non-empty),
 *    describing the real `context.experience.register` contract.
 *  - The generic `script` preset/legacy override stays prompt-only
 *    (interactive_rules has no legacyColumn → scriptAiSystemPrompt does NOT
 *    leak into it), and a script-mode preset key is isolated.
 *  - Generated rules-source cleanup path (markdown-fence stripping), both via
 *    the exported `cleanGeneratedCode` and through the live stream.
 *  - Prompt-input/privacy: the assembled request contains ONLY the declared
 *    context (API reference + existing source + instruction); no
 *    chat/persona/character/RP leakage.
 *  - Failure: a provider error surfaces as a typed `{ type: "error" }` chunk,
 *    not a crash.
 *  - Cancellation: abandoning the async generator mid-iteration stops cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  AI_ASSISTANT_ASSEMBLERS,
  getAiAssistantAssembler,
  setTokenCountFn,
} from "@vibe-tavern/prompt-pipeline";
import { getAllModeConfigs, getModeConfig } from "../src/domain/ai-assistant/ai-assistant-modes.js";
import {
  resolveSystemPrompt,
  resolvePromptPathForMode,
} from "../src/domain/ai-assistant/ai-assistant-prompts.js";
import { cleanGeneratedCode, streamAiAssistant, type StreamDeps } from "../src/domain/ai-assistant/ai-assistant-stream.js";
import { createOllamaModel } from "../src/domain/providers/ollama-adapter.js";

function deps(overrides: Partial<StreamDeps> = {}): StreamDeps {
  return {
    getCharacterById: async () => null,
    getPersonaById: async () => null,
    getLoreEntryById: async () => null,
    resolveModel: () => ({}) as never,
    getProviderProfile: async () => ({ id: "profile_1", providerPreset: "openai", endpoint: "", apiKey: "key", defaultModel: "model_1", contextBudget: null, maxTokens: 2000, proxyMode: "inherit", proxyId: null }),
    getEffectiveProviderProfile: async () => ({ id: "profile_1", providerPreset: "openai", endpoint: "", apiKey: "key", defaultModel: "model_1", contextBudget: null, maxTokens: 2000, proxyMode: "inherit", proxyId: null }),
    getPresetPromptData: async () => ({ aiAssistantPrompts: null, scriptAiSystemPrompt: null }),
    getChatMessages: async () => [],
    getMessageEditorChat: async () => null,
    getMessageEditorMessages: async () => [],
    getMessageEditorVariantsByBranch: async () => new Map(),
    buildMessageEditorPipelineContext: async () => { throw new Error("message editor context is not configured"); },
    ...overrides,
  };
}

/** Build an Ollama-style NDJSON response from one or more content deltas. */
function ndjsonResponse(contentChunks: Array<{ role: string; content: string }>): Response {
  const lines = contentChunks.map((c) => JSON.stringify({ message: { role: c.role, content: c.content }, done: false }));
  lines.push(JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }));
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
}

const baseRequest = {
  mode: "interactive_rules" as const,
  instruction: "DESIGN_DIRECTION_MARKER build a round-based scoring game",
  existingContent: "EXISTING_RULES_MARKER context.experience.register({ apiVersion: 1 });",
  providerProfileId: "profile_1",
  enabledLayers: [],
};

describe("interactive_rules — registry completeness", () => {
  it("has an assembler in the registry", () => {
    expect(AI_ASSISTANT_ASSEMBLERS.interactive_rules).toBeDefined();
    expect(typeof getAiAssistantAssembler("interactive_rules").assemble).toBe("function");
  });

  it("has a complete mode config mirroring dice_script (code-generating)", () => {
    const config = getModeConfig("interactive_rules");
    expect(config.mode).toBe("interactive_rules");
    expect(config.presetKey).toBe("interactive_rules");
    expect(config.defaultPromptFile).toBe("interactive-rules.md");
    expect(config.stripReasoning).toBe(true);
    expect(config.outputFormat).toBe("text");
    expect(config.jsonSchemaHint).toBeNull();
    // NO legacyColumn — the generic script preset/legacy stays prompt-only.
    expect(config.legacyColumn).toBeUndefined();
  });

  it("is included in getAllModeConfigs", () => {
    const modes = getAllModeConfigs().map((c) => c.mode);
    expect(modes).toContain("interactive_rules");
  });
});

describe("interactive_rules — prompt selection", () => {
  it("resolves to interactive-rules.md on disk (packaged asset path verified)", async () => {
    const path = await resolvePromptPathForMode("interactive_rules");
    expect(path.endsWith("interactive-rules.md")).toBe(true);
    expect(await Bun.file(path).exists()).toBe(true);
  });

  it("the default prompt is non-empty and describes the register contract + sandbox bounds", async () => {
    const { prompt, source } = await resolveSystemPrompt("interactive_rules", {
      aiAssistantPrompts: null,
      scriptAiSystemPrompt: null,
    });
    expect(source).toBe("default_md");
    expect(prompt.length).toBeGreaterThan(0);
    // The prompt must reference the real registration + method contract.
    expect(prompt).toContain("context.experience.register");
    expect(prompt).toContain("apiVersion");
    expect(prompt).toContain("reduce");
    // It must declare the sandbox bounds (no DOM/window for rules source).
    expect(prompt).toContain("window");
    expect(prompt).toContain("synchronous");
  });

  it("a preset override for interactive_rules wins", async () => {
    const { prompt, source } = await resolveSystemPrompt("interactive_rules", {
      aiAssistantPrompts: { interactive_rules: "CUSTOM RULES PROMPT" },
    });
    expect(source).toBe("preset_override");
    expect(prompt).toBe("CUSTOM RULES PROMPT");
  });

  it("scriptAiSystemPrompt does NOT leak into interactive_rules (no legacy column)", async () => {
    const { source } = await resolveSystemPrompt("interactive_rules", {
      aiAssistantPrompts: null,
      scriptAiSystemPrompt: "LEGACY SCRIPT PROMPT — MUST NOT LEAK",
    });
    expect(source).toBe("default_md");
  });

  it("a script-mode preset override does NOT leak into interactive_rules (presetKey isolation)", async () => {
    const { source } = await resolveSystemPrompt("interactive_rules", {
      aiAssistantPrompts: { script: "WRONG KEY", dice_script: "ALSO WRONG" },
    });
    expect(source).toBe("default_md");
  });
});

describe("interactive_rules — generated code cleanup", () => {
  it("strips a surrounding markdown code fence (```js ... ```)", () => {
    const fenced = "```js\ncontext.experience.register({ apiVersion: 1 });\n```";
    expect(cleanGeneratedCode(fenced)).toBe("context.experience.register({ apiVersion: 1 });");
  });

  it("strips a bare fence (``` ... ```)", () => {
    const fenced = "```\nvar x = 1;\n```";
    expect(cleanGeneratedCode(fenced)).toBe("var x = 1;");
  });

  it("leaves unfenced code unchanged (trimmed)", () => {
    const raw = "  \ncontext.experience.register({});\n  ";
    expect(cleanGeneratedCode(raw)).toBe("context.experience.register({});");
  });
});

describe("interactive_rules — stream behavior", () => {
  beforeEach(() => setTokenCountFn((text) => text.length));
  afterEach(() => setTokenCountFn(() => 0));

  const streamDeps = deps({
    resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
  });

  it("assembles only the declared context (API reference + existing source + instruction); no chat/persona/character leakage", async () => {
    const CHARACTER_SECRET = "SECRET_CHARACTER_BIO_MARKER";
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).text());
      return ndjsonResponse([{ role: "assistant", content: "context.experience.register({});" }]);
    };
    try {
      const chunks: Array<{ type: string }> = [];
      for await (const chunk of streamAiAssistant(baseRequest, deps({
        resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
        // A character IS available in the store — it must NEVER be pulled in by
        // this code-generation mode (no characterIds bound from the real UI).
        getCharacterById: async () => ({ id: "c1", name: "Leaker", description: CHARACTER_SECRET, personality: "", scenario: "" }),
      }))) {
        chunks.push(chunk);
      }
      const body = bodies[0];
      expect(body).toBeDefined();
      // Declared context present: the register API reference (system prompt),
      // the current rules source, and the user's design direction.
      expect(body).toContain("context.experience.register");
      expect(body).toContain("EXISTING_RULES_MARKER");
      expect(body).toContain("DESIGN_DIRECTION_MARKER");
      // No RP / chat / persona / character / session leakage.
      expect(body).not.toContain(CHARACTER_SECRET);
      // The stream reached the cleaned final text + done.
      expect(chunks.some((c) => c.type === "text")).toBe(true);
      expect(chunks[chunks.length - 1]?.type).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cleans a fenced model reply to raw register({...}) source via the stream path", async () => {
    const fenced = "```js\ncontext.experience.register({ apiVersion: 1, manifest: { id: 'x', name: 'X' } });\n```";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ndjsonResponse([{ role: "assistant", content: fenced }]);
    try {
      const chunks: Array<{ type: string; text?: string }> = [];
      for await (const chunk of streamAiAssistant(baseRequest, streamDeps)) chunks.push(chunk);
      const textChunk = chunks.find((c) => c.type === "text");
      expect(textChunk).toBeTruthy();
      // Raw executable source: no prose fence.
      expect(textChunk!.text).toBe("context.experience.register({ apiVersion: 1, manifest: { id: 'x', name: 'X' } });");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a provider error as a typed failure, not a crash", async () => {
    // A missing/unresolvable provider profile is a provider error. The stream
    // must surface it as a typed `{ type: "error" }` chunk and terminate
    // cleanly — never an unhandled throw that crashes the consumer.
    const chunks: Array<{ type: string; error?: string }> = [];
    for await (const chunk of streamAiAssistant(
      { ...baseRequest, providerProfileId: "missing_profile" },
      deps({ getProviderProfile: async () => null }),
    )) {
      chunks.push(chunk);
    }
    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk).toBeTruthy();
    expect(errChunk!.error).toContain("Provider profile not found");
    // The generator terminated without throwing (the for-await completed).
  });

  it("stops cleanly when the consumer abandons the stream early", async () => {
    // A multi-delta response; the stripReasoning path buffers it server-side
    // and yields one final text chunk. Abandoning the generator before the
    // trailing `done` must terminate without hanging or throwing.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ndjsonResponse([
      { role: "assistant", content: "context.experience.register({});" },
      { role: "assistant", content: " // tail" },
    ]);
    try {
      const seen: string[] = [];
      // Bounded consumption: stop as soon as the first chunk is observed.
      for await (const chunk of streamAiAssistant(baseRequest, streamDeps)) {
        seen.push(chunk.type);
        break;
      }
      expect(seen.length).toBe(1);
      // Reaching this assertion without throwing / timing out proves the
      // abandoned generator stopped cleanly.
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
