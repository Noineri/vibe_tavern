/**
 * Test 1 — Welcome screen scenarios
 *
 * Covers three distinct paths a user takes from the welcome screen:
 *   1. "Start free chat"       → POST /api/chats (no characterId)
 *   2. "Create character"      → POST /api/characters (auto-creates chat)
 *   3. "Import Oliver(telepath)" → POST /api/import/json
 *
 * All three run sequentially on the same test server instance.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { createTestServer, json } from "./helpers/e2e-server.js";
import type { TestServer } from "./helpers/e2e-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  if (server) await server.cleanup();
});

// ─── Shared types ──────────────────────────────────────────────────────────

interface BootstrapResponse {
  isFirstRun: boolean;
  initialChatId: string | null;
  allCharacters: Array<{ id: string; name: string }>;
}

/** createFromScratch / importJson return this shape */
interface ImportResult {
  activeChatId: string;
  snapshot: { activeChat: { id: string }; messages: unknown[] };
  imported: { kind: string; name: string };
}

/** createFreeChat returns SessionSnapshot */
interface Snapshot {
  activeChat: { id: string };
  messages: unknown[];
}

// ─── Scenario A: Start free chat ───────────────────────────────────────────

describe("Welcome → Start free chat", () => {
  it("shows isFirstRun=true on fresh bootstrap", async () => {
    const boot = await json<BootstrapResponse>(
      await server.api("/api/bootstrap"),
    );
    expect(boot.isFirstRun).toBe(true);
    expect(boot.initialChatId).toBeNull();
  });

  it("creates a free chat (no characterId)", async () => {
    const snap = await json<Snapshot>(
      await server.api("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(snap.activeChat.id).toBeTruthy();
    expect(snap.messages).toBeDefined();
  });

  it("shows isFirstRun=false after creating a chat", async () => {
    const boot = await json<BootstrapResponse>(
      await server.api("/api/bootstrap"),
    );
    expect(boot.isFirstRun).toBe(false);
  });
});

// ─── Scenario B: Create character from scratch ─────────────────────────────

describe("Welcome → Create character from scratch", () => {
  const charName = "Luna_" + Date.now().toString(36);

  it("creates a character (and auto-creates a chat)", async () => {
    const result = await json<ImportResult>(
      await server.api("/api/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: charName,
          description: "A mysterious moon priestess who speaks in riddles.",
          firstMessage: "*gazes at the moon* So, you have come at last...",
          personalitySummary: "Enigmatic, gentle, otherworldly.",
          scenario: "A moonlit temple atop a mountain.",
        }),
      }),
    );
    expect(result.activeChatId).toBeTruthy();
    expect(result.imported.name).toBe(charName);
    expect(result.imported.kind).toBe("character");
  });

  it("lists the new character in bootstrap", async () => {
    const boot = await json<BootstrapResponse>(
      await server.api("/api/bootstrap"),
    );
    const names = boot.allCharacters.map((c) => c.name);
    expect(names).toContain(charName);
  });

  it("has the character's first message in the chat", async () => {
    const boot = await json<BootstrapResponse>(
      await server.api("/api/bootstrap"),
    );
    const snap = await json<Snapshot>(
      await server.api(`/api/chats/${boot.initialChatId!}`),
    );
    const assistantMsg = snap.messages.find(
      (m: any) => m.role === "assistant",
    );
    expect(assistantMsg).toBeTruthy();
  });
});

// ─── Scenario C: Import Oliver (telepath) ──────────────────────────────────

describe("Welcome → Import character (Oliver the telepath)", () => {
  it("imports Oliver from JSON file", async () => {
    const oliverJson = JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Oliver",
        description: "A quiet telepath who reads surface thoughts unbidden.",
        personality: "Reserved, compassionate, slightly haunted.",
        scenario: "A rain-soaked café where Oliver has been waiting.",
        first_mes: "*looks up from a cold cup of coffee* I already know why you're here.",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        character_book: null,
        depth_prompt: "",
        depth_prompt_depth: 4,
        depth_prompt_role: "system",
        alternate_greetings: [],
        extensions: {},
        tags: [],
      },
    });

    const result = await json<ImportResult>(
      await server.api("/api/import/json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "Oliver.json",
          jsonText: oliverJson,
        }),
      }),
    );
    expect(result.activeChatId).toBeTruthy();
    expect(result.imported.name).toBe("Oliver");
  });

  it("lists Oliver in bootstrap characters", async () => {
    const boot = await json<BootstrapResponse>(
      await server.api("/api/bootstrap"),
    );
    const names = boot.allCharacters.map((c) => c.name);
    expect(names).toContain("Oliver");
  });

  it("has Oliver's first message in the chat", async () => {
    const boot = await json<BootstrapResponse>(
      await server.api("/api/bootstrap"),
    );
    const snap = await json<Snapshot>(
      await server.api(`/api/chats/${boot.initialChatId!}`),
    );
    const assistantMsg = snap.messages.find(
      (m: any) => m.role === "assistant",
    );
    expect(assistantMsg).toBeTruthy();
  });
});
