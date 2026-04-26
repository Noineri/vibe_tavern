import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activateLoreEntries } from "../dist/lore-activation.js";

function makeEntry(overrides = {}) {
  return {
    id: `lore_${Math.random().toString(36).slice(2, 8)}`,
    title: "Test entry",
    content: "Some lore content.",
    keys: ["dragon"],
    secondaryKeys: [],
    logic: "and_any",
    priority: 10,
    enabled: true,
    ...overrides,
  };
}

describe("activateLoreEntries", () => {
  it("activates entry when primary key matches", () => {
    const entries = [makeEntry({ keys: ["dragon"] })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "A dragon appeared.",
    });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, entries[0].id);
  });

  it("does not activate when no key matches", () => {
    const entries = [makeEntry({ keys: ["unicorn"] })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "A dragon appeared.",
    });
    assert.strictEqual(result.length, 0);
  });

  it("does not activate disabled entries", () => {
    const entries = [makeEntry({ keys: ["dragon"], enabled: false })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "A dragon appeared.",
    });
    assert.strictEqual(result.length, 0);
  });

  it("does not activate entries with empty content", () => {
    const entries = [makeEntry({ keys: ["dragon"], content: "  " })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "A dragon appeared.",
    });
    assert.strictEqual(result.length, 0);
  });

  it("sorts by priority descending", () => {
    const low = makeEntry({ keys: ["dragon"], priority: 5, id: "low" });
    const high = makeEntry({ keys: ["dragon"], priority: 20, id: "high" });
    const result = activateLoreEntries([low, high], {
      recentMessagesText: "A dragon.",
    });
    assert.strictEqual(result[0].id, "high");
    assert.strictEqual(result[1].id, "low");
  });

  describe("logic: and_any", () => {
    it("activates when at least one secondary key matches", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["fire", "scales"],
        logic: "and_any",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire breath.",
      });
      assert.strictEqual(result.length, 1);
    });

    it("activates when no secondary keys defined (passthrough)", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: [],
        logic: "and_any",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon appeared.",
      });
      assert.strictEqual(result.length, 1);
    });

    it("does not activate when no secondary key matches", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["ice"],
        logic: "and_any",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire breath.",
      });
      assert.strictEqual(result.length, 0);
    });
  });

  describe("logic: and_all", () => {
    it("activates when ALL secondary keys match", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["fire", "wings"],
        logic: "and_all",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire and wings.",
      });
      assert.strictEqual(result.length, 1);
    });

    it("does not activate when some secondary keys missing", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["fire", "ice"],
        logic: "and_all",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire.",
      });
      assert.strictEqual(result.length, 0);
    });
  });

  describe("logic: not_any", () => {
    it("activates when NO secondary key matches", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["ice"],
        logic: "not_any",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire.",
      });
      assert.strictEqual(result.length, 1);
    });

    it("does not activate when any secondary key matches", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["fire"],
        logic: "not_any",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire.",
      });
      assert.strictEqual(result.length, 0);
    });
  });

  describe("logic: not_all", () => {
    it("activates when not all secondary keys match", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["fire", "ice"],
        logic: "not_all",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A dragon with fire.",
      });
      assert.strictEqual(result.length, 1);
    });

    it("does not activate when all secondary keys match", () => {
      const entries = [makeEntry({
        keys: ["dragon"],
        secondaryKeys: ["fire", "wings"],
        logic: "not_all",
      })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A fire dragon with wings.",
      });
      assert.strictEqual(result.length, 0);
    });
  });

  describe("regex keys", () => {
    it("matches regex keys", () => {
      const entries = [makeEntry({ keys: ["/dragon|drake/i"] })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "A drake appeared.",
      });
      assert.strictEqual(result.length, 1);
    });

    it("does not match invalid regex as regex", () => {
      const entries = [makeEntry({ keys: ["/unclosed"] })];
      const result = activateLoreEntries(entries, {
        recentMessagesText: "Some text.",
      });
      assert.strictEqual(result.length, 0);
    });
  });

  it("key matching is case-insensitive", () => {
    const entries = [makeEntry({ keys: ["Dragon"] })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "A DRAGON appeared.",
    });
    assert.strictEqual(result.length, 1);
  });

  it("handles entries with no primary keys (always activate on content)", () => {
    const entries = [makeEntry({ keys: [], content: "Always on lore." })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "Anything at all.",
    });
    assert.strictEqual(result.length, 1);
  });

  it("returns matched keys in result", () => {
    const entries = [makeEntry({ keys: ["dragon", "fire"] })];
    const result = activateLoreEntries(entries, {
      recentMessagesText: "A fire dragon.",
    });
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].matchedPrimaryKeys, ["dragon", "fire"]);
  });
});
