import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";
import { createStoreContainer } from "@vibe-tavern/db";
import { normalizeInsightsConfig, normalizeSceneTrackerConfig, type ChatMode } from "@vibe-tavern/domain";
import { CharacterAdapter } from "../src/api/adapters/character-adapter.js";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import type { AssetService } from "../src/domain/asset/asset-service.js";
import type { ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SceneTrackerService } from "../src/domain/insights/tracker-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import { createCharacterRoutes } from "../src/api/routes/character.js";
import { createInsightsRoutes } from "../src/api/routes/insights.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const TEMPLATE = {
  version: 1,
  scene: {
    enabled: true,
    config: {
      schema: { location: { $type: "string" } },
      contextWindow: 12,
    },
  },
  objective: {
    enabled: true,
    state: {
      objectiveDescription: "Escape the city",
      shortTermGoals: [{ id: "goal_escape", description: "Reach the gate", status: "pending" }],
    },
  },
};

async function createEnvironment(mode: ChatMode = "rp") {
  const rootDir = await mkdtemp(join(tmpdir(), "vt-ct3-"));
  const stores = await createStoreContainer(":memory:", rootDir);
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const character = await stores.characters.create({
    name: "Template Probe",
    extensions: { foreign: { retained: true } },
  });
  const created = await runtime.chatLifecycle.createChatForCharacter(character.id, mode);
  const chatId = created.activeChat.id;
  const characterAdapter = new CharacterAdapter(
    runtime,
    stores,
    {} as unknown as AssetService,
    {} as unknown as ProviderProfileService,
  );
  const insightsAdapter = new InsightsAdapter(
    stores,
    runtime,
    {} as unknown as ObjectiveService,
    {} as unknown as SceneTrackerService,
  );
  const app = new Hono();
  app.onError((error) => {
    if (isDomainError(error)) {
      return new Response(JSON.stringify(domainErrorToJson(error)), {
        status: httpStatusForDomainError(error),
        headers: { "content-type": "application/json" },
      });
    }
    throw error;
  });
  app.route("/", createCharacterRoutes(characterAdapter));
  app.route("/", createInsightsRoutes(insightsAdapter));

  return {
    app,
    stores,
    characterId: character.id,
    chatId,
    cleanup: async () => {
      stores.db.$client.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function withEnvironment(
  run: (environment: Awaited<ReturnType<typeof createEnvironment>>) => Promise<void>,
  mode?: ChatMode,
): Promise<void> {
  const environment = await createEnvironment(mode);
  try {
    await run(environment);
  } finally {
    await environment.cleanup();
  }
}

function json(body: unknown): RequestInit {
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("tracker template character routes (CT-3)", () => {
  it("GET returns null when the active character version has no template", async () => {
    await withEnvironment(async ({ app, characterId }) => {
      const response = await app.request(`/api/characters/${characterId}/tracker-template`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ template: null });
    });
  });

  it("PUT then GET round trips a normalized template and preserves foreign extensions", async () => {
    await withEnvironment(async ({ app, characterId, stores }) => {
      const put = await app.request(`/api/characters/${characterId}/tracker-template`, {
        method: "PUT",
        ...json({ template: TEMPLATE }),
      });
      expect(put.status).toBe(200);
      const get = await app.request(`/api/characters/${characterId}/tracker-template`);
      expect(get.status).toBe(200);
      expect((await get.json()).template).toMatchObject(TEMPLATE);
      const character = await stores.characters.getById(characterId);
      expect(character?.extensions.foreign).toEqual({ retained: true });
    });
  });

  it("rejects a template that normalizes to null with invalid_tracker_template", async () => {
    await withEnvironment(async ({ app, characterId }) => {
      const response = await app.request(`/api/characters/${characterId}/tracker-template`, {
        method: "PUT",
        ...json({ template: { version: 1, scene: null, objective: null } }),
      });
      expect(response.status).toBe(422);
      expect((await response.json()).error.details.code).toBe("invalid_tracker_template");
    });
  });

  it("DELETE clears the template without removing foreign extensions", async () => {
    await withEnvironment(async ({ app, characterId, stores }) => {
      await app.request(`/api/characters/${characterId}/tracker-template`, {
        method: "PUT",
        ...json({ template: TEMPLATE }),
      });
      const deleted = await app.request(`/api/characters/${characterId}/tracker-template`, { method: "DELETE" });
      expect(deleted.status).toBe(204);
      const get = await app.request(`/api/characters/${characterId}/tracker-template`);
      expect(await get.json()).toEqual({ template: null });
      const character = await stores.characters.getById(characterId);
      expect(character?.extensions).toEqual({ foreign: { retained: true } });
    });
  });

  it("GET follows the template stored in the activated character version", async () => {
    await withEnvironment(async ({ app, characterId, stores }) => {
      await stores.versions.ensureBaseVersion(characterId);
      const versions = await (await app.request(`/api/characters/${characterId}/versions`)).json();
      const baseVersion = versions.find((version: { isActive: boolean }) => version.isActive);
      const firstTemplate = { ...TEMPLATE, scene: { ...TEMPLATE.scene, config: { ...TEMPLATE.scene.config, schema: { weather: { $type: "string" } } } } };
      await app.request(`/api/characters/${characterId}/tracker-template`, { method: "PUT", ...json({ template: firstTemplate }) });
      const created = await app.request(`/api/characters/${characterId}/versions`, { method: "POST", ...json({ title: "Second" }) });
      expect(created.status).toBe(201);
      const secondTemplate = { ...TEMPLATE, scene: { ...TEMPLATE.scene, config: { ...TEMPLATE.scene.config, schema: { danger: { $type: "number" } } } } };
      await app.request(`/api/characters/${characterId}/tracker-template`, { method: "PUT", ...json({ template: secondTemplate }) });
      const activated = await app.request(`/api/characters/${characterId}/versions/${baseVersion.id}/activate`, { method: "POST" });
      expect(activated.status).toBe(200);
      const get = await app.request(`/api/characters/${characterId}/tracker-template`);
      expect((await get.json()).template.scene.config.schema).toEqual({ weather: { $type: "string" } });
    });
  });
});

describe("tracker template insight routes (CT-3)", () => {
  it("apply returns no_tracker_template when the character has none", async () => {
    await withEnvironment(async ({ app, chatId }) => {
      const response = await app.request(`/api/chats/${chatId}/insights/apply-character-template`, { method: "POST" });
      expect(response.status).toBe(404);
      expect((await response.json()).error.details.code).toBe("no_tracker_template");
    });
  });

  it("checks non-RP mode before reading the character template", async () => {
    await withEnvironment(async ({ app, chatId }) => {
      const response = await app.request(`/api/chats/${chatId}/insights/apply-character-template`, { method: "POST" });
      expect(response.status).toBe(422);
      expect((await response.json()).error.details.code).toBe("not_an_rp_chat");
    }, "coauthor");
  });

  it("apply replaces scene/goals while preserving dice fields and returns the insights patch shape", async () => {
    await withEnvironment(async ({ app, characterId, chatId, stores }) => {
      await app.request(`/api/characters/${characterId}/tracker-template`, { method: "PUT", ...json({ template: TEMPLATE }) });
      const chat = await stores.chats.getById(chatId);
      if (!chat) throw new Error("Expected test chat");
      await stores.chats.replaceTrackerSetup(
        chatId,
        normalizeInsightsConfig({
          ...chat.insightsConfig,
          diceEnabled: true,
          diceMode: "immersive",
          diceScriptIds: ["dice_1"],
          diceActorBindings: { dice_1: ["character"] },
          trackerEnabled: false,
          tracker: { schema: { old: { $type: "boolean" } } },
        }),
        { ...chat.insightsObjectiveState, objectiveDescription: "Old objective" },
      );
      const response = await app.request(`/api/chats/${chatId}/insights/apply-character-template`, { method: "POST" });
      expect(response.status).toBe(200);
      expect((await response.json()).activeChat).toBeTruthy();
      const updated = await stores.chats.getById(chatId);
      expect(normalizeSceneTrackerConfig(updated?.insightsConfig.tracker).schema).toEqual({ location: { $type: "string" } });
      expect(updated?.insightsObjectiveState.shortTermGoals).toEqual([
        { id: "goal_escape", description: "Reach the gate", status: "pending" },
      ]);
      expect(updated?.insightsConfig).toMatchObject({
        diceEnabled: true,
        diceMode: "immersive",
        diceScriptIds: ["dice_1"],
        diceActorBindings: { dice_1: ["character"] },
      });
    });
  });

  it("save-as rejects an empty setup with empty_tracker_setup", async () => {
    await withEnvironment(async ({ app, chatId }) => {
      const response = await app.request(`/api/chats/${chatId}/insights/save-as-character-template`, { method: "POST" });
      expect(response.status).toBe(422);
      expect((await response.json()).error.details.code).toBe("empty_tracker_setup");
    });
  });

  it("save-as stores the stripped template returned by character GET", async () => {
    await withEnvironment(async ({ app, characterId, chatId, stores }) => {
      const chat = await stores.chats.getById(chatId);
      if (!chat) throw new Error("Expected test chat");
      await stores.chats.replaceTrackerSetup(
        chatId,
        normalizeInsightsConfig({
          ...chat.insightsConfig,
          trackerEnabled: true,
          objectiveEnabled: true,
          tracker: {
            schema: { place: { $type: "string" } },
            providerProfileId: "scene_profile",
            model: "scene_model",
            useChatModel: false,
            revision: 9,
          },
        }),
        {
          ...chat.insightsObjectiveState,
          objectiveDescription: "Find the exit",
          useChatModel: false,
          providerProfileId: "objective_profile",
          model: "objective_model",
          autoCheckEventCount: 4,
        },
      );
      const saved = await app.request(`/api/chats/${chatId}/insights/save-as-character-template`, { method: "POST" });
      expect(saved.status).toBe(200);
      const get = await app.request(`/api/characters/${characterId}/tracker-template`);
      const template = (await get.json()).template;
      expect(template.scene.config).not.toHaveProperty("providerProfileId");
      expect(template.scene.config).not.toHaveProperty("model");
      expect(template.scene.config).not.toHaveProperty("useChatModel");
      expect(template.scene.config).not.toHaveProperty("revision");
      expect(template.scene.config).not.toHaveProperty("schemaHash");
      expect(template.objective.state).not.toHaveProperty("useChatModel");
      expect(template.objective.state).not.toHaveProperty("providerProfileId");
      expect(template.objective.state).not.toHaveProperty("model");
      expect(template.objective.state).not.toHaveProperty("autoCheckEventCount");
    });
  });
});
