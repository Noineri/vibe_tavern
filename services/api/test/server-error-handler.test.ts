import { describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app-factory.js";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";
import { notFound } from "../src/shared/errors.js";
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";

/**
 * Contract tests for the global Hono error handler (app.onError in
 * app-factory.ts). Pins the three-way error dispatch:
 *
 *  1. ProviderExecutionError → 502 + error.details.category (the non-stream
 *     path of provider-error categorization — Layer 3). Without the dedicated
 *     branch this falls through to the generic 500, which is both a status
 *     regression (was 502 via the old providerError() DomainError) and loses
 *     the category the UI needs.
 *  2. DomainError → its kind's mapped status (unchanged behavior, guard).
 *  3. Anything else → 500 Internal (unchanged behavior, guard).
 *
 * Uses configureFeatures to mount a throw-route so the handler is exercised in
 * isolation, without the full chat runtime.
 */

// createApp only needs a runtime reference for route closures; the throw route
// never calls it, so an empty stub is sufficient (mirrors feature-routes.test.ts).
const runtime = {} as unknown as RuntimeApi;

async function appThrowing(throwable: () => unknown) {
  return createApp({
    runtime,
    configureFeatures: (app) => {
      app.get("/test-throw", () => {
        throw throwable();
      });
    },
  });
}

describe("global error handler (app.onError)", () => {
  test("ProviderExecutionError → 502 with category in error.details", async () => {
    const app = await appThrowing(
      () => new ProviderExecutionError("Invalid API key", "authentication", "openai_compat", { statusCode: 401 }),
    );
    const res = await app.request("/test-throw");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { kind: "Provider", message: "Invalid API key", details: { category: "authentication" } },
    });
  });

  test("DomainError (notFound) still maps to 404 — regression guard", async () => {
    // The new ProviderExecutionError branch must not shadow the existing
    // DomainError dispatch.
    const app = await appThrowing(() => notFound("Chat", "chat_missing"));
    const res = await app.request("/test-throw");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.kind).toBe("NotFound");
  });

  test("a generic Error → 500 Internal — regression guard", async () => {
    const app = await appThrowing(() => new Error("unexpected"));
    const res = await app.request("/test-throw");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.kind).toBe("Internal");
  });
});
