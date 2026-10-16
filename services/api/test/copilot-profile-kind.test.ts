import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import type { ScriptKind } from "@vibe-tavern/domain";
import { createCopilotProfileRoutes } from "../src/api/routes/copilot-profile.js";
import { createScriptRoutes } from "../src/api/routes/script.js";
import { CopilotProfileAdapter } from "../src/api/adapters/copilot-profile-adapter.js";
import { ScriptAdapter } from "../src/api/adapters/script-adapter.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";
import { resolveBuiltinCopilotProfile } from "../src/domain/interactive/copilot/experience-copilot-module.js";
import {
  registerAgentKind,
  UnknownAgentKindError,
} from "../src/domain/agent/agent-kind-registry.js";
import type { AgentKind } from "../src/domain/agent/agent-kind.js";
// Side-effect import: registers the real experience kind (serves interactive),
// so the assignment guard resolves script kinds through the registry.
import "../src/domain/agent/kinds/experience-kind.js";

/**
 * AS-3 — copilot profiles per kind. Pins the three owner failure points plus
 * the plan's own list contract:
 *
 * 1. Lists are FILTERED per kind — the `?kind=` default (`experience`) must
 *    not mask an unfiltered list (a profile of another kind is invisible
 *    unless its kind is requested).
 * 2. UPDATE cannot smuggle a kind change or a foreign tool set — the update
 *    contract omits `agentKind` (strict-rejected) and a supplied tool set is
 *    re-validated against the profile's OWN stored kind.
 * 3. NO silent fallback to the experience seed for another kind — an unknown
 *    kind is a 400 (`UNKNOWN_AGENT_KIND`) at the route and throws at the seed.
 *
 * Cross-kind tests use a registered FAKE kind (the AS-2a pattern: register +
 * unsubscribe in `afterAll`, no registry reset) whose strict tool-set schema
 * (`{ quill_draft? }`) lacks every experience key. The fake serves NO script
 * kind, so the registry mapping tests observe no overlap from this file.
 */

const FAKE_KIND_ID = "fake-quill-kind";

function makeFakeKind(): AgentKind {
  return {
    id: FAKE_KIND_ID,
    servesScriptKinds: [] as readonly ScriptKind[],
    basePromptServiceKey: `${FAKE_KIND_ID}_base`,
    skillRootId: FAKE_KIND_ID,
    toolSetSchema: z.object({ quill_draft: z.boolean().optional() }).strict(),
    defaultToolSet: { quill_draft: true },
    recencyAnchorText: "Fake-kind recency anchor.",
    renderContextPackage: () => "",
  };
}

let stores: StoreContainer;
let profilesApp: ReturnType<typeof createCopilotProfileRoutes>;
let scriptsApp: ReturnType<typeof createScriptRoutes>;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-copilot-profile-kind-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  profilesApp = createCopilotProfileRoutes(new CopilotProfileAdapter(stores));
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the 400/422 boundaries are observable — the same
  // pattern as copilot-profile-routes.test.ts.
  profilesApp.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  scriptsApp = createScriptRoutes(new ScriptAdapter(stores));
  scriptsApp.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
});

const unsubscribes: Array<() => void> = [];
beforeAll(() => {
  unsubscribes.push(registerAgentKind(makeFakeKind()));
});
afterAll(() => {
  for (const off of unsubscribes) off();
});

type ProfileWire = { id: string; name: string; isBuiltIn: boolean; agentKind: string };
type ErrorWire = { error: { kind: string; message: string; details?: Record<string, unknown> } };

async function postProfile(body: Record<string, unknown>) {
  const res = await profilesApp.request("/api/copilot/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

async function createScript(scriptKind: string) {
  const res = await scriptsApp.request("/api/scripts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `${scriptKind} script`, scriptKind, scopeType: "global" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("GET /api/copilot/profiles?kind= (AS-3, failure point 1)", () => {
  test("two experience profiles list under the default; a foreign-kind profile does not leak in", async () => {
    // The wire tool-set contract is experience-shaped, so a fake-kind profile
    // can only carry the (empty) intersection — `{}` passes both schemas.
    const exp1 = await postProfile({ name: "Exp one", basePrompt: "first", toolSet: { write_buffer: true } });
    expect(exp1.status).toBe(200);
    const exp2 = await postProfile({ name: "Exp two", basePrompt: "second", toolSet: {} });
    expect(exp2.status).toBe(200);
    const fake = await postProfile({
      name: "Quill",
      basePrompt: "quill prompt",
      toolSet: {},
      agentKind: FAKE_KIND_ID,
    });
    expect(fake.status).toBe(200);
    const fakeId = ((await fake.json()) as ProfileWire).id;

    // Default (no ?kind=) = experience: seed first, both experience profiles,
    // NO fake-kind profile — the default must not mask an unfiltered list.
    const def = await profilesApp.request("/api/copilot/profiles");
    expect(def.status).toBe(200);
    const defBody = (await def.json()) as { profiles: ProfileWire[] };
    expect(defBody.profiles[0]?.id).toBe("builtin");
    expect(defBody.profiles[0]?.agentKind).toBe("experience");
    expect(defBody.profiles.filter((p) => !p.isBuiltIn).map((p) => p.name)).toEqual(
      expect.arrayContaining(["Exp one", "Exp two"]),
    );
    expect(defBody.profiles.some((p) => p.id === fakeId)).toBe(false);
    for (const p of defBody.profiles) expect(p.agentKind).toBe("experience");

    // Explicit ?kind=experience matches the default.
    const exp = await profilesApp.request("/api/copilot/profiles?kind=experience");
    expect(exp.status).toBe(200);
    const expBody = (await exp.json()) as { profiles: ProfileWire[] };
    expect(expBody.profiles.map((p) => p.id).sort()).toEqual(defBody.profiles.map((p) => p.id).sort());

    // ?kind=<fake> = the fake seed first, then only the fake profile.
    const fq = await profilesApp.request(`/api/copilot/profiles?kind=${FAKE_KIND_ID}`);
    expect(fq.status).toBe(200);
    const fqBody = (await fq.json()) as { profiles: ProfileWire[] };
    expect(fqBody.profiles[0]?.id).toBe("builtin");
    expect(fqBody.profiles[0]?.agentKind).toBe(FAKE_KIND_ID);
    expect(fqBody.profiles.filter((p) => !p.isBuiltIn).map((p) => p.id)).toEqual([fakeId]);
  });

  test("unknown kind → 400 carrying UNKNOWN_AGENT_KIND (no silent fallback)", async () => {
    const res = await profilesApp.request("/api/copilot/profiles?kind=no-such-kind");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorWire;
    expect(body.error.details?.code).toBe("UNKNOWN_AGENT_KIND");
  });
});

describe("POST /api/copilot/profiles kind validation (AS-3, failure point 2)", () => {
  test("a tool set foreign to the kind → 422 copilot_profile_invalid_tool_set", async () => {
    // `write_buffer` is an experience key — foreign to the fake kind whose
    // strict schema only knows `quill_draft`.
    const res = await postProfile({
      name: "Foreign tools",
      basePrompt: "p",
      toolSet: { write_buffer: true },
      agentKind: FAKE_KIND_ID,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorWire;
    expect(body.error.details?.code).toBe("copilot_profile_invalid_tool_set");
  });

  test("an unknown kind → 400 carrying UNKNOWN_AGENT_KIND", async () => {
    const res = await postProfile({ name: "Lost", basePrompt: "p", toolSet: {}, agentKind: "no-such-kind" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorWire;
    expect(body.error.details?.code).toBe("UNKNOWN_AGENT_KIND");
  });

  test("omitting the kind creates an experience profile (current web client untouched)", async () => {
    const res = await postProfile({ name: "No kind sent", basePrompt: "p", toolSet: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProfileWire).agentKind).toBe("experience");
  });
});

describe("PATCH /api/copilot/profiles/:id kind immutability (AS-3, failure point 2)", () => {
  test("an agentKind key is strict-rejected → 400 (kind cannot be smuggled)", async () => {
    const created = await postProfile({ name: "Smuggle me", basePrompt: "p", toolSet: {} });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as ProfileWire).id;
    const res = await profilesApp.request(`/api/copilot/profiles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentKind: FAKE_KIND_ID }),
    });
    expect(res.status).toBe(400);
  });

  test("a tool set foreign to the profile's OWN stored kind → 422", async () => {
    const created = await postProfile({ name: "Quill owned", basePrompt: "p", toolSet: {}, agentKind: FAKE_KIND_ID });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as ProfileWire).id;
    // Experience keys are foreign to the fake kind that owns this profile.
    const bad = await profilesApp.request(`/api/copilot/profiles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolSet: { write_buffer: true } }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorWire).error.details?.code).toBe("copilot_profile_invalid_tool_set");
    // A same-kind tool set still updates fine.
    const ok = await profilesApp.request(`/api/copilot/profiles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Quill owned v2" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ProfileWire).agentKind).toBe(FAKE_KIND_ID);
  });
});

describe("script assignment guard (AS-3, failure point 2)", () => {
  test("a fake-kind profile on an interactive script → 422 copilot_profile_kind_mismatch", async () => {
    const created = await postProfile({ name: "Quill assign", basePrompt: "p", toolSet: {}, agentKind: FAKE_KIND_ID });
    expect(created.status).toBe(200);
    const profileId = ((await created.json()) as ProfileWire).id;
    const scriptId = await createScript("interactive");
    const res = await scriptsApp.request(`/api/scripts/${scriptId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ copilotProfileId: profileId }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorWire).error.details?.code).toBe("copilot_profile_kind_mismatch");
  });

  test("an experience profile on a prompt script → 422 (only the script kind's own profiles fit, AS-7)", async () => {
    // Since AS-7 a prompt script RESOLVES to the `script` kind, so an
    // experience profile is a cross-kind assignment — still a 422 (the
    // pre-AS-7 reason "unserved kind accepts no profile" no longer applies).
    const created = await postProfile({ name: "Exp assign", basePrompt: "p", toolSet: {} });
    expect(created.status).toBe(200);
    const profileId = ((await created.json()) as ProfileWire).id;
    const scriptId = await createScript("prompt");
    const res = await scriptsApp.request(`/api/scripts/${scriptId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ copilotProfileId: profileId }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorWire).error.details?.code).toBe("copilot_profile_kind_mismatch");
  });

  test("a same-kind assignment + unassign still pass", async () => {
    const created = await postProfile({ name: "Exp ok", basePrompt: "p", toolSet: {} });
    expect(created.status).toBe(200);
    const profileId = ((await created.json()) as ProfileWire).id;
    const scriptId = await createScript("interactive");
    const assign = await scriptsApp.request(`/api/scripts/${scriptId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ copilotProfileId: profileId }),
    });
    expect(assign.status).toBe(200);
    const unassign = await scriptsApp.request(`/api/scripts/${scriptId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ copilotProfileId: null }),
    });
    expect(unassign.status).toBe(200);
  });
});

describe("resolveBuiltinCopilotProfile(kind) (AS-3, failure point 3)", () => {
  test("an unknown kind throws UnknownAgentKindError — never the experience seed", async () => {
    let caught: unknown;
    try {
      await resolveBuiltinCopilotProfile("no-such-kind");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownAgentKindError);
    expect((caught as UnknownAgentKindError).code).toBe("UNKNOWN_AGENT_KIND");
  });

  test("the default (no kind) is the experience seed, unchanged", async () => {
    const seed = await resolveBuiltinCopilotProfile();
    expect(seed.id).toBe("builtin");
    expect(seed.isBuiltIn).toBe(true);
    expect(seed.agentKind).toBe("experience");
  });
});
