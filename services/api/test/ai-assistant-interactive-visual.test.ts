/**
 * AI-assistant interactive_visual mode tests (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 8 / IR-83A — BACKEND ONLY).
 *
 * Verifies the visual-generation sibling of interactive_rules, which is
 * DISTINCT in contract: it takes the rules source ONLY to DISCOVER the
 * validated game contract (manifest/capabilities/setup) via the real sandbox,
 * feeds ONLY those validated shapes (NOT the raw rules logic) into the prompt
 * alongside the host-bridge reference + existing visual + direction, and emits
 * VISUAL source only. It can never modify rules in the same generation.
 *
 * Pinned behavior:
 *  - `interactive_visual` is a complete assistant mode (registered in the
 *    assembler registry + mode config with its own asset).
 *  - Prompt selection resolves to `interactive-visual.md` on disk (non-empty),
 *    describing the real host-bridge contract + isolated-iframe bounds.
 *  - The generic `script` preset/legacy override stays prompt-only
 *    (interactive_visual has no legacyColumn → scriptAiSystemPrompt does NOT
 *    leak into it), and a script-mode preset key is isolated.
 *  - Generated visual-source cleanup path (markdown-fence stripping for HTML),
 *    both via the exported `cleanGeneratedVisualSource` and through the live stream.
 *  - Discovery: a valid rules source produces a prompt containing the discovered
 *    manifest/capabilities (and NOT the raw rules body); a broken rules body
 *    surfaces a typed discovery failure (no hallucinated visual); a missing
 *    rules source surfaces a typed validation error. The REAL
 *    `discoverExperienceDefinition` runs (the kernel is NOT stubbed).
 *  - Prompt-input/privacy: the assembled request contains ONLY the declared
 *    visual context; no chat/persona/character/RP leakage.
 *  - Rules immutability: the OUTPUT is visual source only; the raw rules logic
 *    never reaches the prompt.
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
import { cleanGeneratedVisualSource, streamAiAssistant, type StreamDeps } from "../src/domain/ai-assistant/ai-assistant-stream.js";
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

/**
 * A minimal REAL rules body that passes discovery. Declares the `participants`
 * capability so the discovered contract carries a non-empty capability list the
 * tests can assert. The leading comment marker is RAW rules content that must
 * NEVER reach the prompt (only the discovered manifest/capabilities shapes do).
 */
const RAW_RULES_SECRET_MARKER = "RAW_RULES_BODY_SECRET_MARKER_DO_NOT_LEAK";
const VALID_RULES = `// ${RAW_RULES_SECRET_MARKER}
context.experience.register({
  apiVersion: 1,
  manifest: { id: "counter", name: "Counter Game" },
  capabilities: [{ capability: "participants", reason: "per-player turns" }],
  create() { return { count: 0 }; },
  project(context) { return { count: context.state.count }; },
  actions() { return [{ type: "increment", label: "Increment" }]; },
  reduce(context, action) {
    var s = context.state;
    if (action.type === "increment") { return { state: { count: s.count + 1 }, status: "active", events: [{ visibility: "public", type: "incremented" }] }; }
    return { state: s, status: "active", events: [] };
  }
});`;

const baseRequest = {
  mode: "interactive_visual" as const,
  instruction: "DESIGN_DIRECTION_MARKER build a counter visual",
  existingContent: "EXISTING_VISUAL_MARKER <div id='xp-root'></div>",
  interactiveRulesSource: VALID_RULES,
  providerProfileId: "profile_1",
  enabledLayers: [],
};

describe("interactive_visual — registry completeness", () => {
  it("has an assembler in the registry", () => {
    expect(AI_ASSISTANT_ASSEMBLERS.interactive_visual).toBeDefined();
    expect(typeof getAiAssistantAssembler("interactive_visual").assemble).toBe("function");
  });

  it("has a complete mode config mirroring interactive_rules (code-generating)", () => {
    const config = getModeConfig("interactive_visual");
    expect(config.mode).toBe("interactive_visual");
    expect(config.presetKey).toBe("interactive_visual");
    expect(config.defaultPromptFile).toBe("interactive-visual.md");
    expect(config.stripReasoning).toBe(true);
    expect(config.outputFormat).toBe("text");
    expect(config.jsonSchemaHint).toBeNull();
    // NO legacyColumn — the generic script preset/legacy stays prompt-only.
    expect(config.legacyColumn).toBeUndefined();
  });

  it("is included in getAllModeConfigs", () => {
    const modes = getAllModeConfigs().map((c) => c.mode);
    expect(modes).toContain("interactive_visual");
  });
});

describe("interactive_visual — prompt selection", () => {
  it("resolves to interactive-visual.md on disk (packaged asset path verified)", async () => {
    const path = await resolvePromptPathForMode("interactive_visual");
    expect(path.endsWith("interactive-visual.md")).toBe(true);
    expect(await Bun.file(path).exists()).toBe(true);
  });

  it("the default prompt is non-empty and describes the host bridge + iframe bounds", async () => {
    const { prompt, source } = await resolveSystemPrompt("interactive_visual", {
      aiAssistantPrompts: null,
      scriptAiSystemPrompt: null,
    });
    expect(source).toBe("default_md");
    expect(prompt.length).toBeGreaterThan(0);
    // The prompt must reference the real host bridge contract.
    expect(prompt).toContain("VibeExperience.connect");
    expect(prompt).toContain("onView");
    expect(prompt).toContain("act");
    // It must describe the isolated-iframe runtime bounds.
    expect(prompt).toContain("sandbox");
    expect(prompt).toContain("iframe");
  });

  it("a preset override for interactive_visual wins", async () => {
    const { prompt, source } = await resolveSystemPrompt("interactive_visual", {
      aiAssistantPrompts: { interactive_visual: "CUSTOM VISUAL PROMPT" },
    });
    expect(source).toBe("preset_override");
    expect(prompt).toBe("CUSTOM VISUAL PROMPT");
  });

  it("scriptAiSystemPrompt does NOT leak into interactive_visual (no legacy column)", async () => {
    const { source } = await resolveSystemPrompt("interactive_visual", {
      aiAssistantPrompts: null,
      scriptAiSystemPrompt: "LEGACY SCRIPT PROMPT — MUST NOT LEAK",
    });
    expect(source).toBe("default_md");
  });

  it("a script-mode preset override does NOT leak into interactive_visual (presetKey isolation)", async () => {
    const { source } = await resolveSystemPrompt("interactive_visual", {
      aiAssistantPrompts: { script: "WRONG KEY", dice_script: "ALSO WRONG", interactive_rules: "ALSO WRONG" },
    });
    expect(source).toBe("default_md");
  });
});

describe("interactive_visual — generated visual-source cleanup", () => {
  it("strips a surrounding ```html fence", () => {
    const fenced = "```html\n<style>.x{color:red}</style>\n<div id=\"xp-root\"></div>\n<script>xp=window.VibeExperience.connect(function(){});</script>\n```";
    expect(cleanGeneratedVisualSource(fenced)).toBe("<style>.x{color:red}</style>\n<div id=\"xp-root\"></div>\n<script>xp=window.VibeExperience.connect(function(){});</script>");
  });

  it("strips a bare fence (``` ... ```)", () => {
    const fenced = "```\n<div></div>\n```";
    expect(cleanGeneratedVisualSource(fenced)).toBe("<div></div>");
  });

  it("strips a ```javascript fence", () => {
    const fenced = "```javascript\nvar x = 1;\n```";
    expect(cleanGeneratedVisualSource(fenced)).toBe("var x = 1;");
  });

  it("leaves unfenced source unchanged (trimmed)", () => {
    const raw = "  \n<div id='xp-root'></div>\n  ";
    expect(cleanGeneratedVisualSource(raw)).toBe("<div id='xp-root'></div>");
  });
});

describe("interactive_visual — discovery + stream behavior", () => {
  beforeEach(() => setTokenCountFn((text) => text.length));
  afterEach(() => setTokenCountFn(() => 0));

  const streamDeps = deps({
    resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
  });

  it("discovers the contract and assembles only validated shapes (manifest/capabilities), NOT the raw rules body", async () => {
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).text());
      return ndjsonResponse([{ role: "assistant", content: "<div id='xp-root'></div>" }]);
    };
    try {
      const chunks: Array<{ type: string }> = [];
      for await (const chunk of streamAiAssistant(baseRequest, streamDeps)) {
        chunks.push(chunk);
      }
      const body = bodies[0];
      expect(body).toBeDefined();
      // Discovered validated shapes ARE present: the manifest name + the
      // declared capability reach the prompt.
      expect(body).toContain("Counter Game");
      expect(body).toContain("participants");
      // The existing visual source + the user's design direction ARE present.
      expect(body).toContain("EXISTING_VISUAL_MARKER");
      expect(body).toContain("DESIGN_DIRECTION_MARKER");
      // The RAW RULES BODY never reaches the prompt — only the discovered
      // shapes do (rules immutability: rules are a discovery INPUT only).
      expect(body).not.toContain(RAW_RULES_SECRET_MARKER);
      expect(body).not.toContain("context.state.count");
      // The stream reached the cleaned final text + done.
      expect(chunks.some((c) => c.type === "text")).toBe(true);
      expect(chunks[chunks.length - 1]?.type).toBe("done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("contains NO chat/persona/character leakage even when a character with a secret is available", async () => {
    const CHARACTER_SECRET = "SECRET_CHARACTER_BIO_MARKER";
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).text());
      return ndjsonResponse([{ role: "assistant", content: "<div></div>" }]);
    };
    try {
      for await (const _chunk of streamAiAssistant(baseRequest, deps({
        resolveModel: (_profile, model) => createOllamaModel({ baseURL: "http://ai-assistant.test", modelId: model }),
        // A character IS available in the store — it must NEVER be pulled in by
        // this code-generation mode (no characterIds bound from the real UI).
        getCharacterById: async () => ({ id: "c1", name: "Leaker", description: CHARACTER_SECRET, personality: "", scenario: "" }),
      }))) {
        // drain
      }
      const body = bodies[0];
      expect(body).toBeDefined();
      // No RP / chat / persona / character / session leakage.
      expect(body).not.toContain(CHARACTER_SECRET);
      expect(body).not.toContain("Leaker");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cleans a fenced ```html model reply to raw visual source via the stream path", async () => {
    const fenced = "```html\n<style>.x{color:red}</style>\n<div id=\"xp-root\"></div>\n<script>(function(){var xp=window.VibeExperience.connect(function(){});})();</script>\n```";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ndjsonResponse([{ role: "assistant", content: fenced }]);
    try {
      const chunks: Array<{ type: string; text?: string }> = [];
      for await (const chunk of streamAiAssistant(baseRequest, streamDeps)) chunks.push(chunk);
      const textChunk = chunks.find((c) => c.type === "text");
      expect(textChunk).toBeTruthy();
      // Raw visual source: no prose fence.
      expect(textChunk!.text).toBe("<style>.x{color:red}</style>\n<div id=\"xp-root\"></div>\n<script>(function(){var xp=window.VibeExperience.connect(function(){});})();</script>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a broken rules body as a typed discovery failure (no hallucinated visual)", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return ndjsonResponse([{ role: "assistant", content: "<div></div>" }]); };
    try {
      const chunks: Array<{ type: string; error?: string }> = [];
      for await (const chunk of streamAiAssistant(
        { ...baseRequest, interactiveRulesSource: "context.experience.register({ broken syntax ;; }" },
        streamDeps,
      )) {
        chunks.push(chunk);
      }
      const errChunk = chunks.find((c) => c.type === "error");
      expect(errChunk).toBeTruthy();
      // The discovery failure is described as a contract-validation problem.
      expect(errChunk!.error).toContain("validate the interactive rules contract");
      // No model call was made — discovery failed before streaming started.
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a missing rules source as a typed validation error", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return ndjsonResponse([{ role: "assistant", content: "<div></div>" }]); };
    try {
      const chunks: Array<{ type: string; error?: string }> = [];
      const { interactiveRulesSource: _omit, ...requestWithoutSource } = baseRequest;
      void _omit;
      for await (const chunk of streamAiAssistant(
        requestWithoutSource,
        streamDeps,
      )) {
        chunks.push(chunk);
      }
      const errChunk = chunks.find((c) => c.type === "error");
      expect(errChunk).toBeTruthy();
      expect(errChunk!.error).toContain("validated interactive rules contract");
      expect(fetchCalled).toBe(false);
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
  });

  it("stops cleanly when the consumer abandons the stream early", async () => {
    // A multi-delta response; the stripReasoning path buffers it server-side
    // and yields one final text chunk. Abandoning the generator before the
    // trailing `done` must terminate without hanging or throwing.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ndjsonResponse([
      { role: "assistant", content: "<div id='xp-root'></div>" },
      { role: "assistant", content: "<script></script>" },
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
