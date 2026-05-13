/**
 * Test 3 — Chat E2E scenarios
 *
 * Covers the full user flow from provider setup to chat interaction:
 *   1. Create + activate NanoGPT provider profile
 *   2. Create character (auto-creates chat)
 *   3. Send "Hi" non-streaming → get AI response
 *   4. Send another message streaming → verify SSE events
 *   5. Delete a message → verify removal
 *   6. Regenerate response → verify new response
 *   7. Create/edit persona → assign to chat
 *   8. Edit system prompt via prompt preset
 *   9. Abort streaming via AbortSignal
 *
 * Uses real NanoGPT API — network-dependent, ~30s total.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { createTestServer, json } from "./helpers/e2e-server.js";
import type { TestServer } from "./helpers/e2e-server.js";

let server: TestServer;

const NANOGPT_API_KEY = "sk-nano-c762b8b9-9d14-411e-8151-bf6ef9074bdd";
const NANOGPT_BASE_URL = "https://nano-gpt.com/api/v1";
const NANOGPT_MODEL = "moonshotai/kimi-k2.5";

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  if (server) await server.cleanup();
});

// ─── Types ─────────────────────────────────────────────────────────────────

/** createFromScratch returns this */
interface ImportResult {
  activeChatId: string;
  snapshot: Snapshot;
  imported: { kind: string; name: string };
}

/** Most API routes return a full SessionSnapshot */
interface Snapshot {
  activeChat: { id: string };
  messages: MessageData[];
  persona?: { id: string; name: string };
}

interface MessageData {
  id: string;
  role: string;
  content: string;
  state: string;
  variants?: MessageData[];
}

// ─── Setup helper ──────────────────────────────────────────────────────────

async function setupProviderAndChat(): Promise<{ chatId: string }> {
  // Create provider
  const provider = await json<{ id: string }>(
    await server.api("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Chat Test " + Math.random().toString(36).slice(2, 6),
        providerPreset: "openai_compat",
        endpoint: NANOGPT_BASE_URL,
        apiKey: NANOGPT_API_KEY,
        defaultModel: NANOGPT_MODEL,
        contextBudget: 32000,
        temperature: 0.7,
        topP: 1.0,
        minP: 0.0,
        topK: 0,
        topA: 0,
        frequencyPenalty: 0,
        presencePenalty: 0,
        repetitionPenalty: 1.0,
        maxTokens: 256,
        stopSequences: [],
        seed: null,
        reasoningEffort: "auto",
        streamResponse: true,
      }),
    }),
  );

  // Activate
  await server.api(`/api/providers/${provider.id}/activate`, { method: "POST" });

  // Create character (auto-creates chat)
  const suffix = Math.random().toString(36).slice(2, 6);
  const result = await json<ImportResult>(
    await server.api("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Luna_" + suffix,
        description: "A wise moon priestess.",
        firstMessage: "Welcome, traveler. The moon has been expecting you.",
        personalitySummary: "Calm, mysterious, wise.",
        scenario: "A moonlit temple.",
      }),
    }),
  );

  return { chatId: result.activeChatId };
}

/** Get last assistant message from chat */
function lastAssistant(messages: MessageData[]): MessageData | undefined {
  return [...messages].reverse().find((m) => m.role === "assistant");
}

/** Get last user message from chat */
function lastUser(messages: MessageData[]): MessageData | undefined {
  return [...messages].reverse().find((m) => m.role === "user");
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Chat E2E — send, stream, delete, regenerate", () => {
  let chatId: string;

  it("sets up provider, character, and chat", async () => {
    const setup = await setupProviderAndChat();
    chatId = setup.chatId;
    expect(chatId).toBeTruthy();
  });

  it("has character's first message in the chat", async () => {
    const snap = await json<Snapshot>(await server.api(`/api/chats/${chatId}`));
    const charMsg = lastAssistant(snap.messages);
    expect(charMsg).toBeTruthy();
    expect(charMsg!.content).toContain("moon");
  });

  it("sends 'Hi' non-streaming and gets an AI response", async () => {
    // sendMessage returns a full snapshot
    const snap = await json<Snapshot>(
      await server.api(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hi" }),
      }),
    );
    const reply = lastAssistant(snap.messages);
    expect(reply).toBeTruthy();
    expect(reply!.content.length).toBeGreaterThan(0);
    expect(reply!.state).toBe("complete");
  });

  it("sends another message streaming and collects SSE events", async () => {
    const res = await server.api(`/api/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Tell me about the moon." }),
    });

    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the full SSE stream
    const text = await res.text();
    const hasStreamEvent = text.includes("event: text-delta") || text.includes("event: token") || text.includes("event: chunk");
    const hasFinishEvent = text.includes("event: finish") || text.includes("event: done");
    expect(hasStreamEvent || hasFinishEvent).toBe(true);
  });

  it("deletes the last user message", async () => {
    const snapBefore = await json<Snapshot>(await server.api(`/api/chats/${chatId}`));
    const msgCountBefore = snapBefore.messages.length;

    const target = lastUser(snapBefore.messages);
    expect(target).toBeTruthy();

    const res = await server.api(`/api/chats/${chatId}/messages/${target!.id}`, {
      method: "DELETE",
    });
    expect(res.ok).toBe(true);

    const snapAfter = await json<Snapshot>(await server.api(`/api/chats/${chatId}`));
    expect(snapAfter.messages.length).toBeLessThan(msgCountBefore);
  });

  it("regenerates the last assistant message", async () => {
    const snapBefore = await json<Snapshot>(await server.api(`/api/chats/${chatId}`));
    const target = lastAssistant(snapBefore.messages);
    expect(target).toBeTruthy();

    // regenerateMessage returns a full snapshot
    const snap = await json<Snapshot>(
      await server.api(
        `/api/chats/${chatId}/messages/${target!.id}/regenerate`,
        { method: "POST" },
      ),
    );
    const regenerated = lastAssistant(snap.messages);
    expect(regenerated).toBeTruthy();
    expect(regenerated!.content.length).toBeGreaterThan(0);
  });
});

describe("Chat E2E — persona and system prompt", () => {
  let chatId: string;

  it("creates a fresh chat for persona tests", async () => {
    const setup = await setupProviderAndChat();
    chatId = setup.chatId;
    expect(chatId).toBeTruthy();
  });

  it("creates a new persona", async () => {
    const persona = await json<{ id: string; name: string }>(
      await server.api("/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Aria",
          description: "A curious wanderer from a far land.",
          pronouns: "they/them",
        }),
      }),
    );
    expect(persona.name).toBe("Aria");
    expect(persona.id).toBeTruthy();
  });

  it("updates the persona name (returns snapshot)", async () => {
    const personas = await json<Array<{ id: string; name: string }>>(
      await server.api("/api/personas"),
    );
    const aria = personas.find((p) => p.name === "Aria")!;
    expect(aria).toBeTruthy();

    // updatePersona returns a Snapshot (we don't need to check persona here)
    const res = await server.api(`/api/personas/${aria.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Aria Starweaver" }),
    });
    expect(res.ok).toBe(true);

    // Verify by re-listing personas
    const updated = await json<Array<{ id: string; name: string }>>(
      await server.api("/api/personas"),
    );
    const found = updated.find((p) => p.id === aria.id);
    expect(found!.name).toBe("Aria Starweaver");
  });

  it("assigns persona to the chat", async () => {
    const personas = await json<Array<{ id: string; name: string }>>(
      await server.api("/api/personas"),
    );
    const aria = personas.find((p) => p.name === "Aria Starweaver")!;

    const res = await server.api(`/api/chats/${chatId}/set-persona`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: aria.id }),
    });
    expect(res.ok).toBe(true);
  });

  it("lists prompt presets and updates system prompt", async () => {
    const presets = await json<Array<{ id: string; name: string; system: string }>>(
      await server.api("/api/prompt-presets"),
    );
    expect(presets.length).toBeGreaterThanOrEqual(1);

    const preset = presets[0];
    const updated = await json<{ id: string; system: string }>(
      await server.api(`/api/prompt-presets/${preset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: "You are a mystical storyteller. Always respond in poetic language.",
        }),
      }),
    );
    expect(updated.system).toContain("mystical storyteller");

    const res = await server.api(`/api/chats/${chatId}/set-prompt-preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptPresetId: preset.id }),
    });
    expect(res.ok).toBe(true);
  });
});

describe("Chat E2E — streaming abort", () => {
  let chatId: string;

  it("creates a fresh chat for abort test", async () => {
    const setup = await setupProviderAndChat();
    chatId = setup.chatId;
    expect(chatId).toBeTruthy();
  });

  it("aborts a streaming request", async () => {
    const controller = new AbortController();

    const resPromise = server.api(`/api/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Write a very long story about the moon and stars." }),
      signal: controller.signal,
    });

    // Abort after 500ms
    setTimeout(() => controller.abort(), 500);

    try {
      await resPromise;
    } catch {
      // Expected: abort error — this is fine
    }

    // Chat should still be functional after abort
    const snap = await json<Snapshot>(await server.api(`/api/chats/${chatId}`));
    expect(snap.activeChat.id).toBe(chatId);
  });
});
