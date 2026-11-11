import { describe, expect, it } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { ProviderOrchestrator } from "../src/domain/providers/provider-orchestrator.js";
import type { ChatRuntime } from "../src/runtime/session/session-runtime-chat.js";
import { makeProviderProfileRow } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

/** Required-but-unused orchestrator ctor deps (chatRuntime / chatApp /
 *  providers — the forward-state join fires before any of them is touched:
 *  the strategy throws before provider resolution and no prompt is built).
 *  One strict double: every member access throws labeled
 *  (objective-service-fixture.ts's unusedObjectiveDeps semantics through the
 *  strictTestDouble seam) — the same loud failure class the old erasure
 *  produced, with the real dep types and no cast. */
const UNSET: ChatRuntime & ChatApplicationService & ProviderOrchestrator = strictTestDouble<
  ChatRuntime & ChatApplicationService & ProviderOrchestrator
>({}, "LiveChatOrchestrator unset deps (live-chat-forward-state)");

describe("LiveChatOrchestrator forward-state prompt boundary", () => {
  it("joins the preceding forward-state job before resolving the provider or preparing a send", async () => {
    const gate = deferred();
    const afterJoin = new Error("provider resolution reached after join");
    let waitCalls = 0;
    let strategyCalls = 0;

    const orchestrator = new LiveChatOrchestrator(
      UNSET,
      UNSET,
      UNSET,
      new EventBus(),
      async () => {
        strategyCalls += 1;
        throw afterJoin;
      },
      async (chatId, signal) => {
        waitCalls += 1;
        expect(chatId).toBe("chat_1");
        expect(signal).toBeUndefined();
        await gate.promise;
      },
    );

    const sending = orchestrator.sendMessage({
      chatId: "chat_1",
      content: "Next turn",
      profile: makeProviderProfileRow(),
      model: "model_1",
    });
    await Promise.resolve();

    expect(waitCalls).toBe(1);
    expect(strategyCalls).toBe(0);

    gate.resolve();
    await expect(sending).rejects.toBe(afterJoin);
    expect(strategyCalls).toBe(1);
  });

  it("forwards request cancellation to the join and never starts provider resolution", async () => {
    const cancellation = new Error("cancel next prompt");
    const controller = new AbortController();
    controller.abort(cancellation);
    let strategyCalls = 0;

    const orchestrator = new LiveChatOrchestrator(
      UNSET,
      UNSET,
      UNSET,
      new EventBus(),
      async () => {
        strategyCalls += 1;
        throw new Error("strategy must not run");
      },
      async (_chatId, signal) => signal?.throwIfAborted(),
    );

    const sending = orchestrator.sendMessage({
      chatId: "chat_1",
      content: "Cancelled turn",
      profile: makeProviderProfileRow(),
      model: "model_1",
      signal: controller.signal,
    });

    await expect(sending).rejects.toBe(cancellation);
    expect(strategyCalls).toBe(0);
  });
});
