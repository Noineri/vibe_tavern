/**
 * SS-4 — script-safety server-side gates at the adapter/route boundary
 * (SCRIPT_SAFETY_PLAN Wave 3).
 *
 * Full-path through the REAL routes + REAL adapter + REAL store (temp SQLite
 * via createStoreContainer) — no mocked store. Pins the import-safety
 * perimeter: every import path arrives disabled + origin-stamped; the
 * createScript `origin` param (the mini-app file-import path) cannot smuggle
 * an enabled script past the warning flow; the first-enable trust stamp is
 * never bypassed by the API; and POST /scripts/:scriptId/test refuses an
 * imported never-enabled script without the warning-acknowledged flag.
 *
 * The reviewed-source gate scoping (trusted scripts' edits never disable)
 * has its own boundary file: script-interactive-trust.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ScriptAdapter } from "../src/api/adapters/script-adapter.js";
import { createScriptRoutes } from "../src/api/routes/script.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";

interface ScriptResponse {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
  origin: string;
  firstEnabledAt: string | null;
  scriptKind: string;
}

async function jsonRequest(
  app: ReturnType<typeof createScriptRoutes>,
  path: string,
  method: "POST" | "PATCH",
  body: object,
): Promise<ScriptResponse> {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(method === "POST" ? 201 : 200);
  return response.json() as Promise<ScriptResponse>;
}

describe("SS-4 — import disabled + origin stamped (adapter + routes)", () => {
  let dataRoot: string;
  let stores: StoreContainer;
  let app: ReturnType<typeof createScriptRoutes>;

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "vt-ss4-adapter-"));
    stores = await createStoreContainer(":memory:", dataRoot);
    app = createScriptRoutes(new ScriptAdapter(stores));
    // Production-shaped DomainError mapping (the ai-instruction-template
    // route-test pattern) so refusal wire shapes are assertable here.
    app.onError((err, c) => {
      if (isDomainError(err)) {
        return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
      }
      return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
    });
  });

  afterAll(async () => {
    stores.db.$client.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test("js-format import arrives disabled + origin 'imported' for EVERY kind", async () => {
    for (const scriptKind of ["prompt", "dice", "interactive"] as const) {
      const imported = await jsonRequest(app, "/api/scripts/import", "POST", {
        format: "js",
        name: `Imported ${scriptKind}`,
        code: `// ${scriptKind} source`,
        scriptKind,
        scopeType: "global",
      });
      expect(imported.enabled).toBe(false);
      expect(imported.origin).toBe("imported");
      expect(imported.firstEnabledAt).toBeNull();
      expect(imported.scriptKind).toBe(scriptKind);
    }
  });

  test("json-format import arrives disabled + origin 'imported' too", async () => {
    const imported = await jsonRequest(app, "/api/scripts/import", "POST", {
      format: "json",
      jsonText: JSON.stringify({ name: "Json Import", code: "// json source" }),
      scriptKind: "prompt",
      scopeType: "global",
    });
    expect(imported.enabled).toBe(false);
    expect(imported.origin).toBe("imported");
    expect(imported.firstEnabledAt).toBeNull();
  });

  test("in-app creation keeps today's defaults: prompt/dice enabled, interactive disabled — origin 'in_app'", async () => {
    for (const scriptKind of ["prompt", "dice"] as const) {
      const created = await jsonRequest(app, "/api/scripts", "POST", {
        name: `Own ${scriptKind}`,
        code: `// ${scriptKind} source`,
        scriptKind,
        scopeType: "global",
      });
      expect(created.enabled).toBe(true);
      expect(created.origin).toBe("in_app");
    }
    const interactive = await jsonRequest(app, "/api/scripts", "POST", {
      name: "Own Rules",
      code: "// rules source",
      scriptKind: "interactive",
      scopeType: "global",
    });
    expect(interactive.enabled).toBe(false);
    expect(interactive.origin).toBe("in_app");
  });

  test("create with origin 'imported' (the mini-app file-import path) arrives disabled even when enabled:true rides the body", async () => {
    const created = await jsonRequest(app, "/api/scripts", "POST", {
      name: "Imported via create",
      code: "// mini-app bundle rules",
      scriptKind: "prompt",
      scopeType: "global",
      origin: "imported",
      enabled: true,
    });
    expect(created.origin).toBe("imported");
    expect(created.enabled).toBe(false);
    expect(created.firstEnabledAt).toBeNull();
  });

  test("first enable of an imported script stamps trust exactly once — disable/re-enable never clears or re-stamps", async () => {
    const imported = await jsonRequest(app, "/api/scripts/import", "POST", {
      format: "js",
      name: "Stamp probe",
      code: "// stamp source",
      scriptKind: "prompt",
      scopeType: "global",
    });

    const enabled = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      code: "// stamp source",
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(typeof enabled.firstEnabledAt).toBe("string");
    const stamp = enabled.firstEnabledAt!;

    const disabled = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.firstEnabledAt).toBe(stamp);

    const reenabled = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      code: "// stamp source",
      enabled: true,
    });
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.firstEnabledAt).toBe(stamp);
  });
});

describe("SS-4 — the test route refuses untrusted imported scripts (decision 14)", () => {
  let dataRoot: string;
  let stores: StoreContainer;
  let app: ReturnType<typeof createScriptRoutes>;

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "vt-ss4-testroute-"));
    stores = await createStoreContainer(":memory:", dataRoot);
    app = createScriptRoutes(new ScriptAdapter(stores));
    app.onError((err, c) => {
      if (isDomainError(err)) {
        return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
      }
      return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
    });
  });

  afterAll(async () => {
    stores.db.$client.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function importPromptScript(name: string): Promise<ScriptResponse> {
    return jsonRequest(app, "/api/scripts/import", "POST", {
      format: "js",
      name,
      code: "// test-route probe",
      scriptKind: "prompt",
      scopeType: "global",
    });
  }

  test("an imported never-enabled script without the ack flag → 409 + typed script_not_enabled", async () => {
    const imported = await importPromptScript("Refused import");
    const res = await app.request(`/api/scripts/${imported.id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { kind: string; message: string; details?: { code?: string } } };
    expect(body.error.kind).toBe("Conflict");
    expect(body.error.details?.code).toBe("script_not_enabled");
  });

  test("the same script runs with warningAcknowledged: true (the warning modal's flag)", async () => {
    const imported = await importPromptScript("Acked import");
    const res = await app.request(`/api/scripts/${imported.id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warningAcknowledged: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("prompt");
  });

  test("in-app scripts and trusted (once-enabled) imports run without the ack flag", async () => {
    const own = await jsonRequest(app, "/api/scripts", "POST", {
      name: "Own probe",
      code: "// own source",
      scriptKind: "prompt",
      scopeType: "global",
    });
    const ownRun = await app.request(`/api/scripts/${own.id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(ownRun.status).toBe(200);
    expect(((await ownRun.json()) as { kind: string }).kind).toBe("prompt");

    const imported = await importPromptScript("Trusted import");
    await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      code: "// test-route probe",
      enabled: true,
    });
    const trustedRun = await app.request(`/api/scripts/${imported.id}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(trustedRun.status).toBe(200);
    expect(((await trustedRun.json()) as { kind: string }).kind).toBe("prompt");
  });
});
