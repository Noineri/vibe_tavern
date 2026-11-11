import { describe, expect, it } from "bun:test";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import {
  ChatLifecycleRuntime,
  type ChatLifecycleRuntimeDeps,
} from "../src/runtime/session/session-runtime-chat-lifecycle.js";
import { makeBuiltPipelineContext, makeChatRow, makePromptContext } from "./insights-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

describe("ChatLifecycleRuntime insight context branch targeting (OFA-4)", () => {
  it("passes an explicit committed branch instead of the chat's mutable active branch", async () => {
    const seenBranches: ChatBranchId[] = [];
    // The strict double keeps the provided members compiler-checked against
    // the real deps contract (the store member is completed through the
    // standing row builder — the erased fragment was missing every required
    // Chat column); every unprovided dep throws a labeled miss instead of
    // riding the old trailing cast.
    const deps = strictTestDouble<ChatLifecycleRuntimeDeps>(
      {
        stores: strictTestDouble<StoreContainer>(
          {
            chats: {
              getById: async () => makeChatRow({ activeBranchId: "branch_current" }),
            },
          },
          "ChatLifecycleRuntime stores (insights context)",
        ),
        // The real BuiltPipelineContext contract via the shared completion
        // (the test pins branch targeting only — the context is inert).
        buildPipelineContext: async (chatId: ChatId, branchId?: ChatBranchId) => {
          if (branchId) seenBranches.push(branchId);
          return makeBuiltPipelineContext(makePromptContext({ identity: { chatId } }));
        },
      },
      "ChatLifecycleRuntime deps (insights context)",
    );
    const runtime = new ChatLifecycleRuntime(deps);

    await runtime.buildPipelineContext({
      chatId: "chat_1" as ChatId,
      branchId: "branch_committed" as ChatBranchId,
      model: "model_1",
      recentMessageLimit: 10,
    });

    expect(seenBranches).toEqual(["branch_committed"]);
  });
});
