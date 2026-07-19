import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import { testScript } from "../src/domain/scripts-engine/script-test-service.js";

/**
 * Script test service — authoring-buffer boundary.
 *
 * The test panel must be able to execute unsaved editor code without first
 * mutating persistence. The stored record still supplies stable metadata
 * (id/name/sortOrder); `input.code`, when present (including an empty string),
 * is the executable source for this one test run only.
 */

function storesWithStoredCode(code: string): StoreContainer {
  return {
    scripts: {
      getById: async () => ({
        id: "script_1",
        name: "Test script",
        description: "",
        code,
        enabled: true,
        scopeType: "character",
        sortOrder: 0,
        characterId: "character_1",
        personaId: null,
        chatId: null,
        extensions: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    },
  } as unknown as StoreContainer;
}

describe("testScript code override", () => {
  it("executes the unsaved code override instead of the stored code", async () => {
    const result = await testScript(
      storesWithStoredCode("context.character.personality = 'STORED';"),
      {
        scriptId: "script_1",
        code: "context.character.personality = 'DRAFT';",
      },
    );

    expect(result.personality).toBe("DRAFT");
  });

  it("treats an empty-string override as intentional empty code", async () => {
    const result = await testScript(
      storesWithStoredCode("context.character.personality = 'STORED';"),
      { scriptId: "script_1", code: "" },
    );

    expect(result.personality).toBe("");
  });

  it("falls back to stored code when no override is provided", async () => {
    const result = await testScript(
      storesWithStoredCode("context.character.personality = 'STORED';"),
      { scriptId: "script_1" },
    );

    expect(result.personality).toBe("STORED");
  });
});
