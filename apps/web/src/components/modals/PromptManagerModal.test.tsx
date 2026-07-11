/**
 * buildDuplicatePayload — deep-copy characterization.
 *
 * Pins the fix for PRESET_COPY_DELETE_CORRUPTION bug 1: the "Duplicate" create
 * payload must NOT share mutable array/object references (`promptOrder`,
 * `customInjections`, `aiAssistantPrompts`) with the live source draft. The
 * former shallow `{...draft}` spread aliased those nested values, letting edits
 * to the copy leak back into the source's in-memory state. The pure helper is
 * exported precisely so this invariant has a direct unit test (no RTL render).
 */
import { describe, expect, test } from "vitest";
import type { CustomInjection, PromptOrderEntry } from "@vibe-tavern/domain";
import { buildDuplicatePayload, type DraftData } from "./PromptManagerModal.js";

function baseDraft(): DraftData {
  return {
    name: "Source",
    system: "sys",
    jailbreak: "jb",
    prefill: "pf",
    authorsNote: "an",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
    summary: "",
    tools: "",
    nsfw: "",
    enhanceDefinitions: "",
    scriptAiSystemPrompt: "",
    aiAssistantPrompts: { vision: "describe", lore: "expand" },
    customInjections: [{ identifier: "inj_1", name: "Inj", content: "c", role: "system" }],
    promptOrder: [{ identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" }],
    advancedMode: false,
  };
}

describe("buildDuplicatePayload — deep-copy (PRESET_COPY_DELETE_CORRUPTION bug 1)", () => {
  test("payload does not share mutable array/object refs with the source draft", () => {
    const source = baseDraft();
    const payload = buildDuplicatePayload(source, "Presets");

    // The clone produced fresh containers (different identity, not the source refs).
    expect(payload.promptOrder).not.toBe(source.promptOrder);
    expect(payload.customInjections).not.toBe(source.customInjections);

    // Mutating the payload's nested arrays must NOT touch the source — the
    // aliasing that caused copy-edits to leak into the original is gone.
    payload.promptOrder.push({ identifier: "jailbreak", enabled: false, order: 1, zone: "after_chat", depth: null, kind: "built_in" });
    payload.customInjections.push({ identifier: "inj_2", name: "X", content: "y", role: "user" });
    expect(source.promptOrder).toHaveLength(1);
    expect(source.customInjections).toHaveLength(1);

    // aiAssistantPrompts is stringified to JSON (DTO contract) — a string, not the source record ref.
    expect(typeof payload.aiAssistantPrompts).toBe("string");
    expect(payload.aiAssistantPrompts).toBe(JSON.stringify({ vision: "describe", lore: "expand" }));
  });

  test("name carries the source name + (copy) suffix, falling back to the supplied label when empty", () => {
    expect(buildDuplicatePayload(baseDraft(), "Presets").name).toBe("Source (copy)");
    const blank = baseDraft();
    blank.name = "";
    expect(buildDuplicatePayload(blank, "Presets").name).toBe("Presets (copy)");
  });

  test("field content is preserved through the deep copy", () => {
    const source = baseDraft();
    const payload = buildDuplicatePayload(source, "Presets");
    expect(payload.system).toBe("sys");
    expect(payload.promptOrder[0]).toEqual(source.promptOrder[0]);
    expect(payload.customInjections[0]).toEqual(source.customInjections[0]);
  });

  test("CustomInjection/PromptOrderEntry typings used above are the domain shapes (compile-time guard)", () => {
    const _inj: CustomInjection = { identifier: "x", name: "y", content: "z", role: "assistant" };
    const _po: PromptOrderEntry = { identifier: "x", enabled: true, order: 0, zone: "in_chat", depth: 1, kind: "custom" };
    expect([_inj.identifier, _po.identifier]).toEqual(["x", "x"]);
  });
});
