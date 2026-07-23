import { describe, expect, test } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { createApp } from "../src/server/app-factory.js";
import { FeatureRegistry } from "../src/shared/feature-registry.js";
import { createChatEventsFeature } from "../src/domain/chat/chat-events-feature.js";
import type { RuntimeApi } from "../src/api/routes/index.js";

// W7 / SPC-7a — the reusable per-chat SSE channel. The route is mounted by the
// chat-events FeatureModule and forwards typed `chat.notification` EventBus
// events filtered by chatId. Auto-summary is the first producer, but the
// transport is generic, so these tests pin the transport contract directly
// (emit → SSE) rather than coupling to the summary service.

describe("chat-events feature (SSE) — SPC-7a", () => {
  async function mountChannel(chatId: string) {
    const events = new EventBus();
    const features = new FeatureRegistry();
    features.register(createChatEventsFeature());
    const app = await createApp({
      runtime: {} as RuntimeApi,
      configureFeatures: (router) => features.activateAll({ events, router }),
    });
    const response = await app.request(`/api/chats/${chatId}/events`);
    const reader = response.body!.getReader();
    const decode = () => reader.read().then(({ value }) => new TextDecoder().decode(value));
    const cleanup = async () => {
      reader.cancel().catch(() => {});
      features.deactivateAll();
    };
    return { events, reader, decode, cleanup };
  }

  test("sends a ready handshake, then forwards a matching summary.generated", async () => {
    const { events, decode, cleanup } = await mountChannel("chat-1");

    const ready = await decode();
    expect(ready).toContain("ready");

    events.emit("chat.notification", {
      chatId: "chat-1",
      kind: "summary.generated",
      summaryId: "s-100",
      label: "T1–T10",
    });
    const chunk = await decode();
    // event type line + payload; chatId is intentionally omitted from `data`
    // (the subscriber already knows its own chat).
    expect(chunk).toContain("summary.generated");
    expect(chunk).toContain("s-100");
    expect(chunk).toContain("T1–T10");
    expect(chunk).not.toContain("chatId");

    await cleanup();
  });

  test("does not forward notifications targeted at a different chat", async () => {
    const { events, decode, cleanup } = await mountChannel("chat-1");

    // consume the initial ready so the next read reflects only what follows
    await decode();

    events.emit("chat.notification", {
      chatId: "chat-OTHER",
      kind: "summary.generated",
      summaryId: "s-200",
      label: "T1–T5",
    });

    // If the filter leaked, a chunk arrives; if it holds, the read stays pending.
    // Race it against a short timeout to assert nothing was forwarded.
    const outcome = await Promise.race([
      decode().then(() => "leaked"),
      new Promise<"filtered">((resolve) => setTimeout(() => resolve("filtered"), 80)),
    ]);
    expect(outcome).toBe("filtered");

    await cleanup();
  });
});
