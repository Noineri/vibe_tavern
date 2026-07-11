import { describe, expect, it } from "bun:test";
import { buildLoreLayers } from "../src/build-lore-layers.ts";
import { createResolver } from "../src/resolvers/position-resolver.ts";

function lore(position: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `lore_${position}`,
    title: position,
    content: `${position} content`,
    priority: 500,
    position,
    ...overrides,
  };
}

describe("buildLoreLayers", () => {
  it("maps every legacy ST position without changing pipeline-native positions", () => {
    const result = buildLoreLayers({
      lore: [
        lore("before_char"),
        lore("after_char"),
        lore("top_an"),
        lore("bottom_an"),
        lore("before_examples"),
        lore("after_examples"),
        lore("at_depth", { depth: 3 }),
        lore("outlet"),
        lore("before_prompt"),
        lore("in_prompt"),
        lore("in_chat"),
        lore("hidden_system"),
      ],
      resolver: createResolver(undefined),
    });

    const byId = new Map(result.layers.map((layer) => [layer.id, layer]));
    expect(byId.get("lore_lore_before_char")?.position).toBe("in_prompt");
    expect(byId.get("lore_lore_after_char")?.subPosition).toBe(80);
    expect(byId.get("lore_lore_top_an")?.subPosition).toBe(59.9);
    expect(byId.get("lore_lore_bottom_an")?.subPosition).toBe(60.1);
    expect(byId.get("lore_lore_before_examples")?.subPosition).toBe(89.9);
    expect(byId.get("lore_lore_after_examples")?.subPosition).toBe(90.1);
    expect(byId.get("lore_lore_at_depth")?.injectionDepth).toBe(3);
    expect(byId.get("lore_lore_outlet")?.position).toBe("hidden_system");
    expect(byId.get("lore_lore_before_prompt")?.position).toBe("before_prompt");
    expect(byId.get("lore_lore_in_chat")?.position).toBe("in_chat");
    expect(byId.get("lore_lore_hidden_system")?.position).toBe("hidden_system");
  });

  it("drops only world-info positions disabled by the advanced canvas", () => {
    const result = buildLoreLayers({
      lore: [lore("before_char"), lore("top_an")],
      resolver: createResolver({
        id: "preset_1",
        text: "system",
        advancedMode: true,
        promptOrder: [{ identifier: "worldInfoBefore", enabled: false }],
      }),
    });

    expect(result.layers.map((layer) => layer.id)).not.toContain("lore_lore_before_char");
    expect(result.layers.map((layer) => layer.id)).toContain("lore_lore_top_an");
    expect(result.droppedLayers).toEqual([{
      id: "lore_before_char",
      reason: "skipped: worldInfoBefore disabled by prompt order",
    }]);
  });

  it("uses the advanced canvas zone and depth only for mapped world-info positions", () => {
    const result = buildLoreLayers({
      lore: [lore("after_char"), lore("top_an")],
      resolver: createResolver({
        id: "preset_1",
        text: "system",
        advancedMode: true,
        promptOrder: [{ identifier: "worldInfoAfter", enabled: true, zone: "in_chat", depth: 2 }],
      }),
    });

    const byId = new Map(result.layers.map((layer) => [layer.id, layer]));
    expect(byId.get("lore_lore_after_char")?.position).toBe("in_chat");
    expect(byId.get("lore_lore_after_char")?.injectionDepth).toBe(2);
    expect(byId.get("lore_lore_top_an")?.position).toBe("in_prompt");
    expect(byId.get("lore_lore_top_an")?.injectionDepth).toBeUndefined();
  });

  it("preserves depth defaults, insertion order, and empty-content reasons", () => {
    const result = buildLoreLayers({
      lore: [
        lore("at_depth", { id: "depth_default", depth: undefined, sortOrder: 8 }),
        lore("in_prompt", { id: "empty", content: "   " }),
      ],
      resolver: createResolver(undefined),
    });

    expect(result.layers[0]).toMatchObject({
      id: "lore_depth_default",
      injectionDepth: 4,
      insertionOrder: 8,
    });
    expect(result.droppedLayers).toEqual([{ id: "empty", reason: "empty lore content" }]);
  });
});
