import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app-factory.js";
import { ExperienceBindError } from "@vibe-tavern/db";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";

/**
 * IR-70H send-path gap — HTTP/SSE-level contract for experience-attachment bind
 * conflicts, mirroring the Dice suite (dice-send-http-error.test.ts).
 *
 * `verifyAndBindAttachmentInTx` throws `ExperienceBindError` (a plain Error,
 * NOT a DomainError) with one of four codes — `not_found`, `already_bound`,
 * `stale_queue`, `stale_session` — when the send-time experience-attachment
 * bind has a mismatch. Before IR-70H it propagated unmapped: the non-stream
 * route fell through to the generic 500, and the stream route collapsed it into
 * an SSE error event that dropped the code — so the frontend could never
 * distinguish a retryable bind conflict (refresh pending + keep the draft) from
 * a real server/provider failure.
 *
 * These tests pin the HTTP/SSE surface (the mapping, NOT the runtime throw):
 *  - non-stream POST /messages → HTTP 409 + `error.details.code`, never 500.
 *  - stream POST /messages/stream → HTTP 200 SSE with an `error` event carrying
 *    the exact typed code after the generator throws.
 *  - the payload stays structured; no private attachment/state data leaks.
 *
 * The runtime stub throws ExperienceBindError directly from sendMessage /
 * sendMessageStream; that IS the same throwable the real bind produces, and the
 * routes forward it verbatim, so the assertion targets the mapping (the fix),
 * not a pure helper.
 */

// Valid per sendMessageSchema: content + the all-or-none experience commit
// intent (the three fields carry only identifiers the server already stored —
// never raw transcript/events/state).
const SEND_BODY = {
  content: "send this turn",
  experienceAttachmentId: "exp_att_1",
  experienceQueueRevision: 0,
  experienceSessionRevision: 1,
};

// The four ExperienceBindError codes, each with a representative message.
const CODES: Array<{ code: "not_found" | "already_bound" | "stale_queue" | "stale_session"; message: string }> = [
  { code: "not_found", message: "Experience attachment 'exp_att_1' was not found." },
  { code: "already_bound", message: "Experience attachment 'exp_att_1' is already bound to message 'msg_1'." },
  { code: "stale_queue", message: "Experience attachment 'exp_att_1' queue revision mismatch: expected 0, stored 1." },
  { code: "stale_session", message: "Experience attachment 'exp_att_1' session revision mismatch: expected 1, stored 2." },
];

// RuntimeApi is decomposed per-feature by createApiRouter (createChatRoutes gets
// runtime.chat), so the stub nests the send methods under `chat`. Same typed
// runtime stub pattern as the Dice suite.
function runtimeWithSend(send: {
  sendMessage?: RuntimeApi["chat"]["sendMessage"];
  sendMessageStream?: RuntimeApi["chat"]["sendMessageStream"];
}): RuntimeApi {
  return { chat: send } as unknown as RuntimeApi;
}

function postJson(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SEND_BODY),
  };
}

describe("experience send bind conflict → HTTP 409 (non-stream POST /messages)", () => {
  for (const { code, message } of CODES) {
    test(`${code} → 409 Conflict + error.details.code '${code}', never 500`, async () => {
      const runtime = runtimeWithSend({
        sendMessage: async () => {
          throw new ExperienceBindError(code, message);
        },
      });
      const app = await createApp({ runtime });

      const res = await app.request("/api/chats/chat_1/messages", postJson());

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { kind: string; message: string; details?: { code?: string } };
      };
      expect(body.error.kind).toBe("Conflict");
      expect(body.error.details?.code).toBe(code);
      // Structured message survives verbatim.
      expect(body.error.message).toBe(message);
    });
  }

  test("no private attachment/state data leaks into the 409 body", async () => {
    const runtime = runtimeWithSend({
      sendMessage: async () => {
        throw new ExperienceBindError("stale_queue", "queue revision mismatch");
      },
    });
    const app = await createApp({ runtime });

    const res = await app.request("/api/chats/chat_1/messages", postJson());
    expect(res.status).toBe(409);
    const text = await res.text();

    // The error shape is exactly { error: { kind, message, details: { code } } };
    // never the queued attachment row, frozen transcript, events, or hidden state.
    expect(text).not.toContain("boundMessageId");
    expect(text).not.toContain("sessionRevision");
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("checkpoint");
  });
});

describe("experience send bind conflict → SSE error event code (stream POST /messages/stream)", () => {
  for (const { code, message } of CODES) {
    test(`${code} → HTTP 200 SSE with error event carrying the exact code`, async () => {
      const runtime = runtimeWithSend({
        sendMessageStream: async function* () {
          throw new ExperienceBindError(code, message);
        },
      });
      const app = await createApp({ runtime });

      const res = await app.request("/api/chats/chat_1/messages/stream", postJson());

      // Streaming headers are committed before the generator runs, so this is an
      // SSE error event over HTTP 200 (it cannot become a 409) — the code rides
      // the event payload instead.
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("event: error");
      expect(text).toContain(`"code":"${code}"`);
    });
  }

  test("SSE error event keeps the structured message and wire-parity category, no private data", async () => {
    const runtime = runtimeWithSend({
      sendMessageStream: async function* () {
        throw new ExperienceBindError("already_bound", "already bound to msg_1");
      },
    });
    const app = await createApp({ runtime });

    const res = await app.request("/api/chats/chat_1/messages/stream", postJson());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Structured message rides the event; `category` stays on the wire for
    // parity; `code` is the authoritative signal.
    expect(text).toContain('"message":"already bound to msg_1"');
    expect(text).toContain('"category"');
    expect(text).toContain('"code":"already_bound"');
    // No private attachment/state data.
    expect(text).not.toContain("boundMessageId");
    expect(text).not.toContain("sessionRevision");
    expect(text).not.toContain("transcript");
    expect(text).not.toContain("checkpoint");
  });
});
