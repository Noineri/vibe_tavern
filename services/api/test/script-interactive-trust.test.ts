import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ScriptAdapter } from "../src/api/adapters/script-adapter.js";
import { createScriptRoutes } from "../src/api/routes/script.js";

interface ScriptResponse {
  id: string;
  code: string;
  enabled: boolean;
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

describe("interactive script exact-version trust HTTP boundary", () => {
  let dataRoot: string;
  let stores: StoreContainer;
  let app: ReturnType<typeof createScriptRoutes>;

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "vt-interactive-trust-"));
    stores = await createStoreContainer(":memory:", dataRoot);
    app = createScriptRoutes(new ScriptAdapter(stores));
  });

  afterAll(async () => {
    stores.db.$client.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test("new and imported interactive rules stay disabled while Prompt and Dice defaults remain enabled", async () => {
    const interactive = await jsonRequest(app, "/api/scripts", "POST", {
      name: "Rules",
      code: "rules v1",
      scriptKind: "interactive",
      scopeType: "global",
      enabled: true,
    });
    expect(interactive.enabled).toBe(false);
    expect(interactive.scriptKind).toBe("interactive");

    const imported = await jsonRequest(app, "/api/scripts/import", "POST", {
      format: "js",
      name: "Imported Rules",
      code: "rules import",
      scriptKind: "interactive",
      scopeType: "global",
    });
    expect(imported.enabled).toBe(false);
    expect(imported.scriptKind).toBe("interactive");

    for (const scriptKind of ["prompt", "dice"] as const) {
      const ordinary = await jsonRequest(app, "/api/scripts", "POST", {
        name: scriptKind,
        code: `${scriptKind} source`,
        scriptKind,
        scopeType: "global",
      });
      expect(ordinary.enabled).toBe(true);
      expect(ordinary.scriptKind).toBe(scriptKind);
    }
  });

  test("a changed interactive source cannot be trusted in the same update", async () => {
    const created = await stores.scripts.create({
      name: "Trusted Rules",
      code: "rules v1",
      scriptKind: "interactive",
      scopeType: "global",
      enabled: true,
    });

    const changed = await jsonRequest(app, `/api/scripts/${created.id}`, "PATCH", {
      code: "rules v2",
      enabled: true,
    });
    expect(changed.code).toBe("rules v2");
    expect(changed.enabled).toBe(false);

    const bareEnable = await jsonRequest(app, `/api/scripts/${created.id}`, "PATCH", {
      enabled: true,
    });
    expect(bareEnable.enabled).toBe(false);

    const explicitlyTrusted = await jsonRequest(app, `/api/scripts/${created.id}`, "PATCH", {
      code: "rules v2",
      enabled: true,
    });
    expect(explicitlyTrusted.code).toBe("rules v2");
    expect(explicitlyTrusted.enabled).toBe(true);
  });
});
