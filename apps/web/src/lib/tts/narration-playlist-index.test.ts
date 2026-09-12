import { describe, expect, it } from "bun:test";
import { createNarrationPlaylistIndex, type NarrationPlaylistEntry } from "./narration-cache.js";

function entry(overrides: Partial<NarrationPlaylistEntry> = {}): NarrationPlaylistEntry {
  return {
    messageId: "m1",
    variantId: "v1",
    variantIndex: 0,
    snippet: "Hello world",
    cacheKeys: ["v1:abc"],
    narratedAt: 1000,
    ...overrides,
  };
}

describe("narration playlist index (TPE-18a)", () => {
  it("lists nothing for an unknown chat", async () => {
    const index = createNarrationPlaylistIndex();
    expect(await index.list("missing-chat")).toEqual([]);
  });

  it("upsert then list returns the row", async () => {
    const index = createNarrationPlaylistIndex();
    await index.upsert("c1", entry());
    const rows = await index.list("c1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe("m1");
    expect(rows[0]?.cacheKeys).toEqual(["v1:abc"]);
  });

  it("re-narrating the same message overwrites the row (variant switch)", async () => {
    const index = createNarrationPlaylistIndex();
    await index.upsert("c1", entry());
    await index.upsert("c1", entry({ variantId: "v2", variantIndex: 1, snippet: "Second swipe", narratedAt: 2000 }));
    const rows = await index.list("c1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variantId).toBe("v2");
    expect(rows[0]?.snippet).toBe("Second swipe");
  });

  it("lists rows oldest-first across messages", async () => {
    const index = createNarrationPlaylistIndex();
    await index.upsert("c1", entry({ messageId: "m2", narratedAt: 3000 }));
    await index.upsert("c1", entry({ messageId: "m1", narratedAt: 1000 }));
    const rows = await index.list("c1");
    expect(rows.map((row) => row.messageId)).toEqual(["m1", "m2"]);
  });

  it("clear drops one chat and keeps the other", async () => {
    const index = createNarrationPlaylistIndex();
    await index.upsert("c1", entry());
    await index.upsert("c2", entry({ messageId: "m9" }));
    await index.clear("c1");
    expect(await index.list("c1")).toEqual([]);
    expect(await index.list("c2")).toHaveLength(1);
  });

  it("FS-3: remove drops one row and keeps its siblings", async () => {
    const index = createNarrationPlaylistIndex();
    await index.upsert("c1", entry());
    await index.upsert("c1", entry({ messageId: "m2", narratedAt: 2000 }));
    await index.remove("c1", "m1");
    expect((await index.list("c1")).map((row) => row.messageId)).toEqual(["m2"]);
    // Removing a missing row is a silent no-op, never a throw.
    await index.remove("c1", "m1");
    await index.remove("missing-chat", "m1");
    expect((await index.list("c1")).map((row) => row.messageId)).toEqual(["m2"]);
  });
});
