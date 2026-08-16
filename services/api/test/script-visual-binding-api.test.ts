/**
 * Script↔visual binding API (BE-6 backend slice).
 *
 * Full path through the REAL adapter + REAL DB (a temp SQLite via
 * createStoreContainer) — no mocked store. Proves the ScriptAdapter wiring for
 * the script_visuals junction: getScriptVisuals resolves bound ids to full
 * visual rows, bindScriptVisual/unbindScriptVisual delegate to the store, and
 * the silent auto-default (first bound visual) + its reassignment on unbind are
 * observable end-to-end through the adapter. This is the API contract the Wave 2
 * Build UI (BE-6 frontend) and the per-chat dropdown (BE-7) depend on.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";

import { ScriptAdapter } from "../src/api/adapters/script-adapter.js";

async function setup(): Promise<{ stores: StoreContainer; adapter: ScriptAdapter }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-scriptvis-api-"));
  const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const adapter = new ScriptAdapter(stores);
  return { stores, adapter };
}

describe("ScriptAdapter visual bindings (BE-6 backend slice)", () => {
  test("getScriptVisuals lists bound visuals as full rows; bind/unbind delegate to the store; silent auto-default holds", async () => {
    const { stores, adapter } = await setup();
    const script = await adapter.createScript({ name: "S", scopeType: "global", scriptKind: "interactive" });
    const v1 = await stores.experienceResources.createVisual({ name: "VK skin", source: "v1", apiVersion: 1, scopeType: "global" });
    const v2 = await stores.experienceResources.createVisual({ name: "Compact skin", source: "v2", apiVersion: 1, scopeType: "global" });

    // Pre-bind: no visuals bound.
    expect(await adapter.getScriptVisuals(script.id)).toEqual([]);

    // Bind one → it appears as a full row (name resolved, not just an id).
    await adapter.bindScriptVisual(script.id, v1.id);
    let bound = await adapter.getScriptVisuals(script.id);
    expect(bound.map((v) => v.name)).toEqual(["VK skin"]);

    // First bound visual silently becomes the default (Variant 1: no "mark primary" UI).
    let after = await adapter.getScript(script.id);
    expect(after?.defaultVisualId).toBe(v1.id);

    // Bind a second → both present (equal peers); default stays the first.
    await adapter.bindScriptVisual(script.id, v2.id);
    bound = await adapter.getScriptVisuals(script.id);
    expect(bound.map((v) => v.name).sort()).toEqual(["Compact skin", "VK skin"]);
    after = await adapter.getScript(script.id);
    expect(after?.defaultVisualId).toBe(v1.id);

    // Unbind the auto-default → it reassigns to the remaining bound visual.
    await adapter.unbindScriptVisual(script.id, v1.id);
    bound = await adapter.getScriptVisuals(script.id);
    expect(bound.map((v) => v.name)).toEqual(["Compact skin"]);
    after = await adapter.getScript(script.id);
    expect(after?.defaultVisualId).toBe(v2.id);

    // Unbind the last → set empties, default clears.
    await adapter.unbindScriptVisual(script.id, v2.id);
    expect(await adapter.getScriptVisuals(script.id)).toEqual([]);
    after = await adapter.getScript(script.id);
    expect(after?.defaultVisualId).toBeNull();
  });

  test("bindScriptVisual is idempotent (re-binding the same visual does not duplicate)", async () => {
    const { stores, adapter } = await setup();
    const script = await adapter.createScript({ name: "S", scopeType: "global", scriptKind: "interactive" });
    const v1 = await stores.experienceResources.createVisual({ name: "V1", source: "v1", apiVersion: 1, scopeType: "global" });

    await adapter.bindScriptVisual(script.id, v1.id);
    await adapter.bindScriptVisual(script.id, v1.id); // duplicate — ignored

    const bound = await adapter.getScriptVisuals(script.id);
    expect(bound).toHaveLength(1);
    expect(bound[0]!.id).toBe(v1.id);
  });
});
