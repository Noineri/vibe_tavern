/**
 * mini-app-transfer unit tests: bundle build/parse round-trip, validation
 * reasons, and the import orchestration order (visuals → script → binds with
 * the exported primary bound FIRST so the store's promote-on-first-bind rule
 * restores the default).
 */
import { describe, test, expect, mock } from "bun:test";
import type { ScriptRecord, ExperienceVisualRow } from "../api/types.js";
import {
  buildMiniAppBundle,
  parseMiniAppBundle,
  importMiniAppBundle,
  miniAppBundleFileName,
  type MiniAppImportDeps,
} from "./mini-app-transfer.js";

function makeScript(overrides: Partial<ScriptRecord> = {}): ScriptRecord {
  return {
    id: "scr_1",
    name: "Breakout",
    description: "arcade",
    code: "export function rules() {}",
    enabled: true,
    scriptKind: "interactive",
    creationIntentId: null,
    scopeType: "global",
    sortOrder: 0,
    characterId: null,
    personaId: null,
    chatId: null,
    defaultVisualId: "vis_2",
    copilotProfileId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as ScriptRecord;
}

function makeVisual(id: string, name: string, overrides: Partial<ExperienceVisualRow> = {}): ExperienceVisualRow {
  return {
    id,
    name,
    source: `<div>${name}</div>`,
    sourceHash: "h",
    apiVersion: 2,
    compatibleManifestIds: ["board"],
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as ExperienceVisualRow;
}

describe("buildMiniAppBundle", () => {
  test("captures script fields, bound visuals, and the default index", () => {
    const bundle = buildMiniAppBundle(
      makeScript(),
      [makeVisual("vis_1", "skin-a"), makeVisual("vis_2", "skin-b")],
      () => "2026-01-01T00:00:00.000Z",
    );
    expect(bundle.format).toBe("vt-miniapp");
    expect(bundle.version).toBe(1);
    expect(bundle.script).toEqual({ name: "Breakout", description: "arcade", code: "export function rules() {}", enabled: true });
    expect(bundle.visuals).toHaveLength(2);
    expect(bundle.visuals[1]).toEqual({ name: "skin-b", source: "<div>skin-b</div>", apiVersion: 2, compatibleManifestIds: ["board"] });
    expect(bundle.defaultVisualIndex).toBe(1);
  });

  test("default id not among visuals → null index (no crash)", () => {
    const bundle = buildMiniAppBundle(makeScript({ defaultVisualId: "vis_gone" }), [makeVisual("vis_1", "skin-a")], () => "");
    expect(bundle.defaultVisualIndex).toBeNull();
  });

  test("JSON round-trip parses back identical", () => {
    const bundle = buildMiniAppBundle(makeScript(), [makeVisual("vis_1", "skin-a")], () => "t0");
    const parsed = parseMiniAppBundle(JSON.stringify(bundle));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bundle).toEqual(bundle);
  });
});

describe("parseMiniAppBundle", () => {
  test("bad-json", () => {
    expect(parseMiniAppBundle("not json{")).toEqual({ ok: false, reason: "bad-json" });
  });
  test("bad-format: a ST character card json is not a mini-app bundle", () => {
    expect(parseMiniAppBundle(JSON.stringify({ spec: "chara_card_v2", data: {} }))).toEqual({ ok: false, reason: "bad-format" });
  });
  test("bad-version: future format", () => {
    const bundle = { format: "vt-miniapp", version: 99 };
    expect(parseMiniAppBundle(JSON.stringify(bundle))).toEqual({ ok: false, reason: "bad-version" });
  });
  test("bad-shape: visual missing source", () => {
    const bundle = {
      format: "vt-miniapp",
      version: 1,
      script: { name: "x", description: "", code: "", enabled: true },
      visuals: [{ name: "v", apiVersion: 2, compatibleManifestIds: [] }],
      defaultVisualIndex: 0,
    };
    expect(parseMiniAppBundle(JSON.stringify(bundle))).toEqual({ ok: false, reason: "bad-shape" });
  });
  test("bad-shape: defaultVisualIndex out of range", () => {
    const bundle = {
      format: "vt-miniapp",
      version: 1,
      script: { name: "x", description: "", code: "", enabled: true },
      visuals: [],
      defaultVisualIndex: 0,
    };
    expect(parseMiniAppBundle(JSON.stringify(bundle))).toEqual({ ok: false, reason: "bad-shape" });
  });
  test("missing exportedAt is tolerated (cosmetic)", () => {
    const bundle = {
      format: "vt-miniapp",
      version: 1,
      script: { name: "x", description: "", code: "c", enabled: false },
      visuals: [],
      defaultVisualIndex: null,
    };
    const parsed = parseMiniAppBundle(JSON.stringify(bundle));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bundle.exportedAt).toBe("");
  });
});

describe("miniAppBundleFileName", () => {
  test("sanitizes path-hostile names", () => {
    expect(miniAppBundleFileName("Catch: vol.2?")).toBe("Catch_ vol.2_.vtapp.json");
    expect(miniAppBundleFileName("   ")).toBe("mini-app.vtapp.json");
  });
});

describe("importMiniAppBundle", () => {
  function makeDeps(existingNames: string[] = []): MiniAppImportDeps & {
    createdVisuals: Array<{ name: string; apiVersion: number }>;
    binds: Array<[string, string]>;
    scriptCreated: Array<{ name: string; scopeType: string; enabled: boolean }>;
  } {
    const createdVisuals: Array<{ name: string; apiVersion: number }> = [];
    const binds: Array<[string, string]> = [];
    const scriptCreated: Array<{ name: string; scopeType: string; enabled: boolean }> = [];
    let visualSeq = 0;
    return {
      createdVisuals,
      binds,
      scriptCreated,
      listAllScripts: () => Promise.resolve(existingNames.map((name) => ({ name }))),
      createScript: mock((body: { name: string; scopeType: string; enabled?: boolean }) => {
        scriptCreated.push({ name: body.name, scopeType: body.scopeType, enabled: body.enabled ?? false });
        return Promise.resolve(makeScript({ id: "scr_new", name: body.name }));
      }),
      createExperienceVisual: mock((body: { name: string; apiVersion: number }) => {
        visualSeq += 1;
        createdVisuals.push({ name: body.name, apiVersion: body.apiVersion });
        return Promise.resolve(makeVisual(`vis_new_${visualSeq}`, body.name));
      }),
      bindScriptVisual: mock((scriptId: string, visualId: string) => {
        binds.push([scriptId, visualId]);
        return Promise.resolve();
      }),
    };
  }

  test("creates visuals before the script, binds default FIRST then the rest", async () => {
    const deps = makeDeps();
    const bundle = parseMiniAppBundle(
      JSON.stringify({
        format: "vt-miniapp",
        version: 1,
        script: { name: "Tetris", description: "", code: "code", enabled: true },
        visuals: [
          { name: "skin-a", source: "<a/>", apiVersion: 2, compatibleManifestIds: [] },
          { name: "skin-default", source: "<d/>", apiVersion: 2, compatibleManifestIds: [] },
        ],
        defaultVisualIndex: 1,
      }),
    );
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;

    const result = await importMiniAppBundle(bundle.bundle, { scopeType: "global" }, " (import)", deps);

    expect(deps.createdVisuals.map((v) => v.name)).toEqual(["skin-a", "skin-default"]);
    // Default (index 1 → vis_new_2) bound first, then index 0.
    expect(deps.binds).toEqual([
      ["scr_new", "vis_new_2"],
      ["scr_new", "vis_new_1"],
    ]);
    expect(result.script.id).toBe("scr_new");
    expect(result.visuals).toHaveLength(2);
  });

  test("name collision appends the suffix; no collision keeps the name", async () => {
    const collide = makeDeps(["Tetris"]);
    const bundle = {
      format: "vt-miniapp" as const,
      version: 1 as const,
      exportedAt: "",
      script: { name: "Tetris", description: "", code: "c", enabled: true },
      visuals: [],
      defaultVisualIndex: null,
    };
    await importMiniAppBundle(bundle, { scopeType: "global" }, " (импорт)", collide);
    expect(collide.scriptCreated[0]?.name).toBe("Tetris (импорт)");

    const fresh = makeDeps(["Other"]);
    await importMiniAppBundle(bundle, { scopeType: "global" }, " (импорт)", fresh);
    expect(fresh.scriptCreated[0]?.name).toBe("Tetris");
  });

  test("empty visuals: script only, no binds", async () => {
    const deps = makeDeps();
    const bundle = {
      format: "vt-miniapp" as const,
      version: 1 as const,
      exportedAt: "",
      script: { name: "Bare", description: "", code: "", enabled: false },
      visuals: [],
      defaultVisualIndex: null,
    };
    await importMiniAppBundle(bundle, { scopeType: "global" }, " (import)", deps);
    expect(deps.binds).toEqual([]);
    expect(deps.createdVisuals).toEqual([]);
    expect(deps.scriptCreated[0]?.scopeType).toBe("global");
    expect(deps.scriptCreated[0]?.enabled).toBe(false);
  });
});
