import { describe, expect, it } from "bun:test";
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import {
  ChatLifecycleRuntime,
  type ChatLifecycleRuntimeDeps,
} from "../src/runtime/session/session-runtime-chat-lifecycle.js";

describe("ChatLifecycleRuntime insight context branch targeting (OFA-4)", () => {
  it("passes an explicit committed branch instead of the chat's mutable active branch", async () => {
    const seenBranches: ChatBranchId[] = [];
    const deps = {
      stores: {
        chats: {
          getById: async () => ({ activeBranchId: "branch_current" }),
        },
      } as unknown as StoreContainer,
      buildPipelineContext: async (_chatId: ChatId, branchId?: ChatBranchId) => {
        if (branchId) seenBranches.push(branchId);
        return { context: {} } as never;
      },
    } as ChatLifecycleRuntimeDeps;
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
