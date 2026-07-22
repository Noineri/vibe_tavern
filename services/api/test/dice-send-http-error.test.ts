import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app-factory.js";
import { DiceBindError } from "@vibe-tavern/db";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";

/**
 * DICE-B11 send-path gap — HTTP/SSE-level contract for dice commit conflicts.
 *
 * `bindActiveAndResetInTx` throws `DiceBindError` (a plain Error, NOT a
 * DomainError) when a send-time dice commit has a stale lane revision or an
 * unresolved choose. Before this fix it propagated unmapped: the non-stream
 * route fell through to the generic 500, and the stream route collapsed it
 * into an SSE error event with only `{message, category}` — so the frontend
 * could never distinguish a retryable dice conflict (refresh pending + keep
 * the draft) from a real server/provider failure.
 *
 * These tests pin the HTTP/SSE surface (NOT `toBeInstanceOf`, which is exactly
 * the hole B11 left — it asserted the runtime-level throw but never the wire
 * shape):
 *  - non-stream POST /messages → HTTP 409 + `error.details.code`.
 *  - stream POST /messages/stream → SSE `error` event carrying `code`.
 *
 * The runtime stub throws DiceBindError directly from sendMessage /
 * sendMessageStream; that IS the same throwable the real bind produces, and the
 * routes forward it verbatim, so the assertion targets the mapping (the fix).
 */

// Valid per sendMessageSchema: content + the both-or-neither dice intent.
const SEND_BODY = { content: "roll for me", diceMode: "normal", pendingRevision: 0 };

// RuntimeApi is decomposed per-feature by createApiRouter (createChatRoutes
// (runtime.chat)), so the stub nests the send methods under `chat`.
function runtimeWithSend(send: { sendMessage?: RuntimeApi["chat"]["sendMessage"]; sendMessageStream?: RuntimeApi["chat"]["sendMessageStream"] }): RuntimeApi {
  return { chat: send } as unknown as RuntimeApi;
}

function postJson(url: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SEND_BODY),
  };
}

describe("dice send conflict → HTTP 409 (non-stream POST /messages)", () => {
  test("stale revision → 409 Conflict + error.details.code 'stale_revision'", async () => {
    const runtime = runtimeWithSend({
      sendMessage: async () => {
        throw new DiceBindError("stale_revision", "Expected revision 0, got 1");
      },
    });
    const app = await createApp({ runtime });

    const res = await app.request("/api/chats/chat_1/messages", postJson("/api/chats/chat_1/messages"));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { kind: string; message: string; details?: { code?: string } } };
    expect(body.error.kind).toBe("Conflict");
    expect(body.error.details?.code).toBe("stale_revision");
  });

  test("unresolved choose → 409 Conflict + error.details.code 'unresolved_choose'", async () => {
    const runtime = runtimeWithSend({
      sendMessage: async () => {
        throw new DiceBindError("unresolved_choose", "Roll 'r1' has choose policy but no finalAttemptId");
      },
    });
    const app = await createApp({ runtime });

    const res = await app.request("/api/chats/chat_1/messages", postJson("/api/chats/chat_1/messages"));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { kind: string; details?: { code?: string } } };
    expect(body.error.details?.code).toBe("unresolved_choose");
  });
});

describe("dice send conflict → SSE error event code (stream POST /messages/stream)", () => {
  test("stale revision → SSE error event carries code 'stale_revision'", async () => {
    const runtime = runtimeWithSend({
      sendMessageStream: async function* () {
        throw new DiceBindError("stale_revision", "Expected revision 0, got 1");
      },
    });
    const app = await createApp({ runtime });

    const res = await app.request("/api/chats/chat_1/messages/stream", postJson("/api/chats/chat_1/messages/stream"));

    // Streaming headers are sent before the generator runs, so this is an SSE
    // error event over HTTP 200 (it cannot become a 409) — the code rides the
    // event payload instead.
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"code":"stale_revision"');
  });

  test("unresolved choose → SSE error event carries code 'unresolved_choose'", async () => {
    const runtime = runtimeWithSend({
      sendMessageStream: async function* () {
        throw new DiceBindError("unresolved_choose", "Roll 'r1' has choose policy but no finalAttemptId");
      },
    });
    const app = await createApp({ runtime });

    const res = await app.request("/api/chats/chat_1/messages/stream", postJson("/api/chats/chat_1/messages/stream"));

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"code":"unresolved_choose"');
  });
});
