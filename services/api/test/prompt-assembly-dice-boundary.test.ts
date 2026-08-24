/**
 * Prompt-assembly Dice-boundary test (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B4).
 *
 * Defense-in-depth: verifies that a Dice-kind script can NEVER execute inside
 * the prompt-script VM, even if one somehow crossed the store boundary. The
 * prompt-resolver's `executeScripts` method filters out `scriptKind === "dice"`
 * records before passing them to the prompt sandbox. Combined with the B1
 * store-level split (`listAllEnabledForChat` is prompt-only), this is a
 * two-layer guarantee: Dice scripts have their own isolated runtime and never
 * mutate prompt fields, inject messages, or run during assembly.
 */
import { describe, expect, test } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { Script, Chat } from "@vibe-tavern/domain";
import { StaticPromptResolver } from "../src/domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../src/domain/regex/regex-hook-service.js";

function makeScript(overrides: Partial<Script> & { id: string }): Script {
  return {
    id: overrides.id,
    name: overrides.name ?? "Script",
    description: "",
    code: overrides.code ?? "",
    scriptKind: overrides.scriptKind ?? "prompt",
    enabled: overrides.enabled ?? true,
    scopeType: overrides.scopeType ?? "chat",
    sortOrder: overrides.sortOrder ?? 0,
    characterId: overrides.characterId ?? null,
    personaId: overrides.personaId ?? null,
    chatId: overrides.chatId ?? "chat_1",
    extensions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChat(): Chat {
  return {
    id: "chat_1",
    characterId: "char_1" as Chat["characterId"],
    personaId: null,
    title: "Test",
    status: "active",
    mode: "rp",
    activeBranchId: "branch_1" as Chat["activeBranchId"],
    promptPresetId: "preset_1" as Chat["promptPresetId"],
    toolProfileId: "tools_1" as Chat["toolProfileId"],
    selectedGreetingIndex: 0,
    coauthorContextLinks: [],
    coauthorModuleId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A store mock that returns Dice-kind scripts from `listAllEnabledForChat` —
 * simulating a hypothetical store-boundary leak. The resolver's defense-in-depth
 * filter must still prevent them from reaching the prompt sandbox.
 */
function makeStoresWithDiceLeak(scripts: Script[]): StoreContainer {
  const chat = makeChat();
  return {
    chats: {
      getById: async () => ({ ...chat, scriptState: {}, loreActivationState: {} }),
      updateScriptState: async () => {},
    },
    scripts: {
      listAllEnabledForChat: async () => [...scripts],
    },
  } as unknown as StoreContainer;
}

describe("prompt-assembly Dice boundary", () => {
  test("a Dice-kind script is NOT executed during prompt assembly", async () => {
    // This Dice script body tries to mutate prompt fields — if it ran inside
    // the prompt VM, personality would change. The resolver must filter it out.
    const diceScript = makeScript({
      id: "dice_1",
      name: "Rogue Dice Script",
      scriptKind: "dice",
      code: `context.character.personality = "PWNED BY DICE";`,
    });

    const stores = makeStoresWithDiceLeak([diceScript]);
    // RegexHookService over the fake container is side-effect-free here: it
    // only stores the reference — its stores are touched when a hook fires,
    // and executeScripts never fires one (RX-9 wiring).
    const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));

    const result = await resolver.executeScripts({
      chatId: "chat_1" as never,
      characterRecord: {
        name: "TestChar",
        personality: "original personality",
        scenario: "original scenario",
      },
      messages: [{ role: "user", content: "hello" }],
      activeLoreEntries: [],
    });

    // The dice script did not run — personality is unchanged, no scriptRuns.
    expect(result.personality).toBe("original personality");
    expect(result.scriptRuns).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("a prompt-kind script in the same batch still runs normally", async () => {
    const promptScript = makeScript({
      id: "prompt_1",
      name: "Legit Prompt Script",
      scriptKind: "prompt",
      code: `context.character.personality += ", enhanced";`,
    });
    const diceScript = makeScript({
      id: "dice_1",
      name: "Rogue Dice Script",
      scriptKind: "dice",
      code: `context.character.personality = "PWNED";`,
    });

    const stores = makeStoresWithDiceLeak([promptScript, diceScript]);
    const resolver = new StaticPromptResolver(stores, new RegexHookService(stores));

    const result = await resolver.executeScripts({
      chatId: "chat_1" as never,
      characterRecord: {
        name: "TestChar",
        personality: "base",
        scenario: "scene",
      },
      messages: [{ role: "user", content: "hello" }],
      activeLoreEntries: [],
    });

    // The prompt script ran; the dice script was filtered out.
    expect(result.personality).toBe("base, enhanced");
    expect(result.scriptRuns).toHaveLength(1);
    expect(result.scriptRuns[0].scriptId).toBe("prompt_1");
  });
});
