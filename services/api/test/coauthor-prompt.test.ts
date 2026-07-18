import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ChatModeAssembleInput, ChatModeAssembleLoaders } from "../src/domain/chat/chat-mode-strategy.js";
import { assembleCoauthorPrompt } from "../src/domain/chat/coauthor-prompt.js";
import type { Character, Message as DbMessage, Chat as DbChat } from "@vibe-tavern/db";
import { serializeProfileMd } from "@vibe-tavern/db";

/**
 * Co-Author assembly characterization. Pins what the model + frontend can
 * rely on each turn: the editor prompt is assembled from base + skill +
 * current-card context, conversation history is forwarded, and the tool set
 * + maxSteps ride out for the executor. Pure (loaders mocked; real asset
 * files under services/api/assets/coauthor/ are read).
 */

function makeLoaders(overrides?: Partial<{
  character: Partial<Character>;
  chat: Partial<DbChat>;
  profileMd: string;
  messages: DbMessage[];
  loreEntries: Array<{ id: string; title: string; content: string }>;
  contextItems: Array<{ type: "character" | "persona" | "lorebook" | "script"; id: string; title: string; content: string }>;
  boundResources: { lorebooks: Array<{ id: string; name: string; entries: Array<{ id: string; title: string }> }>; scripts: Array<{ id: string; name: string; summary: string }> };
  userModules: Array<Omit<import("@vibe-tavern/api-contracts").CoauthorModule, "isBuiltIn">>;
  skillCatalog: import("../src/domain/coauthor/skills/skill-scanner.js").SkillCatalogEntry[];
}>): ChatModeAssembleLoaders {
  const character: Character = {
    id: "char_test",
    slug: "test",
    name: "Test",
    description: "desc",
    personalitySummary: null,
    defaultScenario: null,
    firstMessage: "The opener.",
    mesExample: null,
    mesExampleMode: "depth",
    mesExampleDepth: 4,
    alternateGreetings: ["An alt opener."],
    postHistoryInstructions: null,
    creatorNotes: null,
    characterBook: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    extensions: {},
    systemPrompt: null,
    tags: [],
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCrop: null,
    avatarExt: null,
    hasFileOnDisk: true,
    ...overrides?.character,
  } as unknown as Character;

  return {
    getChat: async () => (overrides?.chat ?? { id: "chat_test", coauthorModuleId: null }) as any,
    getMessages: async () => overrides?.messages ?? [],
    getCharacter: async () => character,
    getProfileMdText: async () => overrides?.profileMd ?? "---\nname: Test\n---\n# PERSONALITY\nA test character.\n",
    getCoauthorContextItems: async () => overrides?.contextItems ?? (overrides?.loreEntries ?? []).map((e) => ({ type: "lorebook" as const, ...e })),
    getCoauthorBoundResources: async () => overrides?.boundResources ?? { lorebooks: [], scripts: [] },
    getChatSummaries: async () => [],
    getCoauthorUserModules: async () => overrides?.userModules ?? [],
    getSkillCatalog: async () => overrides?.skillCatalog ?? DEFAULT_MOCK_CATALOG,
  };
}

function makeInput(loaders: ChatModeAssembleLoaders, partial?: Partial<ChatModeAssembleInput>): ChatModeAssembleInput {
  return {
    promptService: {} as never,
    chatId: "chat_test" as never,
    model: "test-model",
    loaders,
    ...partial,
  } as ChatModeAssembleInput;
}

/** A small hermetic catalog (does not touch disk) so prompt-assembly tests do
 *  not couple to the exact set of built-in skills (which Wave 3 reshuffles).
 *  The real scanner→catalog path is pinned in coauthor-skill-scanner.test.ts. */
const DEFAULT_MOCK_CATALOG: import("../src/domain/coauthor/skills/skill-scanner.js").SkillCatalogEntry[] = [
  {
    id: "general-writing",
    source: "builtin",
    name: "general-writing",
    description: "General writing guidance for prose, pacing, and voice.",
    skillDir: "/skills/general-writing",
    manifestPath: "/skills/general-writing/SKILL.md",
    rootRelativeManifestPath: "general-writing/SKILL.md",
    shadowsBuiltin: false,
  },
];

describe("assembleCoauthorPrompt", () => {
  test("assembles system + history + tools/maxSteps", async () => {
    const loaders = makeLoaders({
      messages: [
        { role: "user", content: "make the personality deeper" } as never,
        { role: "assistant", content: "on it" } as never,
        { role: "system", content: "filtered out" } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));

    // Tools + maxSteps ride out for the executor (CA-5 wiring).
    expect(result.tools).toBeDefined();
    expect(result.maxSteps).toBe(5);
    expect(result.tools).toHaveProperty("write_profile");
    expect(result.tools).toHaveProperty("edit_greeting");
    expect(result.tools).toHaveProperty("add_alt_greeting");

    // Final payload: one system message + the user/assistant history (system rows filtered).
    const messages = (result.prompt.finalPayload as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].role).toBe("system");
    expect(messages.length).toBe(3); // system + user + assistant
    expect(messages[1]).toEqual({ role: "user", content: "make the personality deeper" });
    expect(messages[2]).toEqual({ role: "assistant", content: "on it" });
  });

  test("system message embeds the base prompt, current card, and profile.md", async () => {
    const loaders = makeLoaders({
      profileMd: "---\nname: Test\n---\n# PERSONALITY\nA test character.\n",
      character: { firstMessage: "PRIMARY OPENER", alternateGreetings: ["ALT ONE"] },
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    // Base editor prompt marker.
    expect(system).toContain("Co-Author");
    // Current profile.md is embedded read-only.
    expect(system).toContain("# PERSONALITY");
    expect(system).toContain("A test character.");
    // Greetings rendered with their slot labels.
    expect(system).toContain("PRIMARY OPENER");
    expect(system).toContain("ALT ONE");
    expect(system).toContain("PRIMARY (firstMessage)");
    expect(system).toContain("ALT 1");
  });

  test("CED-1: model-facing profile exposes the stable three-heading skeleton even when SCENARIO/EXAMPLES are empty", async () => {
    // Storage writes `profile.md` via serializeProfileMd, which now ALWAYS emits
    // PERSONALITY/SCENARIO/EXAMPLES (bare headings for empty optionals). The
    // co-author prompt embeds that storage text verbatim (renderCurrentCard),
    // so the model must see all three headings — never a profile shape that
    // hides empty optional sections the editor exposes.
    const profileMd = serializeProfileMd({
      profile: {
        name: "Test",
        tags: [],
        creator: null,
        characterVersion: null,
        creatorNotes: null,
        mesExampleMode: "always",
        mesExampleDepth: 4,
        description: "A test character.",
        scenario: null,
        mesExample: null,
      },
    });
    // Sanity: the storage text itself carries the stable skeleton.
    expect(profileMd).toContain("# PERSONALITY");
    expect(profileMd).toContain("# SCENARIO");
    expect(profileMd).toContain("# EXAMPLES");

    const loaders = makeLoaders({ profileMd });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    // All three prose headings reach the model verbatim, in canonical order.
    expect(system).toContain("# PERSONALITY");
    expect(system).toContain("# SCENARIO");
    expect(system).toContain("# EXAMPLES");
    const persIdx = system.indexOf("# PERSONALITY");
    const scenIdx = system.indexOf("# SCENARIO");
    const exIdx = system.indexOf("# EXAMPLES");
    expect(scenIdx).toBeGreaterThan(persIdx);
    expect(exIdx).toBeGreaterThan(scenIdx);
  });

  test("CTX-S4: renders the skill catalog (metadata only) and exposes read_skill_file; no eager skill body", async () => {
    const loaders = makeLoaders({
      messages: [{ role: "user", content: "hello" } as never],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    // Catalog section: id + description + the portable manifest path the model reads.
    expect(system).toContain("# Available skills");
    expect(system).toContain("general-writing");
    expect(system).toContain("General writing guidance");
    expect(system).toContain("general-writing/SKILL.md");
    // No eager skill BODY — the model reads it on demand via read_skill_file.
    expect(system).not.toContain("# Active skill");
    // The catalog replaces the old single-skill trace layer.
    expect(result.coauthorSkillId).toBeNull();
    const skillLayer = result.prompt.layers.find((l) => l.sourceType === "coauthor_skill");
    expect(skillLayer?.id).toBe("skill_catalog");
    // read_skill_file is always available (not gated by the module toolSet).
    expect(result.tools).toHaveProperty("read_skill_file");
  });

  test("promptTraceDraft carries coauthor preset name and no RP-pipeline layers", async () => {
    const loaders = makeLoaders();
    const result = await assembleCoauthorPrompt(makeInput(loaders, { branchId: "br_1" as never }));
    expect(result.promptTraceDraft.presetName).toBe("(coauthor)");
    expect(result.promptTraceDraft.presetId).toBeNull();
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
    expect(result.promptTraceDraft.branchId).toBe("br_1");
    // CS-27 (context counter): the trace now carries the coauthor pipeline's
    // own layers so the counter UI can break the context down. These are
    // coauthor-specific sourceTypes (coauthor_profile, chat_history, ...) —
    // the RP prompt-pipeline layers (promptPreset / character*) must NOT
    // leak in, since co-author never runs the RP assembler. That is the
    // "empty RP layers" invariant the original test name expressed, updated
    // for the CS-27 reality that the trace is no longer empty.
    const sourceTypes = result.promptTraceDraft.assembledLayers.map((l) => l.sourceType);
    expect(sourceTypes).toContain("coauthor_profile");
    expect(sourceTypes).toContain("chat_history");
    const rpLayers = sourceTypes.filter((st) => st === "promptPreset" || st.startsWith("character"));
    expect(rpLayers).toEqual([]);
  });

  test("CA-13/CE-C1: pinned lorebook entries render as read-only reference in the system message", async () => {
    const entryA = {
      id: "lore_a",
      title: "The Shattered Crown",
      content: "An ancient crown broken into seven shards, each pulsing with cold light.",
    };
    const entryB = {
      id: "lore_b",
      title: "",
      content: "A constant world fact.",
    };
    const loaders = makeLoaders({ loreEntries: [entryA, entryB] });

    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    // Lore renders as a read-only reference section after the current card.
    expect(system).toContain("# Pinned context (read-only reference");
    expect(system).toContain("[Lorebook] The Shattered Crown");
    expect(system).toContain("cold light");
    // An untitled entry falls back to a placeholder header, content still present.
    expect(system).toContain("[Lorebook] (untitled)");
    expect(system).toContain("A constant world fact.");

    // Co-author does NOT run the activation engine — trace lore fields stay
    // empty (no fabricated activation reasons for user-picked entries).
    expect(result.prompt.activatedLoreEntries).toEqual([]);
    expect(result.prompt.activatedLoreDetail).toEqual([]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
  });

  test("CE-C1: pinned character/persona/script render as tagged read-only reference blocks", async () => {
    const loaders = makeLoaders({
      contextItems: [
        { type: "character", id: "char_other", title: "Mira", content: "# PERSONALITY\nA stoic ranger." },
        { type: "persona", id: "persona_1", title: "Wanderer", content: "A curious traveler." },
        { type: "script", id: "script_1", title: "greeter.js", content: "A friendly greeter.\n\n```js\nreturn hi;\n```" },
      ],
    });

    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    expect(system).toContain("# Pinned context (read-only reference");
    expect(system).toContain("[Character] Mira");
    expect(system).toContain("A stoic ranger.");
    expect(system).toContain("[Persona] Wanderer");
    expect(system).toContain("A curious traveler.");
    expect(system).toContain("[Script] greeter.js");
    expect(system).toContain("return hi;");
    // Each pinned item gets its own dedicated layer.
    const ctxLayer = result.prompt.layers.find((l) => l.id === "pinned_context");
    expect(ctxLayer).toBeTruthy();
    expect(ctxLayer!.sourceType).toBe("coauthor_context");
  });

  test("CE-C2/C3: bound lorebooks + scripts render compact awareness (entry title + stable ID, NOT content)", async () => {
    const loaders = makeLoaders({
      boundResources: {
        lorebooks: [
          {
            id: "lb_1",
            name: "World Atlas",
            entries: [
              { id: "le_aldor", title: "Kingdom of Aldor" },
              { id: "le_spine", title: "The Spine" },
            ],
          },
          { id: "lb_2", name: "Empty Book", entries: [] },
        ],
        scripts: [{ id: "sc_1", name: "greeter.js", summary: "A friendly greeter macro." }],
      },
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    // Lorebook awareness: names + entry title/ID pairs appear, so the model
    // can call CE-B1 cross-turn tools without guessing a display title as id.
    expect(system).toContain("Bound lorebooks (awareness");
    expect(system).toContain("World Atlas");
    expect(system).toContain("Kingdom of Aldor [entryId: le_aldor]");
    expect(system).toContain("The Spine [entryId: le_spine]");
    expect(system).toContain("use the shown entryId for an existing entry");
    // A book with no enabled entries shows the placeholder, not a content leak.
    expect(system).toContain("Empty Book");
    expect(system).toContain("(no enabled entries)");

    // Script awareness: name + summary appear; there is no CODE injection.
    expect(system).toContain("Bound scripts (awareness");
    expect(system).toContain("greeter.js");
    expect(system).toContain("A friendly greeter macro.");

    // Each bound resource gets its own dedicated layer (distinct from pinned).
    const lbLayer = result.prompt.layers.find((l) => l.id === "bound_lorebooks");
    const scLayer = result.prompt.layers.find((l) => l.id === "bound_scripts");
    expect(lbLayer).toBeTruthy();
    expect(lbLayer!.sourceName).toBe("Bound Lorebooks (2)");
    expect(scLayer).toBeTruthy();
    expect(scLayer!.sourceName).toBe("Bound Scripts (1)");
  });

  test("CE-C2/C3: with no bound resources the awareness sections are omitted", async () => {
    const loaders = makeLoaders({ boundResources: { lorebooks: [], scripts: [] } });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).not.toContain("Bound lorebooks");
    expect(system).not.toContain("Bound scripts");
    expect(result.prompt.layers.find((l) => l.id === "bound_lorebooks" || l.id === "bound_scripts")).toBeUndefined();
  });

  test("CA-13/CE-C1: with nothing pinned the prompt carries no context section (unchanged)", async () => {
    const loaders = makeLoaders({ loreEntries: [] });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).not.toContain("Pinned context");
    expect(result.prompt.activatedLoreEntries).toEqual([]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
  });
  test("CS-0d: honours excludeMessageIds in prompt assembly", async () => {
    const loaders = makeLoaders({
      messages: [
        { id: "msg_1", role: "user", content: "hello" } as never,
        { id: "msg_2", role: "assistant", content: "on it" } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders, { excludeMessageIds: ["msg_2"] }));
    const messages = (result.prompt.finalPayload as { messages: Array<{ role: string; content: string }> }).messages;

    // system + user, msg_2 is excluded
    expect(messages.length).toBe(2);
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
  });

  test("CS-4: includes tool messages and assistant toolCalls in history assembly", async () => {
    const loaders = makeLoaders({
      messages: [
        { id: "msg_1", role: "user", content: "rewrite it" } as never,
        { 
          id: "msg_2", 
          role: "assistant", 
          content: "calling tool",
          toolCalls: [{
            id: "call_1",
            name: "edit_personality",
            args: { content: "Bold." },
            providerOptions: { google: { thoughtSignature: "sig_google_1" } },
          }]
        } as never,
        { id: "msg_3", role: "tool", toolCallId: "call_1", content: "Success" } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const messages = (result.prompt.finalPayload as { messages: Array<Record<string, unknown>> }).messages;

    expect(messages.length).toBe(4); // system + user + assistant + tool

    expect(messages[2].role).toBe("assistant");
    // SDK v6 ToolCallPart uses `input` (not `args`) for the parsed arguments.
    expect(messages[2].toolCalls).toEqual([{
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "edit_personality",
      input: { content: "Bold." },
      providerOptions: { google: { thoughtSignature: "sig_google_1" } },
    }]);

    expect(messages[3].role).toBe("tool");
    // SDK v6 ToolResultPart.output is a discriminated union; a string result is
    // wrapped as `{ type: "text", value }` (not a bare `result` field).
    // The tool NAME is resolved from the owning assistant message's toolCalls
    // (the DB `role:"tool"` row stores only the toolCallId). The Google
    // provider maps toolName → function_response.name, which Gemini requires
    // non-empty — an unresolved name surfaces as a 400
    // `function_response.name: Name cannot be empty` on the next turn.
    expect(messages[3].content).toEqual([{
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "edit_personality",
      output: { type: "text", value: "Success" }
    }]);
  });

  test("CTX-S5: read_skill_file (non-proposal) pair reconstructs in history replay — no orphaning", async () => {
    // The history mapper is tool-name-agnostic, so a read_skill_file pair must
    // rebuild into the same SDK v6 ToolCallPart + tool-result shape CS-4 pins
    // for proposal tools. This guards against a future regression that
    // special-cases proposal tool names in the mapper and silently drops reads
    // (the model would then lose the file content it just asked for).
    const loaders = makeLoaders({
      messages: [
        { id: "msg_1", role: "user", content: "use general-writing" } as never,
        {
          id: "msg_2",
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call_read",
            name: "read_skill_file",
            args: { path: "general-writing/SKILL.md" },
            providerOptions: { google: { thoughtSignature: "sig_read" } },
          }],
        } as never,
        {
          id: "msg_3",
          role: "tool",
          toolCallId: "call_read",
          // Persisted tool-result content is the JSON-stringified read result.
          content: JSON.stringify({ path: "general-writing/SKILL.md", content: "# General Writing" }),
        } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const messages = (result.prompt.finalPayload as { messages: Array<Record<string, unknown>> }).messages;

    // system + user + assistant(carrier) + tool(result).
    expect(messages.length).toBe(4);
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].toolCalls).toEqual([{
      type: "tool-call",
      toolCallId: "call_read",
      toolName: "read_skill_file",
      input: { path: "general-writing/SKILL.md" },
      providerOptions: { google: { thoughtSignature: "sig_read" } },
    }]);
    expect(messages[3].role).toBe("tool");
    expect(messages[3].content).toEqual([{
      type: "tool-result",
      toolCallId: "call_read",
      toolName: "read_skill_file",
      output: { type: "text", value: JSON.stringify({ path: "general-writing/SKILL.md", content: "# General Writing" }) },
    }]);
  });

  test("compacts when response reserve makes an otherwise fitting prompt exceed context", async () => {
    const { setTokenCountFn } = await import("@vibe-tavern/prompt-pipeline");
    setTokenCountFn((text: string) => text.length);
    const loaders = makeLoaders({
      messages: [
        { id: "msg_1", role: "user", content: "Old user message." } as never,
        { id: "msg_2", role: "assistant", content: "Old assistant message." } as never,
        { id: "msg_3", role: "user", content: "Recent user message." } as never,
        { id: "msg_4", role: "assistant", content: "Recent assistant message." } as never,
      ],
    });
    const unbounded = await assembleCoauthorPrompt(makeInput(loaders));
    const result = await assembleCoauthorPrompt(makeInput(loaders, {
      contextBudget: unbounded.prompt.tokenAccounting.total + 5,
      responseReserve: 10,
    }));

    expect(result.promptTraceDraft.compactionSummary).toBeDefined();
    expect(result.prompt.tokenAccounting.recentHistory).toBeLessThan(4);
  });

  describe("CED-3: edit/write tool routing per module", () => {
    test("default module exposes all edit_*/write_* section tools + write_profile + greetings; no generic write_section", async () => {
      const loaders = makeLoaders();
      const result = await assembleCoauthorPrompt(makeInput(loaders));
      const names = new Set(Object.keys(result.tools));
      for (const n of [
        "edit_personality", "edit_scenario", "edit_examples",
        "write_personality", "write_scenario", "write_examples",
        "write_profile", "edit_greeting", "edit_alt_greeting", "add_alt_greeting",
      ]) {
        expect(names.has(n)).toBe(true);
      }
      // No generic/unrestricted section tool, no legacy search_replace naming.
      expect(names.has("write_section")).toBe(false);
      expect(names.has("edit_section")).toBe(false);
      expect([...names].some((n) => /search_replace/i.test(n))).toBe(false);
    });

    test("profile-editor module exposes only PERSONALITY/SCENARIO edit+write (no EXAMPLES, no greetings)", async () => {
      const loaders = makeLoaders({ chat: { id: "chat_test", coauthorModuleId: "profile-editor" } as never });
      const result = await assembleCoauthorPrompt(makeInput(loaders));
      const names = new Set(Object.keys(result.tools));
      expect(names.has("edit_personality")).toBe(true);
      expect(names.has("write_personality")).toBe(true);
      expect(names.has("edit_scenario")).toBe(true);
      expect(names.has("write_scenario")).toBe(true);
      expect(names.has("edit_examples")).toBe(false);
      expect(names.has("write_examples")).toBe(false);
      expect(names.has("edit_greeting")).toBe(false);
    });

    test("dialogue-writer module exposes only EXAMPLES edit+write + greetings (no PERSONALITY/SCENARIO)", async () => {
      const loaders = makeLoaders({ chat: { id: "chat_test", coauthorModuleId: "dialogue-writer" } as never });
      const result = await assembleCoauthorPrompt(makeInput(loaders));
      const names = new Set(Object.keys(result.tools));
      expect(names.has("edit_examples")).toBe(true);
      expect(names.has("write_examples")).toBe(true);
      expect(names.has("edit_greeting")).toBe(true);
      expect(names.has("edit_personality")).toBe(false);
      expect(names.has("write_personality")).toBe(false);
      expect(names.has("write_scenario")).toBe(false);
    });

    test("base prompt teaches edit vs write vs write_profile routing", async () => {
      const loaders = makeLoaders();
      const result = await assembleCoauthorPrompt(makeInput(loaders));
      const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
      expect(system).toContain("edit_personality");
      expect(system).toContain("write_personality");
      expect(system).toContain("write_profile");
      // write_profile is taught as first-profile-change-only.
      expect(system).toMatch(/first profile change/);
      // edit_* takes exact search/replace pairs, not a full section content.
      expect(system).toContain("search");
      expect(system).toContain("replace");
    });
  });

  test("CS-5: applies token compaction and preserves tool-call pairs", async () => {
    // Inject a fake token counter for this test so estimateTokens doesn't return 0
    const { setTokenCountFn } = await import("@vibe-tavern/prompt-pipeline");
    setTokenCountFn((text: string) => text.length);

    const loaders = makeLoaders({
      messages: [
        { id: "msg_0", role: "user", content: "very old message ".repeat(2000) } as never,
        { id: "msg_1", role: "user", content: "rewrite it" } as never,
        { 
          id: "msg_2", 
          role: "assistant", 
          content: "calling tool",
          toolCalls: [{ id: "call_1", name: "edit_personality", args: { content: "Bold." } }]
        } as never,
        { id: "msg_3", role: "tool", toolCallId: "call_1", content: "Success" } as never,
      ],
    });
    // System prompt size + recent messages ~ some characters. 
    // Budget 15000 allows system + msg_1,2,3 but drops msg_0 (which is ~34000 chars)
    const result = await assembleCoauthorPrompt(makeInput(loaders, { contextBudget: 15000 }));
    const messages = (result.prompt.finalPayload as { messages: Array<{ role: string; content: unknown }> }).messages;
    
    // We expect system + msg_1 + msg_2 + msg_3
    expect(messages.length).toBe(4);
    expect(messages[1].content).toBe("rewrite it");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("tool");

    expect(result.prompt.tokenAccounting?.recentHistory).toBe(3);
    expect(result.promptTraceDraft.compactionSummary).toBeDefined();
    expect(result.promptTraceDraft.compactionSummary).toContain("Kept 3 of 4 recent messages");
  });
});

/**
 * CTX-M2 — Wave-3 module prompt contracts. Pin the collaborative-workflow policy
 * of each rebuilt seed (discussion-first vs direct-draft vs revision vs ideation)
 * and prove no seed carries the former minimize-chat or blanket-routing policy.
 * These read the REAL module prompt assets (loaders only mock the catalog), so a
 * regression in any .md is caught here.
 */
async function assembleForModule(moduleId: string): Promise<string> {
  const loaders = makeLoaders({ chat: { id: "chat_test", coauthorModuleId: moduleId } as never });
  const result = await assembleCoauthorPrompt(makeInput(loaders));
  return (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
}

describe("assembleCoauthorPrompt — Wave-3 module prompt contracts (CTX-M2)", () => {
  test("Character Workshop (default) is discussion-first: develops the premise before mutating", async () => {
    const system = await assembleForModule("default");
    // The discussion-before-mutation policy is present.
    expect(system).toContain("Discuss before you mutate");
    // And it frames itself as collaborative development, not immediate tool use.
    expect(system.toLowerCase()).toContain("develop");
  });

  test("Quick Draft is tool-forward: reads its card skill + template and drafts directly", async () => {
    const system = await assembleForModule("quick-draft");
    // The workflow tells the model to read_skill_file its SKILL + template first.
    expect(system).toContain("read_skill_file");
    expect(system).toContain("card-template");
    // And to produce a complete draft (speed mode), while flagging it as a draft.
    expect(system.toLowerCase()).toContain("draft");
  });

  test("Revision Workshop (profile-editor) audits first and preserves unselected content", async () => {
    const system = await assembleForModule("profile-editor");
    expect(system.toLowerCase()).toContain("audit");
    // Preservation discipline: retain unchanged prose / off-limits respect.
    expect(system).toMatch(/preserv|off-limits|retain unchanged/i);
  });

  test("Dialogue Studio (dialogue-writer) permits ideation before greeting/example proposals", async () => {
    const system = await assembleForModule("dialogue-writer");
    expect(system.toLowerCase()).toContain("ideate");
  });

  test("no seed prompt minimizes chat or blanket-routes adjacent requests away", async () => {
    // The former anti-patterns — removed from every seed in Wave 3.
    for (const id of ["default", "quick-draft", "profile-editor", "dialogue-writer"]) {
      const system = await assembleForModule(id);
      expect(system).not.toContain("Minimize conversational chatter");
      expect(system).not.toMatch(/decline and tell the user to switch/i);
    }
  });

  test("CE-E2: lore-bearing modules point at the lorebook-authoring skill and drop inline lore mechanics", async () => {
    // The verbose lore tool-mechanics (delegate-tool names, keyTarget/appendMode
    // controls) moved to the lorebook-authoring skill (CE-E0); the module prompt
    // now carries only a one-line pointer. Pinned so a regression that re-expands
    // the module lore section is caught.
    for (const id of ["default", "quick-draft"]) {
      const system = await assembleForModule(id);
      expect(system).toContain("read_skill_file('lorebook-authoring')");
      // Inline lore mechanics no longer live in the module prompt.
      expect(system).not.toContain("appendMode");
      expect(system).not.toContain("keyTarget");
      expect(system).not.toContain("ai_write_lore_entry");
    }
  });

  test("CE-E1: every module carries an in-voice Opening message section", async () => {
    // CE-E1: each module's first user-facing message tells the author what the
    // mode can do, in that module's voice, without a generic preamble. The
    // section's presence is pinned structurally; the voice quality is for the
    // user to judge. Conditional on "opened without a request" so a model
    // given a directive answers it instead of introducing itself.
    for (const id of ["default", "quick-draft", "profile-editor", "dialogue-writer"]) {
      const system = await assembleForModule(id);
      expect(system).toContain("Opening message");
      // The opening is conditional — if the author opened with a directive, the
      // model answers it instead of introducing itself ("skip the intro").
      expect(system).toMatch(/skip the intro/i);
    }
  });

  test("CE-E2: base prompt teaches the 3-level context model and the binding boundary", async () => {
    // Every module inherits base, so the shared context model lives there once.
    const system = await assembleForModule("default");
    expect(system).toContain("Context you can reach");
    expect(system).toContain("search_context");
    expect(system).toContain("read_context_item");
    // Binding is the author's action, not the model's.
    expect(system).toMatch(/Binding is the author's action/);
  });
});
