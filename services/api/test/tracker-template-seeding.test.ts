import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  defaultObjectiveState,
  normalizeInsightsConfig,
  normalizeSceneTrackerConfig,
  type ChatId,
} from "@vibe-tavern/domain";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";

const RP_GREETING = "The greeting remains unchanged.";
const originalConsoleWarn = console.warn;
let warnings: unknown[][] = [];

async function removeTestDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    // bun:sqlite can retain the final connection briefly on Windows; the spot runner sweeps its private temp root.
    if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
  }
}

async function createTestEnvironment(extensions: Record<string, unknown> = {}) {
  const rootDir = resolve(tmpdir(), `vt-ct2-${crypto.randomUUID().slice(0, 8)}`);
  const dataDir = resolve(rootDir, "data");
  await mkdir(dataDir, { recursive: true });
  const stores = await createRuntimeStore(dataDir);
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const character = await stores.characters.create({
    name: "Template Probe",
    description: "A probe character.",
    firstMessage: RP_GREETING,
    extensions,
  });

  return {
    runtime,
    stores,
    characterId: character.id,
    cleanup: () => removeTestDirectory(rootDir),
  };
}

async function withTestEnvironment(
  extensions: Record<string, unknown>,
  run: (env: Awaited<ReturnType<typeof createTestEnvironment>>) => Promise<void>,
): Promise<void> {
  const env = await createTestEnvironment(extensions);
  try {
    await run(env);
  } finally {
    await env.cleanup();
  }
}

async function getCreatedChat(
  env: Awaited<ReturnType<typeof createTestEnvironment>>,
  mode?: "rp" | "coauthor",
) {
  const created = await env.runtime.chatLifecycle.createChatForCharacter(env.characterId, mode);
  const chatId = created.activeChat.id as ChatId;
  const chat = await env.stores.chats.getById(chatId);
  if (!chat) throw new Error(`Chat '${chatId}' was not created.`);
  return chat;
}

const TRACKER_TEMPLATE = {
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
      tasks: [{ id: "task_escape", description: "Find the gate", status: "pending" }],
      shortTermGoals: [{ id: "goal_escape", description: "Avoid the guards", status: "pending" }],
    },
  },
} as const;

const TEMPLATE_EXTENSIONS = {
  vibe_tavern: { tracker_template: TRACKER_TEMPLATE },
};

describe("tracker template seeding (CT-2)", () => {
  beforeEach(() => {
    console.warn = originalConsoleWarn;
    warnings = [];
  });

  afterAll(() => {
    console.warn = originalConsoleWarn;
  });

  it("seeds an RP chat with the template scene schema, objectives, and enabled toggles", async () => {
    await withTestEnvironment(TEMPLATE_EXTENSIONS, async (env) => {
      const chat = await getCreatedChat(env, "rp");

      expect(chat.insightsConfig.trackerEnabled).toBe(true);
      expect(chat.insightsConfig.objectiveEnabled).toBe(true);
      expect(normalizeSceneTrackerConfig(chat.insightsConfig.tracker).schema).toEqual({
        location: { $type: "string" },
      });
      expect(chat.insightsObjectiveState.objectiveDescription).toBe("Escape the city");
      expect(chat.insightsObjectiveState.tasks).toEqual([
        { id: "task_escape", description: "Find the gate", status: "pending" },
      ]);
      expect(chat.insightsObjectiveState.shortTermGoals).toEqual([
        { id: "goal_escape", description: "Avoid the guards", status: "pending" },
      ]);

      const messages = await env.stores.messages.getMessages(chat.activeBranchId);
      expect(messages.map((message) => message.content)).toEqual([RP_GREETING]);
    });
  });

  it("leaves a new RP chat at the existing insights defaults without a template", async () => {
    await withTestEnvironment({}, async (env) => {
      const chat = await getCreatedChat(env, "rp");
      expect(chat.insightsConfig).toEqual(normalizeInsightsConfig(undefined));
      expect(chat.insightsObjectiveState).toEqual(defaultObjectiveState());
    });
  });

  it("does not seed a co-author chat from a tracker template", async () => {
    await withTestEnvironment(TEMPLATE_EXTENSIONS, async (env) => {
      const chat = await getCreatedChat(env, "coauthor");
      expect(chat.insightsConfig).toEqual(normalizeInsightsConfig(undefined));
      expect(chat.insightsObjectiveState).toEqual(defaultObjectiveState());
    });
  });

  it("warns and leaves defaults intact for a malformed tracker template", async () => {
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await withTestEnvironment({ vibe_tavern: { tracker_template: { version: 1 } } }, async (env) => {
        const chat = await getCreatedChat(env, "rp");
        expect(chat.insightsConfig).toEqual(normalizeInsightsConfig(undefined));
        expect(chat.insightsObjectiveState).toEqual(defaultObjectiveState());
      });
    } finally {
      console.warn = originalConsoleWarn;
    }

    expect(warnings.some((warning) => warning.join(" ").includes("characterId="))).toBe(true);
  });
});
