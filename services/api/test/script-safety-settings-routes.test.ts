/**
 * SS-4 — script-safety settings endpoints (SCRIPT_SAFETY_PLAN decision 3).
 *
 * Full-path through the REAL routes + REAL adapter + REAL singleton store
 * (in-memory SQLite): GET returns the defaults when no row exists yet, PUT
 * upserts and persists, and the wire shape satisfies the SS-3 contract
 * schema. Mirrors the coauthor-settings-routes pattern of exercising the
 * route → adapter → store stack against `createDb(":memory:")`.
 */
import { describe, expect, test } from "bun:test";
import { createDb } from "@vibe-tavern/db";
import type { StoreContainer } from "@vibe-tavern/db";
import { scriptSafetySettingsSchema } from "@vibe-tavern/api-contracts";
import { SettingsAdapter } from "../src/api/adapters/settings-adapter.js";
import { createSettingsRoutes } from "../src/api/routes/settings.js";

/** StoreContainer stub carrying only the member the script-safety endpoints
 * touch — the adapter seam (constructor DI) keeps this test-local. */
async function makeApp(): Promise<ReturnType<typeof createSettingsRoutes>> {
  const db = await createDb(":memory:");
  return createSettingsRoutes(new SettingsAdapter({ db } as unknown as StoreContainer));
}

describe("GET/PUT /api/settings/script-safety (SS-4)", () => {
  test("GET returns the defaults (not suppressed) when no row exists yet", async () => {
    const app = await makeApp();
    const res = await app.request("/api/settings/script-safety");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { suppressImportWarnings: boolean; updatedAt: string };
    expect(json.suppressImportWarnings).toBe(false);
    expect(json.updatedAt).toBe("");
    expect(scriptSafetySettingsSchema.safeParse(json).success).toBe(true);
  });

  test("PUT persists the singleton; GET round-trips; a second PUT flips it back", async () => {
    const app = await makeApp();

    const put = await app.request("/api/settings/script-safety", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suppressImportWarnings: true }),
    });
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { suppressImportWarnings: boolean; updatedAt: string };
    expect(saved.suppressImportWarnings).toBe(true);
    expect(saved.updatedAt).not.toBe("");
    expect(scriptSafetySettingsSchema.safeParse(saved).success).toBe(true);

    const get = await app.request("/api/settings/script-safety");
    expect(get.status).toBe(200);
    expect(((await get.json()) as { suppressImportWarnings: boolean }).suppressImportWarnings).toBe(true);

    const flip = await app.request("/api/settings/script-safety", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suppressImportWarnings: false }),
    });
    expect(flip.status).toBe(200);
    expect(((await flip.json()) as { suppressImportWarnings: boolean }).suppressImportWarnings).toBe(false);
  });

  test("PUT without the boolean → 400 (the flag is required, not defaulted)", async () => {
    const app = await makeApp();
    const missing = await app.request("/api/settings/script-safety", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const wrongType = await app.request("/api/settings/script-safety", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suppressImportWarnings: "yes" }),
    });
    expect(wrongType.status).toBe(400);
  });
});
