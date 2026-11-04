/**
 * SM-7 diagnostics route characterization.
 *
 * Pins the owner's «Техническое, без контента» ruling mechanically: the exact
 * four-entry zip list, and that a seeded provider API key and send-debug log
 * CONTENT never appear anywhere in the bundle (the logs dir contributes its
 * byte SIZE only). Defect fixes 2026-11-04: the log entry ships headers only
 * (message bodies can carry character content), and provider endpoints are
 * URL-redacted (userinfo and query never ship). Real template-backed store
 * container, real temp data dir, real fflate decode of the response.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { _resetLogRingForTests, tag } from "@vibe-tavern/domain";
import { DiagnosticsAdapter } from "../src/api/adapters/diagnostics-adapter.js";
import { createDiagnosticsRoutes } from "../src/api/routes/diagnostics.js";
import { redactEndpointForDiagnostics } from "../src/domain/diagnostics/diagnostics-builder.js";

const DATA_DIR = join(tmpdir(), `vt-diag-${crypto.randomUUID()}`);
const API_KEY = "sk-SECRET-KEY-do-not-ship";
const SEND_DEBUG_CONTENT = "SECRET_SEND_DEBUG_EVENT possible chat text";
const URL_PASSWORD = "hunter2";
const URL_QUERY_KEY = "sk-in-query-also-secret";
const LOG_MESSAGE_CONTENT = "Elena tilted her head, description fragment";

let stores: StoreContainer;
let app: ReturnType<typeof createDiagnosticsRoutes>;
let zipTexts: Record<string, string> = {};

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
  const adapter = new DiagnosticsAdapter({ stores, dataDir: DATA_DIR });
  app = createDiagnosticsRoutes(adapter);
  const zipRes = await app.request("/api/diagnostics", { method: "POST" });
  const zip = new Uint8Array(await zipRes.arrayBuffer());
  for (const [path, bytes] of Object.entries(unzipSync(zip))) {
    zipTexts[path] = new TextDecoder().decode(bytes);
  }
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

test("no secret ever appears anywhere in the bundle", () => {
  for (const text of Object.values(zipTexts)) {
    expect(text.includes(API_KEY)).toBe(false);
    expect(text.includes("Secret profile")).toBe(false);
    expect(text.includes(SEND_DEBUG_CONTENT)).toBe(false);
    expect(text.includes(URL_PASSWORD)).toBe(false);
    expect(text.includes(URL_QUERY_KEY)).toBe(false);
    expect(text.includes(LOG_MESSAGE_CONTENT)).toBe(false);
    expect(text.includes("rejected:")).toBe(false);
  }
});
