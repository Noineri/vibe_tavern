/**
 * Round-trip pin for the tracker template through VT card export/import (CT-6).
 *
 * The template rides `extensions.vibe_tavern.tracker_template` (domain helpers
 * `readTrackerTemplate` / `withTrackerTemplate` / `normalizeTrackerTemplate`).
 * Waves 1-2 (seeding, API, UI) are complete; this suite proves the VT→VT
 * export/import path carries the template unaided and foreign cards are
 * unaffected:
 *
 *   1. create with template → exportCharacter → importJson as a NEW character
 *      → `readTrackerTemplate` deep-equals the original normalized template.
 *   2. foreign extension keys survive the same export→import round trip.
 *   3. an ST card without the key imports with `extensions` byte-identical to
 *      today (characterization — the literal below IS the current value).
 *   4. a malformed `vibe_tavern.tracker_template` imports fine,
 *      `readTrackerTemplate` returns null, and the CT-2 seeding path logs a
 *      warning instead of throwing.
 *   5. `CharacterRuntime.duplicate` carries the template to the copy.
 *
 * Full-stack harness (real in-memory stores via `createRuntimeStore` +
 * `SessionRuntime`), mirroring tracker-template-seeding.test.ts (CT-2) — no
 * parallel harness. If any case proves the key is lost on some path, the fix
 * belongs to that path (minimal key preservation) and goes in the plan log.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  defaultObjectiveState,
  normalizeInsightsConfig,
  normalizeTrackerTemplate,
  readTrackerTemplate,
  withTrackerTemplate,
  type CharacterId,
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

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

async function createTestEnvironment() {
  const rootDir = resolve(tmpdir(), `vt-ct6-${crypto.randomUUID().slice(0, 8)}`);
  const dataDir = resolve(rootDir, "data");
  await mkdir(dataDir, { recursive: true });
  const stores = await createRuntimeStore(dataDir);
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  return {
    runtime,
    stores,
    cleanup: () => removeTestDirectory(rootDir),
  };
}

async function withTestEnvironment(
  run: (env: TestEnvironment) => Promise<void>,
): Promise<void> {
  const env = await createTestEnvironment();
  try {
    await run(env);
  } finally {
    await env.cleanup();
  }
}

const TRACKER_TEMPLATE_INPUT = {
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

/** Rename an exported card so re-import creates a NEW character (the import id
 *  is deterministic over the card JSON — importing the identical JSON would hit
 *  the existing-character update path instead of the create path). */
function renameExportedCard(exported: Record<string, unknown>, name: string): string {
  const renamed: Record<string, unknown> = { ...exported, name };
  const data = exported.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    renamed.data = { ...(data as Record<string, unknown>), name };
  }
  return JSON.stringify(renamed);
}

describe("tracker template card round trip (CT-6)", () => {
  beforeEach(() => {
    console.warn = originalConsoleWarn;
    warnings = [];
  });

  afterAll(() => {
    console.warn = originalConsoleWarn;
  });

  it("carries the template through export → import as a new character", async () => {
    await withTestEnvironment(async (env) => {
      const template = normalizeTrackerTemplate(TRACKER_TEMPLATE_INPUT);
      expect(template).not.toBeNull();
      const source = await env.stores.characters.create({
        name: "Template Source",
        description: "A source character.",
        firstMessage: RP_GREETING,
        extensions: withTrackerTemplate({}, template),
      });

      const exported = await env.runtime.exportCharacter(source.id);
      const imported = await env.runtime.importJson({
        fileName: "template-copy.json",
        jsonText: renameExportedCard(exported, "Template Copy"),
      });
      expect(imported.characterId).toBeDefined();

      const copy = await env.stores.characters.getById(imported.characterId as CharacterId);
      expect(copy).not.toBeNull();
      expect(readTrackerTemplate(copy?.extensions ?? {})).toEqual(template);
    });
  });

  it("keeps foreign extension keys through export → import", async () => {
    await withTestEnvironment(async (env) => {
      const template = normalizeTrackerTemplate(TRACKER_TEMPLATE_INPUT);
      const extensions = withTrackerTemplate(
        { foreign: { retained: true }, depth_prompt: { depth: 4, prompt: "Foreign extension" } },
        template,
      );
      // Sibling key inside the vibe_tavern fence must survive too.
      (extensions.vibe_tavern as Record<string, unknown>).other = { retained: true };
      const source = await env.stores.characters.create({
        name: "Foreign Source",
        description: "A source character.",
        firstMessage: RP_GREETING,
        extensions,
      });

      const exported = await env.runtime.exportCharacter(source.id);
      const imported = await env.runtime.importJson({
        fileName: "foreign-copy.json",
        jsonText: renameExportedCard(exported, "Foreign Copy"),
      });

      const copy = await env.stores.characters.getById(imported.characterId as CharacterId);
      expect(copy?.extensions).toEqual(extensions);
      expect(readTrackerTemplate(copy?.extensions ?? {})).toEqual(template);
    });
  });

  it("imports an ST card without the key with extensions byte-identical to today", async () => {
    await withTestEnvironment(async (env) => {
      const stExtensions = {
        talkativeness: "0.5",
        depth_prompt: { depth: 4, prompt: "Foreign extension" },
      };
      const imported = await env.runtime.importJson({
        fileName: "st-card.json",
        jsonText: JSON.stringify({
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name: "ST Stranger",
            description: "A foreign card.",
            first_mes: RP_GREETING,
            scenario: "A tavern.",
            extensions: stExtensions,
          },
        }),
      });
      expect(imported.characterId).toBeDefined();

      const character = await env.stores.characters.getById(imported.characterId as CharacterId);
      expect(character).not.toBeNull();
      // Characterization of the current codec: no vibe_tavern fence is added,
      // and the ST extension keys land verbatim.
      expect(character?.extensions).toEqual(stExtensions);
      expect(readTrackerTemplate(character?.extensions ?? {})).toBeNull();
    });
  });

  it("imports a malformed template fine and warns (not throws) on the seeding path", async () => {
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await withTestEnvironment(async (env) => {
        const imported = await env.runtime.importJson({
          fileName: "malformed-card.json",
          jsonText: JSON.stringify({
            spec: "chara_card_v2",
            spec_version: "2.0",
            data: {
              name: "Malformed Host",
              description: "A card with a broken template.",
              first_mes: RP_GREETING,
              extensions: { vibe_tavern: { tracker_template: { version: 1 } } },
            },
          }),
        });
        expect(imported.characterId).toBeDefined();

        const character = await env.stores.characters.getById(imported.characterId as CharacterId);
        expect(character).not.toBeNull();
        expect(readTrackerTemplate(character?.extensions ?? {})).toBeNull();

        // CT-2 seeding path: malformed template warns and leaves defaults intact.
        const chat = await env.runtime.chatLifecycle.createChatForCharacter(
          (imported.characterId as CharacterId).toString(),
          "rp",
        );
        const created = await env.stores.chats.getById(chat.activeChat.id as ChatId);
        expect(created?.insightsConfig).toEqual(normalizeInsightsConfig(undefined));
        expect(created?.insightsObjectiveState).toEqual(defaultObjectiveState());
      });
    } finally {
      console.warn = originalConsoleWarn;
    }

    expect(warnings.some((warning) => warning.join(" ").includes("characterId="))).toBe(true);
  });

  it("carries the template when duplicating a character", async () => {
    await withTestEnvironment(async (env) => {
      const template = normalizeTrackerTemplate(TRACKER_TEMPLATE_INPUT);
      const source = await env.stores.characters.create({
        name: "Template Original",
        description: "A source character.",
        firstMessage: RP_GREETING,
        extensions: withTrackerTemplate({ foreign: { retained: true } }, template),
      });

      const duplicated = await env.runtime.character.duplicate(source.id as CharacterId);
      const chat = await env.stores.chats.getById(duplicated.activeChatId);
      expect(chat).not.toBeNull();
      const copy = await env.stores.characters.getById(chat?.characterId as CharacterId);
      expect(copy).not.toBeNull();
      expect(readTrackerTemplate(copy?.extensions ?? {})).toEqual(template);
      expect(copy?.extensions.foreign).toEqual({ retained: true });
    });
  });
});
