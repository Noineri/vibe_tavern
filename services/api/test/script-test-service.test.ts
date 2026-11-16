import { describe, expect, it } from "bun:test";
import type { StoreContainer, ScriptStore } from "@vibe-tavern/db";
import { testScript } from "../src/domain/scripts-engine/script-test-service.js";
import { makeScriptRow } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

/**
 * Script test service — authoring-buffer boundary.
 *
 * The test panel must be able to execute unsaved editor code without first
 * mutating persistence. The stored record still supplies stable metadata
 * (id/name/sortOrder); `input.code`, when present (including an empty string),
 * is the executable source for this one test run only.
 */

function storesWithStoredCode(code: string): StoreContainer {
  return strictTestDouble<StoreContainer>(
    {
      scripts: strictTestDouble<ScriptStore>(
        {
          // Complete stored row via the standing builder; the erased literal
          // omitted scriptKind (undefined — testScript treats a missing kind
          // as "prompt", script-test-service.ts:104, so "prompt" is the same
          // dispatch) and the row's other required columns.
          getById: async () => makeScriptRow("prompt", "script_1", { name: "Test script", code, scopeType: "entity", characterId: "character_1" }),
        },
        "storesWithStoredCode: scripts (script-test-service)",
      ),
    },
    "StoreContainer (script-test-service)",
  );
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
