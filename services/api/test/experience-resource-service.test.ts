/**
 * Experience resource service tests
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * Full-path through the REAL VM discovery and the REAL DB (a temp SQLite via
 * createStoreContainer) — no mocked store, no narrowed pure-function substitute.
 * The resource service is the only interactive module under test here; the
 * lifecycle (experience-service) and replay services have their own files.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { EXPERIENCE_CAPABILITY, EXPERIENCE_CONTEXT_MODE } from "@vibe-tavern/domain";

import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";

// ─── A minimal valid experience source (registers cleanly, no capabilities) ─

const VALID_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "res-test", name: "Resource Test" },
  capabilities: [],
  create() { return { n: 0 }; },
  project(c) { return c.state; },
  actions() { return [{ type: "inc" }]; },
  reduce(c) { return { state: { n: c.state.n + 1 }, status: "active", events: [] }; },
});
`;

const SYNTAX_ERROR_SOURCE = `context.experience.register({ apiVersion: 1, manifest: { id: "x", name: "X" }, capabilities: [], create() { return {}; }, project(c) { return c.state; }, actions() { return []; }, reduce(c) { return { state: c.state, status: "active", events: [] }; } }); /* unterminated`;

// ─── Setup ───────────────────────────────────────────────────────────────────

let stores: StoreContainer;
let service: ExperienceResourceService;
let chatId: string;
let scriptId: string;

beforeEach(async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xresource-svc-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  service = new ExperienceResourceService(stores);

  const character = await stores.characters.create({ name: "Hero" } as never);
  chatId = (await stores.chats.createChat({ characterId: character.id, title: "Test" })).id;
  const script = await stores.scripts.create({ name: "TTT Rules", scriptKind: "interactive", code: VALID_SOURCE });
  scriptId = script.id;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExperienceResourceService — rules validation (real VM)", () => {
  test("validates a clean source and returns the discovered definition + source hash", () => {
    const r = service.validateRulesSource(VALID_SOURCE, "TTT");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.manifest.id).toBe("res-test");
    expect(r.definition.manifest.name).toBe("Resource Test");
    expect(r.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("surfaces a discovery error (kind + message) for broken source", () => {
    const r = service.validateRulesSource(SYNTAX_ERROR_SOURCE, "Bad");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("syntax");
    expect(r.error.message.length).toBeGreaterThan(0);
  });
});

describe("ExperienceResourceService — visual CRUD + source hash", () => {
  test("create computes a hash; a source edit re-hashes; empty source is ALLOWED (draft placeholder)", async () => {
    const created = await service.createVisual({ name: "Board", source: "<html>v1</html>", apiVersion: 1 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const h1 = created.data.sourceHash;

    const edited = await service.updateVisual(created.data.id, { source: "<html>v2</html>" });
    expect(edited.ok && edited.data.sourceHash).not.toBe(h1);

    // 2026-08-17: a visual draft starts empty and must be saveable as-is —
    // the create path no longer rejects blank/whitespace source.
    const empty = await service.createVisual({ name: "Empty", source: "   ", apiVersion: 1 });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.data.source).toBe("   ");
  });

  test("update/delete on a missing visual return a typed 404", async () => {
    const update = await service.updateVisual("xv_missing", { name: "x" });
    expect(update.ok).toBe(false);
    if (update.ok) return;
    expect(update.error.code).toBe("visual_not_found");

    const del = await service.deleteVisual("xv_missing");
    expect(del.ok).toBe(false);
    if (del.ok) return;
    expect(del.error.code).toBe("visual_not_found");
  });

  test("cloneVisualFromStarter creates an independent editable copy", async () => {
    const clone = await service.cloneVisualFromStarter({
      name: "My Board",
      source: "<html>starter</html>",
      apiVersion: 1,
    });
    expect(clone.ok).toBe(true);
    if (!clone.ok) return;
    expect(clone.data.name).toBe("My Board");
    // Editing the clone does not affect anything else (independent row).
    const edited = await service.updateVisual(clone.data.id, { source: "<html>edited</html>" });
    expect(edited.ok && edited.data.sourceHash).not.toBe(clone.data.sourceHash);
  });
});

describe("ExperienceResourceService — visual/rules compatibility", () => {
  test("empty compatible list = universal; otherwise manifest must be listed", () => {
    expect(service.checkVisualCompatibility({ compatibleManifestIds: [] }, "ttt")).toBe(true);
    expect(service.checkVisualCompatibility({ compatibleManifestIds: ["ttt", "checkers"] }, "ttt")).toBe(true);
    expect(service.checkVisualCompatibility({ compatibleManifestIds: ["checkers"] }, "ttt")).toBe(false);
  });
});

describe("ExperienceResourceService — resolveEffectiveSetup (the lifecycle entry point)", () => {
  test("404 when the chat does not exist", async () => {
    const r = await service.resolveEffectiveSetup("chat_nope");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("chat_not_found");
  });

  test("a fresh (disabled) chat resolves to enabled:false with null sources — not an error", async () => {
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.enabled).toBe(false);
    expect(r.data.rules).toBeNull();
    expect(r.data.visual).toBeNull();
  });

  test("enabled with NO rules script is a not_enabled conflict", async () => {
    await service.updateConfig(chatId, { enabled: true });
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("not_enabled");
  });

  test("enabled with a valid interactive script resolves the discovered rules", async () => {
    await service.updateConfig(chatId, { enabled: true, scriptId });
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.enabled).toBe(true);
    expect(r.data.rules?.definition.manifest.id).toBe("res-test");
    expect(r.data.rules?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.data.rules?.revision).toBeGreaterThan(0);
    expect(r.data.rules?.code).toBe(VALID_SOURCE);
  });

  test("enabled with a non-interactive script is a validation error", async () => {
    const promptScript = await stores.scripts.create({ name: "A Prompt Script", scriptKind: "prompt", code: "" });
    await service.updateConfig(chatId, { enabled: true, scriptId: promptScript.id });
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("validation_error");
  });

  test("an incompatible visual is rejected with the manifest + compatible list", async () => {
    const visual = await service.createVisual({
      name: "Grid",
      source: "<html></html>",
      apiVersion: 1,
      compatibleManifestIds: ["some-other-game"],
    });
    expect(visual.ok).toBe(true);
    if (!visual.ok) return;
    await service.updateConfig(chatId, { enabled: true, scriptId, visualId: visual.data.id });
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("incompatible_visual");
    expect(r.error.manifestId).toBe("res-test");
    expect(r.error.compatible).toEqual(["some-other-game"]);
  });

  test("a compatible visual resolves alongside the rules", async () => {
    const visual = await service.createVisual({
      name: "Good Grid",
      source: "<html></html>",
      apiVersion: 1,
      compatibleManifestIds: ["res-test"],
    });
    expect(visual.ok).toBe(true);
    if (!visual.ok) return;
    await service.updateConfig(chatId, { enabled: true, scriptId, visualId: visual.data.id });
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.visual?.visualId).toBe(visual.data.id);
    expect(r.data.visual?.apiVersion).toBe(1);
  });

  test("a grant not declared by the rules is rejected (declared⊇granted)", async () => {
    await service.updateConfig(chatId, {
      enabled: true,
      scriptId,
      capabilityGrants: [EXPERIENCE_CAPABILITY.deterministicRandom], // rules declares none
    });
    const r = await service.resolveEffectiveSetup(chatId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("capability_denied");
    expect(r.error.needs).toContain(EXPERIENCE_CAPABILITY.deterministicRandom);
  });
});

describe("ExperienceResourceService — chat configuration", () => {
  test("getConfig is getOrCreate (stable id across calls)", async () => {
    const a = await service.getConfig(chatId);
    const b = await service.getConfig(chatId);
    expect(b.id).toBe(a.id);
    expect(a.enabled).toBe(false);
  });

  test("updateConfig enables, binds the script, and sets grants + context mode", async () => {
    const updated = await service.updateConfig(chatId, {
      enabled: true,
      scriptId,
      capabilityGrants: [],
      contextMode: EXPERIENCE_CONTEXT_MODE.currentBranch,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.enabled).toBe(true);
    expect(updated.data.scriptId).toBe(scriptId);
    expect(updated.data.contextMode).toBe(EXPERIENCE_CONTEXT_MODE.currentBranch);
  });

  test("updateConfig rejects unknown capability values", async () => {
    const r = await service.updateConfig(chatId, {
      capabilityGrants: ["not_a_real_capability" as never],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("validation_error");
  });
});

describe("ExperienceResourceService — prompt overrides", () => {
  test("global + per-character layers; effective prefers character", async () => {
    const character = await stores.characters.create({ name: "C2" } as never);
    await service.setGlobalOverride("be brief");
    await service.setCharacterOverride(character.id, "be vivid");
    expect((await service.getEffectiveOverride(null))?.content).toBe("be brief");
    expect((await service.getEffectiveOverride(character.id))?.content).toBe("be vivid");
    await service.deleteCharacterOverride(character.id);
    expect(await service.getEffectiveOverride(character.id)).not.toBeNull();
    expect((await service.getEffectiveOverride(character.id))?.content).toBe("be brief");
  });
});
