import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { Hono } from "hono";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createAgentKindSettingsRoutes } from "../src/api/routes/agent-kind-settings.js";
import { registerAgentKind } from "../src/domain/agent/agent-kind-registry.js";
import type { AgentKind } from "../src/domain/agent/agent-kind.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
// Side-effect imports: register the built-in kinds so the `experience` and
// `script` ids resolve through the registry (the route tests need them).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";

/**
 * SC-0d — per-agent-kind model settings over the REAL adapter, store
 * container (temp data dir) and route module:
 *
 * 1. A kind without a row reads the legacy `ui_settings` copilot pair
 *    (owner decision 2: nobody loses their choice).
 * 2. PATCH one kind upserts that kind ONLY — the other kind stays on the
 *    legacy pair.
 * 3. An unknown kind is a 400 UNKNOWN_AGENT_KIND on both routes.
 * 4. The PATCH body is `.strict()` — an unknown key is a 400.
 * 5. Partial-patch semantics on a fresh kind: the first insert seeds the
 *    pair columns from the legacy choice, absent fields keep their stored
 *    value on later patches, `null` clears one field.
 * 6. The bootstrap payload carries the per-kind map (effective pair per
 *    registered kind — rows and legacy fallback alike).
 *
 * The fake kind (patch-semantics isolation unit) is registered test-locally
 * (beforeAll register / afterAll unsubscribe — the registry has no reset).
 */

const FAKE_KIND_ID = "aks-fake-kind";
const LEGACY_PROVIDER_ID = "prov_legacy";
const LEGACY_MODEL_NAME = "model_legacy";

/** A minimal registered kind for the fresh-row tests — the settings routes
 *  serve every registered kind, so its owner/shape is irrelevant here. */
function makeFakeKind(): AgentKind {
  return {
    id: FAKE_KIND_ID,
    owner: "chat",
    servesScriptKinds: [],
    basePromptServiceKey: `${FAKE_KIND_ID}_base`,
    skillRootId: FAKE_KIND_ID,
    toolSetSchema: z.object({ fake_tool: z.boolean().optional() }).strict(),
    defaultToolSet: { fake_tool: true },
    recencyAnchorText: "(fake kind pins no context)",
    renderContextPackage: () => "",
  };
}

interface KindSettingsWire {
  agentKind: string;
  providerProfileId: string | null;
  modelName: string | null;
  defaultProfileId: string | null;
  updatedAt: string;
}

let stores: StoreContainer;
let routes: Hono;
let unregisterFakeKind: () => void;

function settingsUrl(kind: string): string {
  return `/api/agent/kinds/${kind}/settings`;
}

async function getSettings(kind: string): Promise<Response> {
  return routes.request(settingsUrl(kind));
}

async function patchSettings(kind: string, body: Record<string, unknown>): Promise<Response> {
  return routes.request(settingsUrl(kind), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  unregisterFakeKind = registerAgentKind(makeFakeKind());
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-agent-kind-settings-"));
  stores = await createStoreContainer(join(dataRoot, "agent-kind-settings.db"), dataRoot);
  // The defaults the character-create path of the bootstrap harness needs
  // (same set as session-runtime-bootstrap.test.ts; ui_settings is ensured by
  // the legacy-pair update below).
  await stores.personas.ensureDefault();
  await stores.presets.ensureDefault();
  const adapter = new ExperienceCopilotAdapter(stores);
  routes = createAgentKindSettingsRoutes(adapter);
  // The pre-kinds choice every fallback test reads: the legacy pair on the
  // ui_settings singleton (no agent_kind_settings row exists yet).
  await stores.uiSettings.update({
    copilotProviderId: LEGACY_PROVIDER_ID,
    copilotModelName: LEGACY_MODEL_NAME,
  });
});

afterAll(() => {
  // No data-dir teardown here: the bunfig preload's global afterAll closes
  // every opened SQLite handle and sweeps the run's temp dirs (the sibling
  // route suites over createStoreContainer do the same).
  unregisterFakeKind();
});

describe("per-kind settings routes (SC-0d)", () => {
  test("a kind without a row reads the legacy ui_settings pair", async () => {
    const res = await getSettings("experience");
    expect(res.status).toBe(200);
    const body = (await res.json()) as KindSettingsWire;
    expect(body.agentKind).toBe("experience");
    expect(body.providerProfileId).toBe(LEGACY_PROVIDER_ID);
    expect(body.modelName).toBe(LEGACY_MODEL_NAME);
    // The legacy pair never carried a profile default.
    expect(body.defaultProfileId).toBeNull();
  });

  test("PATCH one kind upserts that kind only — the other stays on the legacy pair", async () => {
    const patchRes = await patchSettings("script", {
      providerProfileId: "prov_script",
      modelName: "model_script",
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as KindSettingsWire;
    expect(patched.agentKind).toBe("script");
    expect(patched.providerProfileId).toBe("prov_script");
    expect(patched.modelName).toBe("model_script");

    const other = (await (await getSettings("experience")).json()) as KindSettingsWire;
    expect(other.providerProfileId).toBe(LEGACY_PROVIDER_ID);
    expect(other.modelName).toBe(LEGACY_MODEL_NAME);
  });

  test("an unknown kind is a 400 UNKNOWN_AGENT_KIND on both routes", async () => {
    const getRes = await getSettings("no-such-kind");
    expect(getRes.status).toBe(400);
    expect(((await getRes.json()) as { code: string }).code).toBe("UNKNOWN_AGENT_KIND");

    const patchRes = await patchSettings("no-such-kind", { providerProfileId: "prov_x" });
    expect(patchRes.status).toBe(400);
    const body = (await patchRes.json()) as { error: string; code: string };
    expect(body.code).toBe("UNKNOWN_AGENT_KIND");
    expect(body.error).toContain("no-such-kind");
  });

  test("the PATCH body is strict — an unknown key is a 400", async () => {
    const res = await patchSettings("experience", { providerProfileId: "prov_x", bogus: true });
    expect(res.status).toBe(400);
  });

  test("partial-patch semantics on a fresh kind: legacy-seeded insert, absent-keeps-stored, null clears", async () => {
    // First touch seeds the pair columns from the legacy choice (owner
    // decision 2 — a partial first PATCH never drops the pre-kinds model).
    const first = (await (await patchSettings(FAKE_KIND_ID, { providerProfileId: "prov_fake" })).json()) as KindSettingsWire;
    expect(first.providerProfileId).toBe("prov_fake");
    expect(first.modelName).toBe(LEGACY_MODEL_NAME);

    // A later partial patch keeps the stored value of absent fields.
    const second = (await (await patchSettings(FAKE_KIND_ID, { modelName: "model_fake2" })).json()) as KindSettingsWire;
    expect(second.providerProfileId).toBe("prov_fake");
    expect(second.modelName).toBe("model_fake2");

    // `null` clears exactly the field it names.
    const third = (await (await patchSettings(FAKE_KIND_ID, { providerProfileId: null })).json()) as KindSettingsWire;
    expect(third.providerProfileId).toBeNull();
    expect(third.modelName).toBe("model_fake2");
  });
});

describe("the bootstrap payload carries the per-kind map (SC-0d)", () => {
  test("getBootstrapState maps every registered kind to its effective settings", async () => {
    const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
    // The same harness shape as session-runtime-bootstrap.test.ts: an awaited
    // character create settles the constructor's fire-and-forget chat-order
    // seed before the bootstrap read (a fresh runtime's order is still stale
    // until then — accessing items earlier throws by design).
    await runtime.character.createFromScratch({
      name: "Kind settings bootstrap probe",
      description: "a probe character",
      firstMessage: "Hello there!",
    });
    const boot = await runtime.getBootstrapState();

    // Rows and legacy fallback alike, keyed by kind id. The exact key set is
    // process-global registry state (sibling test files may register fakes),
    // so the assertions pin the built-ins' entries, not the map's size.
    expect(boot.agentKindSettings["script"]).toBeDefined();
    expect(boot.agentKindSettings["script"].providerProfileId).toBe("prov_script");
    expect(boot.agentKindSettings["script"].modelName).toBe("model_script");

    expect(boot.agentKindSettings["experience"]).toBeDefined();
    expect(boot.agentKindSettings["experience"].providerProfileId).toBe(LEGACY_PROVIDER_ID);
    expect(boot.agentKindSettings["experience"].modelName).toBe(LEGACY_MODEL_NAME);

    // The map is read through the same store fallback the routes use.
    expect(boot.agentKindSettings[FAKE_KIND_ID].providerProfileId).toBeNull();
    expect(boot.agentKindSettings[FAKE_KIND_ID].modelName).toBe("model_fake2");
  });
});
