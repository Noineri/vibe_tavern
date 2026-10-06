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

  // Behavior change (SCRIPT_SAFETY_PLAN decision 8, SS-4): was — a changed
  // source or a bare enable on ANY interactive script forced enabled:false
  // (every code edit of a mini-app re-disabled it); now — the reviewed-source
  // gate fires ONLY for origin 'imported' scripts with no first enable yet,
  // so a trusted in-app script edits freely and never loses its enabled state.
  test("a trusted in-app interactive script edits freely — a changed source or bare enable never disables it (decision 8)", async () => {
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
    expect(changed.enabled).toBe(true);

    const bareEnable = await jsonRequest(app, `/api/scripts/${created.id}`, "PATCH", {
      enabled: true,
    });
    expect(bareEnable.enabled).toBe(true);

    const sourceOnly = await jsonRequest(app, `/api/scripts/${created.id}`, "PATCH", {
      code: "rules v3",
    });
    expect(sourceOnly.code).toBe("rules v3");
    expect(sourceOnly.enabled).toBe(true);
  });

  test("the reviewed-source gate still fires for an imported never-enabled script — and retires after its first enable", async () => {
    const imported = await jsonRequest(app, "/api/scripts/import", "POST", {
      format: "js",
      name: "Imported Gate Probe",
      code: "rules v1",
      scriptKind: "interactive",
      scopeType: "global",
    });
    expect(imported.origin).toBe("imported");
    expect(imported.enabled).toBe(false);

    // A changed source cannot be trusted in the same update.
    const changed = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      code: "rules v2",
      enabled: true,
    });
    expect(changed.code).toBe("rules v2");
    expect(changed.enabled).toBe(false);

    // A bare enable lacks the reviewed source.
    const bareEnable = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      enabled: true,
    });
    expect(bareEnable.enabled).toBe(false);

    // Naming the exact reviewed source enables AND stamps trust (once).
    const explicitlyTrusted = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      code: "rules v2",
      enabled: true,
    });
    expect(explicitlyTrusted.enabled).toBe(true);
    expect(typeof explicitlyTrusted.firstEnabledAt).toBe("string");
    const stamp = explicitlyTrusted.firstEnabledAt!;

    // Trusted imports edit freely afterwards — the gate retired with the stamp.
    const laterEdit = await jsonRequest(app, `/api/scripts/${imported.id}`, "PATCH", {
      code: "rules v3",
      enabled: true,
    });
    expect(laterEdit.code).toBe("rules v3");
    expect(laterEdit.enabled).toBe(true);
    expect(laterEdit.firstEnabledAt).toBe(stamp);
  });
});
