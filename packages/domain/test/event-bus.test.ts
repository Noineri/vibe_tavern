import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/event-bus.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("EventBus", () => {
  test("emits typed payloads to subscribers", async () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.on("message.appended", (payload) => {
      seen.push(`${payload.role}:${payload.messageId}`);
    });

    bus.emit("message.appended", { chatId: "chat-1", messageId: "msg-1", role: "assistant" });
    await flush();

    expect(seen).toEqual(["assistant:msg-1"]);
  });

  test("unsubscribes explicit handlers", async () => {
    const bus = new EventBus();
    let count = 0;
    const unsubscribe = bus.on("message.created", () => {
      count += 1;
    });

    unsubscribe();
    bus.emit("message.created", { chatId: "chat-1", messageId: "msg-1", role: "user", content: "hello" });
    await flush();

    expect(count).toBe(0);
    expect(bus.listenerCount("message.created")).toBe(0);
  });

  test("auto-unsubscribes via AbortSignal", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    let count = 0;

    bus.on("message.created", () => {
      count += 1;
    }, { signal: controller.signal });

    expect(bus.listenerCount("message.created")).toBe(1);
    controller.abort();
    expect(bus.listenerCount("message.created")).toBe(0);

    bus.emit("message.created", { chatId: "chat-1", messageId: "msg-1", role: "user", content: "hello" });
    await flush();

    expect(count).toBe(0);
  });
});
