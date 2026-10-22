import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { SkillLibraryService } from "../src/domain/coauthor/skills/skill-library.js";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createCopilotProfileRoutes } from "../src/api/routes/copilot-profile.js";
import { CopilotProfileAdapter } from "../src/api/adapters/copilot-profile-adapter.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";
// Side-effect imports: register the real kinds so the adapter's dispatch and
// the profile adapter's kind resolution see the live registry.
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";
import "../src/domain/agent/kinds/sidechat-ooc-kind.js";

/**
 * SC-5 — the sidechat's OWN skill library and tool toggles, end to end:
 *
 * 1. A skill pinned in a sidechat thread resolves through the ADAPTER's
 *    sidechat stream wiring (the shared pinned-context resolver over the
 *    sidechat library — SC-4b's inert skill arm replaced) from the SIDECHAT
 *    library only: the same skill id exists in the experience library too,
 *    and the experience body must NOT reach the sidechat turn's prompt.
 *    The provider boundary is a local chat-completions stand-in (the same
 *    pattern experience-copilot-kind-resolution.test.ts uses) recording the
 *    request body the stream sends; everything below it is REAL (an
 *    in-memory store container, the real RP sync + SC-3b package, the real
 *    SC-0f profile chain, the real SkillLibraryService).
 *
 * 2. `?kind=sidechat-ooc` on the profile routes serves ITS seed + its own
 *    profiles only, a sidechat tool set validates against the kind's
 *    registered schema (a native key round-trips through the sidechat
 *    row→wire projection; a foreign key is a 422), and the default
 *    (experience) list never leaks a sidechat row in.
 */

// ─── The provider stand-in (the one true external boundary) ──────────────────

const requestBodies: string[] = [];
const providerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    requestBodies.push(await req.text());
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    const body =
      chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

afterAll(async () => {
  await providerServer.stop(true);
});

// ─── Real-container harness ──────────────────────────────────────────────────

let stores: StoreContainer;
let adapter: ExperienceCopilotAdapter;
let characterId: string;
let providerProfileId: string;

const PINNED_SKILL_ID = "plot-talk";
const SIDECHAT_BODY_MARKER = "SIDECHAT-LIBRARY-SKILL-BODY-MARKER";
const EXPERIENCE_BODY_MARKER = "EXPERIENCE-LIBRARY-SKILL-BODY-MARKER";

const manifest = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: A pinned-skill fixture.\n---\n\n# ${name}\n\n${body}\n`;

beforeAll(async () => {
  // Scratch tree under the test runner's swept TEMP root: the SQLite handle
  // stays open for the process's life (the sibling sidechat suites' convention
  // — no rm of the data root in afterAll; the runner sweeps its private root).
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-sidechat-skill-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const persona = await stores.personas.create({
    name: "Sable",
    description: "A wandering cartographer.",
    pronouns: "she/her",
    defaultForNewChats: true,
  });
  expect(persona.name).toBe("Sable");
  const character = await stores.characters.create({
    name: "Theron",
    description: "A brooding ranger.",
  });
  characterId = character.id;
  const provider = await stores.providers.create({
    name: "Sidechat skill pin provider",
    providerPreset: "openai",
    endpoint: `http://127.0.0.1:${providerServer.port}/v1`,
    defaultModel: "test-model",
    contextBudget: null,
    maxTokens: 2000,
    bindPerModel: false,
  });
  providerProfileId = provider.id;

  // The sidechat library (temp roots) and the experience library, each with
  // the SAME skill id but distinct bodies — the leak probe.
  const sidechatUser = join(dataRoot, "sidechat-user-skills");
  const sidechatBuiltin = join(dataRoot, "sidechat-builtin-skills");
  const expUser = join(dataRoot, "exp-user-skills");
  await mkdir(join(sidechatUser, PINNED_SKILL_ID), { recursive: true });
  await mkdir(join(expUser, PINNED_SKILL_ID), { recursive: true });
  await mkdir(sidechatBuiltin, { recursive: true });
  await Bun.write(
    join(sidechatUser, PINNED_SKILL_ID, "SKILL.md"),
    manifest(PINNED_SKILL_ID, SIDECHAT_BODY_MARKER),
  );
  await Bun.write(
    join(expUser, PINNED_SKILL_ID, "SKILL.md"),
    manifest(PINNED_SKILL_ID, EXPERIENCE_BODY_MARKER),
  );
  adapter = new ExperienceCopilotAdapter(
    stores,
    undefined,
    new SkillLibraryService(expUser, join(dataRoot, "exp-builtin-skills")),
    undefined,
    new SkillLibraryService(sidechatUser, sidechatBuiltin),
  );
});


/** A chat + active branch + a chat-owned sidechat thread with the skill pinned. */
async function makeThreadWithPinnedSkill(): Promise<string> {
  const chat = await stores.chats.createChat({
    characterId,
    title: "SC-5 skill pin fixture",
  });
  const thread = await stores.experienceCopilot.startNewChatSession(
    chat.id,
    chat.activeBranchId,
    "sidechat-ooc",
  );
  await stores.experienceCopilot.setContextLinks(thread.id, [
    { targetType: "skill", targetId: PINNED_SKILL_ID },
  ]);
  return thread.id;
}

async function drainAdapterTurn(threadId: string): Promise<string[]> {
  const events: string[] = [];
  requestBodies.length = 0;
  for await (const chunk of adapter.experienceCopilotStream(threadId, {
    content: "Let us talk about the plot.",
    providerProfileId,
  })) {
    events.push(chunk.event);
  }
  return events;
}

// ─── 1. The pinned skill resolves from the sidechat library only ─────────────

describe("ExperienceCopilotAdapter sidechat stream — pinned skills (SC-5)", () => {
  test("a pinned skill resolves from the SIDECHAT library, never the experience one", async () => {
    const threadId = await makeThreadWithPinnedSkill();
    const events = await drainAdapterTurn(threadId);
    expect(events).toContain("finish");
    expect(requestBodies).toHaveLength(1);
    const body = requestBodies[0]!;
    // The pinned-context block carries the SIDECHAT library's body…
    expect(body).toContain("# Pinned context");
    expect(body).toContain(SIDECHAT_BODY_MARKER);
    // …and never the experience library's copy of the same skill id.
    expect(body).not.toContain(EXPERIENCE_BODY_MARKER);
  });
});

// ─── 2. ?kind=sidechat-ooc profiles + the toggle seam ────────────────────────

type ProfileWire = { id: string; name: string; isBuiltIn: boolean; agentKind: string; toolSet: Record<string, boolean> };
type ErrorWire = { error: { kind: string; message: string; details?: Record<string, unknown> } };

function makeProfilesApp() {
  const app = createCopilotProfileRoutes(new CopilotProfileAdapter(stores));
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  return app;
}

async function postProfile(app: ReturnType<typeof makeProfilesApp>, body: Record<string, unknown>) {
  return app.request("/api/copilot/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET/POST /api/copilot/profiles?kind=sidechat-ooc (SC-5)", () => {
  test("a sidechat tool set validates against the kind's schema and round-trips its own keys", async () => {
    const app = makeProfilesApp();
    // A native key is accepted by the wire union AND the kind's registered
    // schema, and survives the row→wire projection (the sidechat branch).
    const ok = await postProfile(app, {
      name: "Sidechat custom",
      basePrompt: "A custom sidechat prompt.",
      toolSet: { read_plan: true },
      agentKind: "sidechat-ooc",
    });
    expect(ok.status).toBe(200);
    const created = (await ok.json()) as ProfileWire;
    expect(created.agentKind).toBe("sidechat-ooc");
    expect(created.toolSet).toEqual({ read_plan: true });

    // A foreign key (the experience kind's) is rejected against the kind's
    // registered schema — 422, never silently stripped.
    const foreign = await postProfile(app, {
      name: "Foreign tools",
      basePrompt: "p",
      toolSet: { write_buffer: true },
      agentKind: "sidechat-ooc",
    });
    expect(foreign.status).toBe(422);
    expect(((await foreign.json()) as ErrorWire).error.details?.code).toBe(
      "copilot_profile_invalid_tool_set",
    );
  });

  test("?kind=sidechat-ooc lists its seed + its own profiles; the default list never leaks them in", async () => {
    const app = makeProfilesApp();
    const sc = await app.request("/api/copilot/profiles?kind=sidechat-ooc");
    expect(sc.status).toBe(200);
    const scBody = (await sc.json()) as { profiles: ProfileWire[] };
    // The seed is first, chat-side, and carries every landed tool
    // (the SC-10 search pair, SC-11's propose_objective, SC-12's todo +
    // read_plan, SC-23e's read_message_prompt).
    expect(scBody.profiles[0]?.id).toBe("builtin");
    expect(scBody.profiles[0]?.agentKind).toBe("sidechat-ooc");
    expect(scBody.profiles[0]?.toolSet).toEqual({
      search_context: true,
      read_context_item: true,
      propose_objective: true,
      todo: true,
      read_plan: true,
      read_message_prompt: true,
    });
    const custom = scBody.profiles.filter((p) => !p.isBuiltIn);
    expect(custom.map((p) => p.name)).toEqual(["Sidechat custom"]);
    for (const p of scBody.profiles) expect(p.agentKind).toBe("sidechat-ooc");

    // The default (no ?kind=) is the experience list: the sidechat seed and
    // the sidechat custom profile are invisible there.
    const def = await app.request("/api/copilot/profiles");
    const defBody = (await def.json()) as { profiles: ProfileWire[] };
    expect(defBody.profiles[0]?.agentKind).toBe("experience");
    for (const p of defBody.profiles) expect(p.agentKind).toBe("experience");
  });
});
