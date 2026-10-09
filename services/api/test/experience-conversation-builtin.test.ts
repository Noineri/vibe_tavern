/** Public-kernel coverage for the owner-approved Messenger rules export. */
import { describe, expect, test } from "bun:test";
import { CONVERSATION_RULES_SOURCE } from "@vibe-tavern/domain/builtins";
import { discoverExperienceDefinition, runCreate, type ExperienceCapabilityContext } from "../src/domain/interactive/experience-kernel.js";

const NO_CAPS: ExperienceCapabilityContext = {};

describe("Messenger builtin", () => {
  test("discovers the owner-approved manifest and declared capabilities", () => {
    const result = discoverExperienceDefinition(CONVERSATION_RULES_SOURCE, "messenger.js");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.manifest).toMatchObject({ id: "model_conversation", name: "Messenger" });
    expect(result.definition.declaredCapabilities.map((item) => item.capability)).toEqual(["participants", "model"]);
  });

  test("creates the bounded Messenger state shape", () => {
    const result = runCreate(CONVERSATION_RULES_SOURCE, "messenger.js", {}, NO_CAPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ phase: "setup", characters: [], chats: [], pending: [], maxCharacters: 24, maxChats: 12, maxMessages: 240 });
  });
});