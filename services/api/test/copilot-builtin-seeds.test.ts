import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { copilotProfileSchema } from "@vibe-tavern/api-contracts";
import { z } from "zod";
import { createCopilotProfileRoutes } from "../src/api/routes/copilot-profile.js";
import { CopilotProfileAdapter } from "../src/api/adapters/copilot-profile-adapter.js";
import {
  isDomainError,
  httpStatusForDomainError,
  domainErrorToJson,
} from "../src/shared/errors.js";
import { CopilotProfileResolver } from "../src/domain/interactive/copilot/copilot-profile-resolver.js";
import {
  EXPERIENCE_BUILTIN_SEEDS,
  builtinCopilotSeeds,
  isBuiltinCopilotProfileId,
  isBuiltinCopilotProfileOfKind,
  resolveBuiltinCopilotProfile,
} from "../src/domain/interactive/copilot/experience-copilot-module.js";
import { SCRIPT_AGENT_BUILTIN_SEEDS } from "../src/domain/agent/script-agent/script-agent-module.js";
import { BUILTIN_PROFILE_ID } from "../src/domain/agent/agent-kind.js";
import {
  getAgentKind,
  registerAgentKind,
  InvalidAgentKindBuiltinSeedsError,
} from "../src/domain/agent/agent-kind-registry.js";
import {
  SIDECHAT_DIRECTOR_SEED_NAME,
  SIDECHAT_OOC_BUILTIN_SEEDS,
  SIDECHAT_OOC_SEED_NAME,
  resolveBuiltinSidechatOocProfile,
} from "../src/domain/agent/kinds/sidechat-ooc-kind.js";
// Side-effect imports: register the built-in kinds (the adapter's requireKind
// and the descriptor reads below resolve through the registry; production does
// the same in server-runtime.ts).
import "../src/domain/agent/kinds/experience-kind.js";
import "../src/domain/agent/kinds/script-kind.js";
import "../src/domain/agent/kinds/sidechat-ooc-kind.js";

/**
 * DR-1 — several built-in profiles per agent kind. Pins the unit's contract:
 *
 * 1. The descriptor carries a LIST of built-in seeds (`builtinSeeds`); every
 *    kind's FIRST seed keeps the id "builtin" (the stored sentinel —
 *    mechanically enforced at registration).
 * 2. The sidechat kind ships a SECOND seed (`builtin-director`, `Director`)
 *    declared in its own kind module — a valid shell until DR-4 (the OOC
 *    base prompt + OOC tool toggles), differing from the first seed only in
 *    id and name.
 * 3. The profile list serves ALL of the kind's built-ins FIRST (declared
 *    order), then user rows as before.
 * 4. The chat-owned resolver chain accepts ANY built-in id of the kind — as
 *    the chat choice AND as the kind default; a built-in id of ANOTHER kind
 *    falls through exactly like a dangling id.
 * 5. The id namespace stays disjoint: a user profile can never take a
 *    built-in id (store-minted `cprof_…` ids; the strict create contract
 *    carries no `id` key), and every built-in id is read-only (update/delete
 *    400).
 */

let stores: StoreContainer;
let app: ReturnType<typeof createCopilotProfileRoutes>;
let resolver: CopilotProfileResolver;
let characterId: string;

beforeAll(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-copilot-builtin-seeds-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  app = createCopilotProfileRoutes(new CopilotProfileAdapter(stores));
  // Mount the production DomainError → status mapping (shared helpers, not
  // duplicated logic) so the read-only 400s are observable — the same pattern
  // as copilot-profile-routes.test.ts.
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  resolver = new CopilotProfileResolver(stores);
  const character = await stores.characters.create({ name: "DR-1 fixture" });
  characterId = character.id;
});

const newChat = (title: string) =>
  stores.chats.createChat({ characterId, title, promptPresetId: null });

type ProfileWire = { id: string; name: string; isBuiltIn: boolean; agentKind: string };

// ─── 1. The descriptor's seed list ──────────────────────────────────────────

describe("the descriptor's builtinSeeds list (DR-1)", () => {
  test("every kind's FIRST seed keeps the stored sentinel id \"builtin\"", () => {
    for (const kind of ["experience", "script", "sidechat-ooc"] as const) {
      const seeds = getAgentKind(kind).builtinSeeds;
      expect(seeds.length).toBeGreaterThan(0);
      expect(seeds[0]?.id).toBe(BUILTIN_PROFILE_ID);
    }
  });

  test("the sidechat kind declares two seeds in order — Sidechat OOC first, Director second", () => {
    // The second seed lives in the sidechat kind's OWN file, never in
    // agent-kind.ts (no director names in the generic descriptor).
    expect(getAgentKind("sidechat-ooc").builtinSeeds).toEqual(SIDECHAT_OOC_BUILTIN_SEEDS);
    expect(SIDECHAT_OOC_BUILTIN_SEEDS).toEqual([
      { id: "builtin", name: SIDECHAT_OOC_SEED_NAME },
      { id: "builtin-director", name: SIDECHAT_DIRECTOR_SEED_NAME },
    ]);
    expect(SIDECHAT_DIRECTOR_SEED_NAME).toBe("Director");
    // The one-seed kinds stay one-seed (their lists unchanged in shape).
    expect(EXPERIENCE_BUILTIN_SEEDS).toEqual([{ id: "builtin", name: "Experience Authoring" }]);
    expect(SCRIPT_AGENT_BUILTIN_SEEDS).toEqual([{ id: "builtin", name: "Script Authoring" }]);
  });

  test("registration refuses a seed list whose first id is not the sentinel", () => {
    for (const builtinSeeds of [[], [{ id: "builtin-director", name: "Bad" }]] as const) {
      let caught: unknown;
      try {
        registerAgentKind({
          id: "dr1-bad-seeds",
          owner: "chat",
          servesScriptKinds: [],
          servesChatModes: [],
          basePromptServiceKey: "dr1_bad",
          skillRootId: "dr1",
          toolSetSchema: z.object({ fake_tool: z.boolean().optional() }).strict(),
          defaultToolSet: {},
          builtinSeeds,
          recencyAnchorText: "",
          renderContextPackage: () => "",
        });
      } catch (err) {
        caught = err;
      }
      // Thrown BEFORE insertion — nothing to unregister.
      expect(caught).toBeInstanceOf(InvalidAgentKindBuiltinSeedsError);
    }
  });
});

// ─── 2. The director seed resolves as a valid shell ──────────────────────────

describe("resolveBuiltinCopilotProfile('sidechat-ooc', …, 'builtin-director') (DR-1)", () => {
  test("resolves the Director seed: the OOC base + OOC tools, differing from the first seed only in id and name", async () => {
    const director = await resolveBuiltinCopilotProfile("sidechat-ooc", undefined, "builtin-director");
    const first = await resolveBuiltinCopilotProfile("sidechat-ooc");
    expect(director.id).toBe("builtin-director");
    expect(director.name).toBe(SIDECHAT_DIRECTOR_SEED_NAME);
    expect(director.isBuiltIn).toBe(true);
    expect(director.agentKind).toBe("sidechat-ooc");
    // Until DR-4 the seed is a SHELL: the same base prompt and tool toggles
    // as the OOC seed (DR-4 swaps in the director's own).
    expect(director.basePrompt).toBe(first.basePrompt);
    expect(director.toolSet).toEqual(first.toolSet);
    // The shell is a VALID profile — it passes the wire schema.
    expect(copilotProfileSchema.safeParse(director).success).toBe(true);
    // The dispatch reaches the sidechat kind's own resolver for either seed.
    expect(director).toEqual(await resolveBuiltinSidechatOocProfile(undefined, "builtin-director"));
  });
});

// ─── 3. The profile list: all built-ins first, declared order ────────────────

describe("GET /api/copilot/profiles?kind=sidechat-ooc (DR-1)", () => {
  test("serves BOTH built-ins first in declared order, then the kind's user rows", async () => {
    const created = await app.request("/api/copilot/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sidechat custom",
        basePrompt: "A user-side sidechat profile.",
        toolSet: {},
        agentKind: "sidechat-ooc",
      }),
    });
    expect(created.status).toBe(200);
    const createdId = ((await created.json()) as ProfileWire).id;

    const res = await app.request("/api/copilot/profiles?kind=sidechat-ooc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: ProfileWire[] };
    // Declared order: Sidechat OOC, then Director — both before user rows.
    expect(body.profiles[0]).toMatchObject({
      id: "builtin",
      name: SIDECHAT_OOC_SEED_NAME,
      isBuiltIn: true,
      agentKind: "sidechat-ooc",
    });
    expect(body.profiles[1]).toMatchObject({
      id: "builtin-director",
      name: SIDECHAT_DIRECTOR_SEED_NAME,
      isBuiltIn: true,
      agentKind: "sidechat-ooc",
    });
    // User rows follow the built-ins, in their stored order.
    const userRows = body.profiles.slice(2);
    expect(userRows.some((p) => p.id === createdId)).toBe(true);
    expect(userRows.every((p) => !p.isBuiltIn)).toBe(true);
  });

  test("the one-seed kinds keep the single-seed envelope (no second entry appears)", async () => {
    const res = await app.request("/api/copilot/profiles?kind=experience");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: ProfileWire[] };
    expect(body.profiles[0]?.id).toBe("builtin");
    expect(body.profiles[0]?.isBuiltIn).toBe(true);
    expect(body.profiles.filter((p) => p.isBuiltIn)).toHaveLength(1);
  });
});

// ─── 4. The resolver chain accepts any built-in id of the kind ───────────────

describe("CopilotProfileResolver.resolveForChat — built-in seed ids (DR-1)", () => {
  test("a chat choice of \"builtin-director\" resolves the Director seed, never the kind default", async () => {
    // A kind-default USER row is set: a pinned built-in must skip it (the
    // SC-0k rule, seed-aware).
    const kindDefault = await stores.copilotProfiles.create({
      name: "Sidechat kind default",
      basePrompt: "The kind default that must be skipped.",
      toolSet: {},
      agentKind: "sidechat-ooc",
    });
    await stores.agentKindSettings.patch("sidechat-ooc", { defaultProfileId: kindDefault.id });
    const chat = await newChat("Director chat pin");
    await stores.chatAgentSettings.patch(chat.id, "sidechat-ooc", { profileId: "builtin-director" });

    const profile = await resolver.resolveForChat(chat.id, "sidechat-ooc");
    expect(profile.id).toBe("builtin-director");
    expect(profile.name).toBe(SIDECHAT_DIRECTOR_SEED_NAME);
    expect(profile.isBuiltIn).toBe(true);
  });

  test("a kind default of \"builtin-director\" resolves the Director seed", async () => {
    await stores.agentKindSettings.patch("sidechat-ooc", { defaultProfileId: "builtin-director" });
    const chat = await newChat("Director default pin");

    const profile = await resolver.resolveForChat(chat.id, "sidechat-ooc");
    expect(profile.id).toBe("builtin-director");
    expect(profile.isBuiltIn).toBe(true);
  });

  test("a built-in id of ANOTHER kind falls through exactly like a dangling id", async () => {
    // "builtin-director" is a built-in of sidechat-ooc ONLY — foreign to the
    // experience kind. Both it and a dangling custom id resolve identically.
    const kindDefault = await stores.copilotProfiles.create({
      name: "Experience kind default",
      basePrompt: "The row a foreign built-in must fall through to.",
      toolSet: {},
      agentKind: "experience",
    });
    await stores.agentKindSettings.patch("experience", { defaultProfileId: kindDefault.id });
    const foreignChat = await newChat("Foreign builtin chat");
    await stores.chatAgentSettings.patch(foreignChat.id, "experience", { profileId: "builtin-director" });
    const danglingChat = await newChat("Dangling chat");
    await stores.chatAgentSettings.patch(danglingChat.id, "experience", { profileId: "cprof_does_not_exist" });

    const foreign = await resolver.resolveForChat(foreignChat.id, "experience");
    const dangling = await resolver.resolveForChat(danglingChat.id, "experience");
    expect(foreign.id).toBe(kindDefault.id);
    expect(dangling.id).toBe(kindDefault.id);
    expect(foreign).toEqual(dangling);

    // The membership predicate behind it: of the kind, not of any kind.
    expect(isBuiltinCopilotProfileOfKind("builtin-director", "sidechat-ooc")).toBe(true);
    expect(isBuiltinCopilotProfileOfKind("builtin-director", "experience")).toBe(false);
    // … and the any-kind guard the adapter's read-only 400s read.
    expect(isBuiltinCopilotProfileId("builtin-director")).toBe(true);
    expect(builtinCopilotSeeds("sidechat-ooc")).toEqual(SIDECHAT_OOC_BUILTIN_SEEDS);
  });
});

// ─── 5. The id namespace stays disjoint; built-ins stay read-only ────────────

describe("the built-in id namespace (DR-1)", () => {
  test("a user profile can never take a built-in id — ids are store-minted and the create contract is id-less", async () => {
    // Enforcement point 1: the strict create schema carries NO id key — a
    // client cannot even propose one (strict-rejected, never stripped).
    const smuggled = await app.request("/api/copilot/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "builtin-director",
        name: "Smuggled id",
        basePrompt: "p",
        toolSet: {},
      }),
    });
    expect(smuggled.status).toBe(400);
    // Enforcement point 2: the store mints `cprof_…` ids itself.
    const res = await app.request("/api/copilot/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Minted id", basePrompt: "p", toolSet: {} }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProfileWire).id).toMatch(/^cprof/);
  });

  test("every built-in seed id is read-only — update/delete reject \"builtin-director\" with a 400", async () => {
    const update = await app.request("/api/copilot/profiles/builtin-director", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(update.status).toBe(400);
    expect((await update.json()).error.message).toMatch(/read-only/i);

    const del = await app.request("/api/copilot/profiles/builtin-director", { method: "DELETE" });
    expect(del.status).toBe(400);
    expect((await del.json()).error.message).toMatch(/read-only/i);
  });
});
