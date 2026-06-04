import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { EventBus } from "@vibe-tavern/domain";
import { FeatureRegistry } from "../src/feature-registry.js";
import type { FeatureModule } from "../src/feature-module.js";

function makeDeps() {
  return { events: new EventBus(), router: new Hono() };
}

describe("FeatureRegistry", () => {
  test("activates and deactivates registered features", () => {
    const registry = new FeatureRegistry();
    const calls: string[] = [];
    const feature: FeatureModule = {
      id: "test-feature",
      activate() {
        calls.push("activate");
      },
      deactivate() {
        calls.push("deactivate");
      },
    };

    registry.register(feature);
    registry.activateAll(makeDeps());

    expect(registry.featureIds).toEqual(["test-feature"]);
    expect(registry.isActive("test-feature")).toBe(true);
    expect(calls).toEqual(["activate"]);

    registry.deactivateAll();

    expect(registry.isActive("test-feature")).toBe(false);
    expect(calls).toEqual(["activate", "deactivate"]);
  });

  test("prevents registering after activation", () => {
    const registry = new FeatureRegistry();
    registry.activateAll(makeDeps());

    expect(() => registry.register({
      id: "late-feature",
      activate() {},
      deactivate() {},
    })).toThrow(/after activation/);
  });
});
