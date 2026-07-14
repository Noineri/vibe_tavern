import { describe, expect, it } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

describe("LiveChatOrchestrator forward-state prompt boundary", () => {
  it("joins the preceding forward-state job before resolving the provider or preparing a send", async () => {
    const gate = deferred();
    const afterJoin = new Error("provider resolution reached after join");
    let waitCalls = 0;
    let strategyCalls = 0;

    const orchestrator = new LiveChatOrchestrator(
      null as never,
      null as never,
      null as never,
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
      profile: {} as never,
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
      null as never,
      null as never,
      null as never,
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
      profile: {} as never,
      model: "model_1",
      signal: controller.signal,
    });

    await expect(sending).rejects.toBe(cancellation);
    expect(strategyCalls).toBe(0);
  });
});
