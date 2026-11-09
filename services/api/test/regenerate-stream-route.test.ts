import { describe, expect, test } from "bun:test";
import type { RegenerateOverride } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import { createApp } from "../src/server/app-factory.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { makeRuntimeApi } from "./routes-test-builders.js";
import { makeCharacterRow } from "./copilot-test-builders.js";
import { makeChatRow } from "./insights-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";
import { ChatGenerationRunAdapter } from "../src/api/adapters/chat-generation-run-adapter.js";

/**
 * HTTP contract of POST /api/chats/:chatId/messages/:messageId/regenerate/stream.
 * The body is an optional `regenerateOverrideSchema` override: a request without
 * a JSON content type regenerates with no override, a valid override reaches the
 * runtime verbatim, and an invalid or malformed body is a 400 that never starts
 * a generation.
 */

const URL = "/api/chats/chat_1/messages/msg_1/regenerate/stream";

async function appRecordingOverrides(): Promise<{
  app: Awaited<ReturnType<typeof createApp>>;
  overrides: RegenerateOverride[];
}> {
  const overrides: RegenerateOverride[] = [];
  const regenerateMessageStream: RuntimeApi["chat"]["regenerateMessageStream"] = async function* (
    _chatId,
    _messageId,
    override,
  ) {
    overrides.push(override);
  };
  // createApiRouter hands createChatRoutes `runtime.chat`; only the method
  // under test is stubbed.
  const runs = new ChatGenerationRunAdapter(strictTestDouble<StoreContainer>(
    {
      chats: { getById: async () => makeChatRow({ id: "chat_1", characterId: "char_1", activeBranchId: "branch_1", mode: "rp", title: "Regenerate" }) },
      characters: { getById: async () => makeCharacterRow("char_1", { name: "Regenerate" }) },
    },
    "ChatGenerationRunAdapter stores (regenerate-stream)",
  ));
  const runtime = makeRuntimeApi(
    { chat: { regenerateMessageStream, startChatGeneration: runs.startChatGeneration } },
    "RuntimeApi (regenerate-stream)",
  );
  return { app: await createApp({ runtime }), overrides };
}

describe("regenerate stream route body", () => {
  test("a request without a JSON body regenerates with an empty override", async () => {
    const { app, overrides } = await appRecordingOverrides();
    const res = await app.request(URL, { method: "POST" });
    expect(res.status).toBe(200);
    await res.text();
    expect(overrides).toEqual([{}]);
  });

  test("a valid override reaches the runtime", async () => {
    const { app, overrides } = await appRecordingOverrides();
    const res = await app.request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-x", promptPresetId: "preset_1" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(overrides).toEqual([{ model: "gpt-x", promptPresetId: "preset_1" }]);
  });

  test("an override failing the schema is a 400 and never starts a generation", async () => {
    const { app, overrides } = await appRecordingOverrides();
    const res = await app.request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    expect(res.status).toBe(400);
    expect(overrides).toEqual([]);
  });

  test("malformed JSON is a 400 and never starts a generation", async () => {
    const { app, overrides } = await appRecordingOverrides();
    const res = await app.request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(overrides).toEqual([]);
  });
});
