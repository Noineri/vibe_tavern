import { describe, expect, it } from "bun:test";
import type { PromptAssemblyContext } from "../src/types.ts";
import { AI_ASSISTANT_ASSEMBLERS } from "../src/ai-assistant/ai-assistant-assemblers.ts";
import { SUMMARY_STRATEGIES, getSummaryStrategy } from "../src/summary/summary-strategies.ts";
import { RESOLVER_ID, RESOLVERS, getResolverId } from "../src/resolvers/resolver-registry.ts";

describe("prompt assembly registries", () => {
  it("registers an assembler for every AI assistant mode", () => {
    expect(Object.keys(AI_ASSISTANT_ASSEMBLERS).sort()).toEqual([
      "chat_impersonate",
      "dice_script",
      "interactive_rules",
      "lore_entry",
      "lore_keys",
      "md_import",
      "message_edit",
      "message_merge",
      "scene_rules",
      "scene_schema",
      "script",
      "vision_describe",
    ]);
    expect(Object.values(AI_ASSISTANT_ASSEMBLERS).every((assembler) => typeof assembler.assemble === "function")).toBeTrue();
  });

  it("resolves the default pure summary strategy", () => {
    expect(SUMMARY_STRATEGIES.default).toBe(getSummaryStrategy());
    expect(typeof getSummaryStrategy().assemble).toBe("function");
  });

  it("selects the RP resolver registry from the preset's canvas state", () => {
    expect(Object.keys(RESOLVERS).sort()).toEqual([RESOLVER_ID.advanced, RESOLVER_ID.simple]);
    expect(getResolverId(null)).toBe(RESOLVER_ID.simple);
    expect(getResolverId({ advancedMode: false } as NonNullable<PromptAssemblyContext["preset"]>)).toBe(RESOLVER_ID.simple);
    expect(getResolverId({ advancedMode: true } as NonNullable<PromptAssemblyContext["preset"]>)).toBe(RESOLVER_ID.advanced);
  });
});
