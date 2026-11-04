/**
 * SM-7 diagnostics route characterization + SM-9a consent-scoped content mode.
 *
 * Pins the owner's «Техническое, без контента» ruling mechanically: the exact
 * four-entry zip list, and that a seeded provider API key and send-debug log
 * CONTENT never appear anywhere in the bundle (the logs dir contributes its
 * byte SIZE only). Defect fixes 2026-11-04: the log entry ships headers only
 * (message bodies can carry character content), and provider endpoints are
 * URL-redacted (userinfo and query never ship). SM-9a hardens the log parse
 * fail-closed (multiline stacks, CRLF), and adds the ONE selected generation
 * attachment: unconfirmed consent, mismatched identity and missing traces are
 * explicit rejections; credentials are stripped from the content archive while
 * the consented prose survives. Real template-backed store container, real
 * temp data dir, real fflate decode of the response.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { unzipSync } from "fflate";
import { createStoreContainer, characters, chats, chatBranches, messages, type StoreContainer } from "@vibe-tavern/db";
import { _resetLogRingForTests, tag } from "@vibe-tavern/domain";
import { DiagnosticsAdapter } from "../src/api/adapters/diagnostics-adapter.js";
import { createDiagnosticsRoutes } from "../src/api/routes/diagnostics.js";
import { redactEndpointForDiagnostics } from "../src/domain/diagnostics/diagnostics-builder.js";
import type { DiagnosticsGenerationSelection } from "../src/domain/diagnostics/generation-diagnostics.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";
import type { PromptTrace } from "@vibe-tavern/db";

const DATA_DIR = join(tmpdir(), `vt-diag-${crypto.randomUUID()}`);
const API_KEY = "sk-SECRET-KEY-do-not-ship";
const SEND_DEBUG_CONTENT = "SECRET_SEND_DEBUG_EVENT possible chat text";
const URL_PASSWORD = "hunter2";
const URL_QUERY_KEY = "sk-in-query-also-secret";
const LOG_MESSAGE_CONTENT = "Elena tilted her head, description fragment";
const STACK_CONTENT = "Elena stack frame with description fragment";
const CRLF_CONTENT = "second CRRLF-continuation line with content";

// Two generations with distinct content markers: only the SELECTED attempt's
// markers may appear in a content-bearing archive.
const REQUEST_MARKER_A = "AURELIA-REQUEST-PROSE";
const RESPONSE_MARKER_A = "AURELIA-RESPONSE-PROSE";
const REQUEST_MARKER_B = "BRAM-UNRELATED-REQUEST-PROSE";

const SELECTION_BODY = (selection: DiagnosticsGenerationSelection, confirmed: boolean) =>
  JSON.stringify({ attach: { selection, confirmed } });

let stores: StoreContainer;
let app: Hono;
let zipTexts: Record<string, string> = {};
let traceA: PromptTrace;
let traceB: PromptTrace;
let tracePartial: PromptTrace;

/** Seed the chat/branch/message rows the prompt_traces FKs point at (the
 * same raw-insert shape as packages/db/test/prompt-trace-chunks.test.ts —
 * the trace store itself is exercised through its real container). */
function seedChatRows(chatId: string, branchIds: readonly string[], messageIds: readonly { id: string; branchId: string }[]): void {
  const now = new Date().toISOString();
  stores.db
    .insert(chats)
    .values({
      id: chatId,
      characterId: "char-diag",
      personaId: null,
      activeBranchId: branchIds[0]!,
      promptPresetId: null,
      title: chatId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const branchId of branchIds) {
    stores.db
      .insert(chatBranches)
      .values({ id: branchId, chatId, parentBranchId: null, label: branchId, createdAt: now })
      .run();
  }
  for (const [index, message] of messageIds.entries()) {
    stores.db
      .insert(messages)
      .values({
        id: message.id,
        chatId,
        branchId: message.branchId,
        role: "assistant",
        authorType: "character",
        position: index,
        content: "seed",
        state: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

function selectionOf(trace: PromptTrace, overrides?: Partial<DiagnosticsGenerationSelection>): DiagnosticsGenerationSelection {
  return {
    traceId: trace.id,
    chatId: trace.chatId,
    branchId: trace.branchId,
    messageId: trace.messageId,
    variantId: trace.variantId,
    ...overrides,
  };
}

async function decodeZip(res: Response): Promise<Record<string, string>> {
  const zip = new Uint8Array(await res.arrayBuffer());
  const texts: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(unzipSync(zip))) {
    texts[path] = new TextDecoder().decode(bytes);
  }
  return texts;
}

beforeAll(async () => {
  await mkdir(join(DATA_DIR, "logs"), { recursive: true });
  await writeFile(join(DATA_DIR, "logs", "send-debug.log"), SEND_DEBUG_CONTENT, "utf-8");
  await writeFile(join(DATA_DIR, "vt.db"), "placeholder-db-bytes", "utf-8");
  stores = await createStoreContainer(":memory:", DATA_DIR);
  await stores.providers.create({
    name: "Secret profile",
    providerPreset: "openai-compatible",
    endpoint: `https://user:${URL_PASSWORD}@aggr.example.com:8443/v1?api_key=${URL_QUERY_KEY}&model=x#frag`,
    apiKey: API_KEY,
  });
  _resetLogRingForTests();
  // The message body is exactly the class of content that must NOT ship.
  tag("diag-test").warn("character card rejected: %s", LOG_MESSAGE_CONTENT);
  // SM-9a: an Error argument embeds its whole multiline stack in ONE ring
  // entry, and a CRLF inside the format string splits the message — the old
  // whole-entry header regex failed on both and shipped them verbatim.
  const exploded = new Error("provider exploded");
  exploded.stack = `Error: provider exploded\n  at stream (x.ts:1:1)\n  ${STACK_CONTENT}`;
  tag("diag-test").error("generation failed:", exploded);
  tag("diag-test").warn(`crlf first line\r\n${CRLF_CONTENT}`);

  // The SELECTED attempt: full capture, carrying credential shapes (structured
  // api_key field, credential-bearing URL, secret echoed into a plain string,
  // response header key) next to its consented prose. The chat/branch/message
  // rows exist because prompt_traces carries real FKs.
  const now = new Date().toISOString();
  stores.db
    .insert(characters)
    .values({
      id: "char-diag",
      name: "DiagChar",
      description: "",
      alternateGreetingsJson: "[]",
      extensionsJson: "{}",
      tagsJson: "[]",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  seedChatRows("chat-aurelia", ["br-aurelia-main", "br-aurelia-alt"], [
    { id: "msg-aurelia-1", branchId: "br-aurelia-main" },
    { id: "msg-aurelia-2", branchId: "br-aurelia-alt" },
  ]);
  seedChatRows("chat-bram", ["br-bram-main"], [{ id: "msg-bram-1", branchId: "br-bram-main" }]);
  traceA = await stores.traces.saveTrace({
    chatId: "chat-aurelia",
    branchId: "br-aurelia-main",
    messageId: "msg-aurelia-1",
    variantId: null,
    model: "test-model-a",
    presetName: "Preset A",
    assembledLayers: [],
    tokenAccounting: { total: 42 },
    finalPayload: {
      model: "test-model-a",
      temperature: 0.7,
      api_key: API_KEY,
      callback_url: `https://user:${URL_PASSWORD}@aggr.example.com:9443/hook?api_key=${URL_QUERY_KEY}`,
      echoed_header: `Bearer ${API_KEY}`,
      messages: [{ role: "user", content: `Please continue the scene. ${REQUEST_MARKER_A}` }],
    },
    activatedLoreEntries: [],
    activatedLoreDetail: [],
    retrievedMemories: [],
    scriptInjections: [],
    latencyMs: 1234,
    sentConfig: {
      systemRole: "system",
      samplerConfig: { temperature: 0.7, top_p: 0.9 },
      messageCount: 3,
    },
    providerResponse: {
      mode: "nonstream",
      steps: [
        {
          response: {
            modelId: "test-model-a",
            headers: { "X-Api-Key": API_KEY, "content-type": "application/json" },
            body: { text: `Aurelia's reply with ${RESPONSE_MARKER_A}` },
          },
          finishReason: "stop",
          usage: { inputTokens: 20, outputTokens: 22, totalTokens: 42 },
        },
      ],
    },
  });
  // An UNRELATED attempt in another chat: its markers must never reach an
  // archive built for the selected one.
  traceB = await stores.traces.saveTrace({
    chatId: "chat-bram",
    branchId: "br-bram-main",
    messageId: "msg-bram-1",
    variantId: null,
    model: "test-model-b",
    presetName: "Preset B",
    assembledLayers: [],
    tokenAccounting: { total: 7 },
    finalPayload: { messages: [{ role: "user", content: REQUEST_MARKER_B }] },
    activatedLoreEntries: [],
    activatedLoreDetail: [],
    retrievedMemories: [],
    scriptInjections: [],
    latencyMs: 99,
    providerResponse: null,
  });
  // A failed attempt with NOTHING captured beyond identity/params.
  tracePartial = await stores.traces.saveTrace({
    chatId: "chat-aurelia",
    branchId: "br-aurelia-alt",
    messageId: "msg-aurelia-2",
    variantId: null,
    model: "test-model-a",
    presetName: "Preset A",
    assembledLayers: [],
    tokenAccounting: {},
    finalPayload: {},
    activatedLoreEntries: [],
    activatedLoreDetail: [],
    retrievedMemories: [],
    scriptInjections: [],
    latencyMs: 0,
    providerResponse: null,
  });

  const adapter = new DiagnosticsAdapter({ stores, dataDir: DATA_DIR });
  app = new Hono()
    .onError((error, c) => {
      if (isDomainError(error)) return c.json(domainErrorToJson(error), httpStatusForDomainError(error));
      return c.json({ error: { kind: "Internal", message: String(error) } }, 500);
    })
    .route("/", createDiagnosticsRoutes(adapter));
  // The DEFAULT zip is requested with the content traces already stored, so
  // every technical-only assertion below proves isolation against real
  // content, not against an empty store.
  const zipRes = await app.request("/api/diagnostics", { method: "POST" });
  zipTexts = await decodeZip(zipRes);
});

afterAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  _resetLogRingForTests();
});

test("the manifest lists exactly the four technical entries", async () => {
  const res = await app.request("/api/diagnostics");
  expect(res.status).toBe(200);
  const manifest = (await res.json()) as { entries: Array<{ path: string; bytes: number }> };
  expect(manifest.entries.map((entry) => entry.path)).toEqual([
    "vt-info.json",
    "server-log.txt",
    "provider-profiles.json",
    "data-sizes.json",
  ]);
  expect(manifest.entries.every((entry) => Number.isFinite(entry.bytes) && entry.bytes >= 0)).toBe(true);
});

test("the zip holds exactly the same four entries with real content", () => {
  expect(Object.keys(zipTexts).sort()).toEqual([
    "data-sizes.json",
    "provider-profiles.json",
    "server-log.txt",
    "vt-info.json",
  ]);
  const info = JSON.parse(zipTexts["vt-info.json"]!) as { version: string; platform: { platform: string }; dbSchemaVersion: number };
  expect(typeof info.version).toBe("string");
  expect(typeof info.platform.platform).toBe("string");
  expect(info.dbSchemaVersion).toBeGreaterThan(0);
  expect(zipTexts["server-log.txt"]!).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN\[diag-test\]/);
});

test("the log entry ships headers only — message bodies never reach the zip", () => {
  const log = zipTexts["server-log.txt"]!;
  expect(log).toMatch(/^.*WARN\[diag-test\]$/m);
});

test("multiline stack and CRLF entries keep their header and lose the whole message (fail-closed parse)", () => {
  const log = zipTexts["server-log.txt"]!;
  // The stack entry's header is kept as the timeline line…
  expect(log).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR\[diag-test\]/);
  // …and NONE of its message — not the first line, not the stack frames.
  expect(log).not.toContain("provider exploded");
  expect(log).not.toContain(STACK_CONTENT);
  expect(log).not.toContain("generation failed:");
  // CRLF: header kept, both message halves gone.
  expect(log).not.toContain("crlf first line");
  expect(log).not.toContain(CRLF_CONTENT);
});

test("provider profiles expose type, endpoint and active flag — never the key or name", () => {
  const profiles = JSON.parse(zipTexts["provider-profiles.json"]!) as Array<Record<string, unknown>>;
  expect(profiles.length).toBe(1);
  expect(profiles[0]).toEqual({
    providerPreset: "openai-compatible",
    endpoint: "https://aggr.example.com:8443/v1",
    isActive: false,
  });
});

test("redactEndpointForDiagnostics: userinfo, query and fragment never ship", () => {
  expect(redactEndpointForDiagnostics("https://user:pass@h.ex/v1?key=1&model=x#f")).toBe("https://h.ex/v1");
  expect(redactEndpointForDiagnostics("https://api.example.com/v1")).toBe("https://api.example.com/v1");
  expect(redactEndpointForDiagnostics("http://h:8080")).toBe("http://h:8080/");
  expect(redactEndpointForDiagnostics("")).toBe("");
  expect(redactEndpointForDiagnostics("not a url at all")).toBe("[invalid-url]");
  expect(redactEndpointForDiagnostics(`https://h.ex/${"a".repeat(400)}`)).toHaveLength(201);
  expect(redactEndpointForDiagnostics(`https://h.ex/${"a".repeat(400)}`).endsWith("…")).toBe(true);
});

test("data sizes report byte totals per top-level entry, including the logs dir", () => {
  const sizes = JSON.parse(zipTexts["data-sizes.json"]!) as { totalBytes: number; entries: Record<string, number> };
  expect(sizes.entries["logs"]).toBe(Buffer.byteLength(SEND_DEBUG_CONTENT));
  expect(sizes.entries["vt.db"]).toBe(Buffer.byteLength("placeholder-db-bytes"));
  expect(sizes.totalBytes).toBeGreaterThan(0);
});

test("no secret or content marker ever appears anywhere in the default bundle", () => {
  for (const text of Object.values(zipTexts)) {
    expect(text.includes(API_KEY)).toBe(false);
    expect(text.includes("Secret profile")).toBe(false);
    expect(text.includes(SEND_DEBUG_CONTENT)).toBe(false);
    expect(text.includes(URL_PASSWORD)).toBe(false);
    expect(text.includes(URL_QUERY_KEY)).toBe(false);
    expect(text.includes(LOG_MESSAGE_CONTENT)).toBe(false);
    expect(text.includes("rejected:")).toBe(false);
    // Stored generations exist at zip time; the default archive ignores them.
    expect(text.includes(REQUEST_MARKER_A)).toBe(false);
    expect(text.includes(RESPONSE_MARKER_A)).toBe(false);
    expect(text.includes(REQUEST_MARKER_B)).toBe(false);
  }
});

// ── SM-9a: selected-generation preview ───────────────────────────────────────

test("preview shows the selected attempt's available entries and redacted contents without confirmation", async () => {
  const res = await app.request("/api/diagnostics/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection: selectionOf(traceA) }),
  });
  expect(res.status).toBe(200);
  const preview = (await res.json()) as {
    model: string;
    presetName: string;
    missing: string[];
    entries: Array<{ path: string; bytes: number }>;
    files: Array<{ path: string; text: string; bytes: number }>;
  };
  expect(preview.model).toBe("test-model-a");
  expect(preview.presetName).toBe("Preset A");
  expect(preview.missing).toEqual([]);
  expect(preview.entries.map((entry) => entry.path)).toEqual([
    "generation/request.json",
    "generation/response.json",
    "generation/metadata.json",
  ]);
  const request = preview.files.find((file) => file.path === "generation/request.json")!;
  // Consented prose is present and inspectable BEFORE any confirmation…
  expect(request.text).toContain(REQUEST_MARKER_A);
  // …while every credential shape is already gone.
  expect(request.text).not.toContain(API_KEY);
  expect(request.text).not.toContain(URL_PASSWORD);
  expect(request.text).not.toContain(URL_QUERY_KEY);
  for (const file of preview.files) expect(file.bytes).toBe(new TextEncoder().encode(file.text).byteLength);
});

test("preview reports missing captures honestly instead of inventing them", async () => {
  const res = await app.request("/api/diagnostics/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection: selectionOf(tracePartial) }),
  });
  expect(res.status).toBe(200);
  const preview = (await res.json()) as { missing: string[]; entries: Array<{ path: string }> };
  expect(preview.missing).toEqual(["finalPayload", "providerResponse"]);
  expect(preview.entries.map((entry) => entry.path)).toEqual(["generation/metadata.json"]);
});

test("preview rejects an identity that does not match the stored trace", async () => {
  const res = await app.request("/api/diagnostics/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection: selectionOf(traceA, { variantId: "var-someone-elses" }) }),
  });
  expect(res.status).toBe(409);
});

// ── SM-9a: consent-scoped zip ────────────────────────────────────────────────

test("a confirmed selection adds ONLY that attempt's entries to the four technical ones", async () => {
  const res = await app.request("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: SELECTION_BODY(selectionOf(traceA), true),
  });
  expect(res.status).toBe(200);
  const texts = await decodeZip(res);
  expect(Object.keys(texts).sort()).toEqual([
    "data-sizes.json",
    "generation/metadata.json",
    "generation/request.json",
    "generation/response.json",
    "provider-profiles.json",
    "server-log.txt",
    "vt-info.json",
  ]);
  // The selected attempt's prose is preserved…
  expect(texts["generation/request.json"]!).toContain(REQUEST_MARKER_A);
  expect(texts["generation/response.json"]!).toContain(RESPONSE_MARKER_A);
  // …and the unrelated generation never joins the archive.
  for (const text of Object.values(texts)) expect(text.includes(REQUEST_MARKER_B)).toBe(false);

  const metadata = JSON.parse(texts["generation/metadata.json"]!) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    traceId: traceA.id,
    chatId: "chat-aurelia",
    branchId: "br-aurelia-main",
    messageId: "msg-aurelia-1",
    variantId: null,
    model: "test-model-a",
    presetName: "Preset A",
    capture: { request: true, response: true },
  });
  const sentConfig = metadata["sentConfig"] as { samplerConfig: Record<string, unknown> };
  expect(sentConfig.samplerConfig).toEqual({ temperature: 0.7, top_p: 0.9 });
});

test("credentials are stripped from the content archive while the consented prose survives", async () => {
  const res = await app.request("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: SELECTION_BODY(selectionOf(traceA), true),
  });
  expect(res.status).toBe(200);
  const texts = await decodeZip(res);
  const request = JSON.parse(texts["generation/request.json"]!) as Record<string, unknown>;
  // Structured credential fields lose their value; a secret echoed into a
  // plain string is replaced in place (the "Bearer " scheme text survives —
  // only the credential itself is gone).
  expect(request["api_key"]).toBe("[redacted]");
  expect(request["echoed_header"]).toBe("Bearer [redacted]");
  // …credential-bearing URLs keep only scheme://host:port/path…
  expect(request["callback_url"]).toBe("https://aggr.example.com:9443/hook");
  // …and prose content stays untouched.
  expect(JSON.stringify(request["messages"])).toContain(REQUEST_MARKER_A);
  const response = JSON.parse(texts["generation/response.json"]!) as {
    steps: Array<{ response: { headers: Record<string, string>; body: { text: string } } }>;
  };
  expect(response.steps[0]!.response.headers["X-Api-Key"]).toBe("[redacted]");
  expect(response.steps[0]!.response.headers["content-type"]).toBe("application/json");
  expect(response.steps[0]!.response.body.text).toContain(RESPONSE_MARKER_A);
  // Nowhere in the whole archive does a configured secret appear.
  for (const text of Object.values(texts)) {
    expect(text.includes(API_KEY)).toBe(false);
    expect(text.includes(URL_PASSWORD)).toBe(false);
    expect(text.includes(URL_QUERY_KEY)).toBe(false);
  }
});

test("unconfirmed or malformed consent is a named rejection — no content archive is built", async () => {
  const unconfirmed = await app.request("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: SELECTION_BODY(selectionOf(traceA), false),
  });
  expect(unconfirmed.status).toBe(400);
  expect(unconfirmed.headers.get("Content-Type")).toContain("application/json");
  const rejection = (await unconfirmed.json()) as { error: { kind: string } };
  expect(rejection.error.kind).toBe("Validation");

  const malformed = await app.request("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not json at all",
  });
  expect(malformed.status).toBe(400);
  expect(((await malformed.json()) as { error: { kind: string } }).error.kind).toBe("Validation");
});

test("a mismatched identity on the zip path is rejected instead of widening the export", async () => {
  const res = await app.request("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: SELECTION_BODY(selectionOf(traceA, { messageId: "msg-aurelia-other" }), true),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe("Conflict");
});

test("a missing or deleted trace is an explicit 404, never a fallback to another generation", async () => {
  const res = await app.request("/api/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: SELECTION_BODY(
      selectionOf(traceA, { traceId: "trace-does-not-exist" }),
      true,
    ),
  });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe("NotFound");
});
