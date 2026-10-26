// Migration 0113 pin (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 9): Custom
// image-gen profiles — `openai-images` rows WITHOUT a preset — move to the
// `openai-images-custom` slug; OpenAI-preset rows and every other backend
// stay; the profile's endpoint/key/model are untouched, its capability
// snapshot switches to free sizes (other flags kept); learned prompt caps
// on `openai-images` are copied to the Custom slug. Built at journal state
// 0112, seeded with raw SQL, then upgraded through the real createDb path.
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { createDb, type AppDb } from "../src/db-connection.js";
import { buildJournalCutFolder } from "./migration-journal-cut.js";

const PRE_0113_LAST_TAG = "0112_safe_puff_adder";

function closeClient(db: AppDb): void {
  (db as unknown as { $client: Database }).$client.close();
}

const q = (db: AppDb, sql: string) => db.all(sql) as unknown as Array<Record<string, unknown>>;

describe("migration 0113 — Custom image-gen profiles get their own slug", () => {
  test("moves preset-less openai-images rows only, keeping their connection data; copies prompt caps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vt-imagegen-custom-slug-"));
    const dbPath = join(dir, "test.db");

    const preDb = await createDb(dbPath, await buildJournalCutFolder(PRE_0113_LAST_TAG));
    const openAiCaps = JSON.stringify({
      supportsNegativePrompt: false,
      supportsSamplers: false,
      supportsSeed: false,
      sizeSupport: { kind: "vendor-set", sizes: ["1024x1024", "1536x1024", "1024x1536"] },
      noApiKey: false,
      supportsLiveProgress: false,
      localExecution: false,
      supportsImg2img: false,
      supportsInpaint: false,
      paramRanges: {},
    });
    await preDb.run(`INSERT INTO image_gen_profiles (id, name, backend, preset_id, endpoint, api_key, model_id, capabilities_json, created_at, updated_at) VALUES
      ('custom_1', 'closerouter', 'openai-images', NULL, 'https://api.closerouter.dev/v1', NULL, 'google/gemini-3-pro-image-preview', '${openAiCaps}', '2026-10-01', '2026-10-01'),
      ('custom_broken', 'broken caps', 'openai-images', NULL, 'https://img.example.test/v1', NULL, NULL, 'not json', '2026-10-01', '2026-10-01'),
      ('openai_1', 'OpenAI', 'openai-images', 'openai', 'https://api.openai.com/v1', 'sk-own', 'gpt-image-2', '${openAiCaps}', '2026-10-01', '2026-10-01'),
      ('nano_1', 'Nano', 'nanogpt', NULL, 'https://nano-gpt.com/api/v1', NULL, NULL, '{}', '2026-10-01', '2026-10-01')`);
    await preDb.run(`INSERT INTO image_gen_prompt_caps (backend, model_id, max_prompt_chars, learned_at) VALUES
      ('openai-images', 'google/gemini-3-pro-image-preview', 4000, '2026-10-02'),
      ('nanogpt', 'flux-schnell', 1500, '2026-10-02')`);
    closeClient(preDb);

    const db = await createDb(dbPath);
    const profiles = q(db, "SELECT id, backend, preset_id, endpoint, api_key, model_id FROM image_gen_profiles ORDER BY id");
    expect(profiles).toEqual([
      {
        id: "custom_1",
        backend: "openai-images-custom",
        preset_id: null,
        endpoint: "https://api.closerouter.dev/v1",
        api_key: null,
        model_id: "google/gemini-3-pro-image-preview",
      },
      {
        id: "custom_broken",
        backend: "openai-images-custom",
        preset_id: null,
        endpoint: "https://img.example.test/v1",
        api_key: null,
        model_id: null,
      },
      { id: "nano_1", backend: "nanogpt", preset_id: null, endpoint: "https://nano-gpt.com/api/v1", api_key: null, model_id: null },
      {
        id: "openai_1",
        backend: "openai-images",
        preset_id: "openai",
        endpoint: "https://api.openai.com/v1",
        api_key: "sk-own",
        model_id: "gpt-image-2",
      },
    ]);
    const caps = (id: string) =>
      JSON.parse(q(db, `SELECT capabilities_json c FROM image_gen_profiles WHERE id = '${id}'`)[0].c as string) as Record<
        string,
        unknown
      >;
    // Moved row: size support becomes free, every other flag survives.
    expect(caps("custom_1")).toEqual({ ...JSON.parse(openAiCaps), sizeSupport: { kind: "free" } });
    // Unreadable snapshot: restarts from {} + free sizes (the store degrades the rest).
    expect(caps("custom_broken")).toEqual({ sizeSupport: { kind: "free" } });
    // OpenAI-preset row: snapshot untouched.
    expect(caps("openai_1")).toEqual(JSON.parse(openAiCaps));

    expect(q(db, "SELECT backend, model_id, max_prompt_chars FROM image_gen_prompt_caps ORDER BY backend, model_id")).toEqual([
      { backend: "nanogpt", model_id: "flux-schnell", max_prompt_chars: 1500 },
      { backend: "openai-images", model_id: "google/gemini-3-pro-image-preview", max_prompt_chars: 4000 },
      { backend: "openai-images-custom", model_id: "google/gemini-3-pro-image-preview", max_prompt_chars: 4000 },
    ]);
    closeClient(db);
  });
});
