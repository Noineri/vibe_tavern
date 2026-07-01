import { describe, test, expect } from "bun:test";
import { serializeProfileMd } from "@vibe-tavern/db";
import { buildCoauthorTools } from "../src/domain/chat/coauthor-tools.js";

/**
 * Co-Author tools propose edits; they never write. These tests pin the
 * validation contract and the uniform return shape (`target`/`proposed`/
 * `summary`, + `greetingIndex`/`isAdd` for greeting tools) the frontend diff
 * UI and the Apply RPC (CA-7) will depend on.
 */

function sampleProfileMd() {
  return serializeProfileMd({
    profile: {
      name: "Test",
      tags: ["a"],
      creator: null,
      characterVersion: null,
      creatorNotes: null,
      mesExampleMode: "depth",
      mesExampleDepth: 4,
      description: "A test character.",
      scenario: "A scene.",
      mesExample: null,
    },
  });
}

describe("coauthor-tools: edit_profile", () => {
  test("validates via parseProfileMd round-trip and returns the profile target", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_profile.execute(
      { profileMd: sampleProfileMd(), summary: "Tighten personality." },
      {
        messages: [], toolCallId: "t1", abort: () => {},
      } as never,
    )) as never;

    expect(out.target).toBe("profile");
    expect(out.greetingIndex).toBeUndefined();
    expect(out.isAdd).toBeUndefined();
    expect(out.summary).toBe("Tighten personality.");
    // Proposed is canonical-serialized profile.md (round-tripped through the codec).
    expect(out.proposed).toContain("# PERSONALITY");
    expect(out.proposed).toContain("A test character.");
  });

  test("rejects empty profile.md", async () => {
    const tools = buildCoauthorTools();
    await expect(
      tools.edit_profile.execute(
        { profileMd: "   ", summary: "x" },
        { messages: [], toolCallId: "t2", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/empty/);
  });

  test("canonicalizes tolerant input without throwing (parseProfileMd is total)", async () => {
    // The codec never throws — unknown frontmatter / missing sections pass
    // through. So the tool accepts messy input and returns the canonical
    // serialization; the only hard gate is the empty-input guard above.
    const tools = buildCoauthorTools();
    const out = (await tools.edit_profile.execute(
      { profileMd: "just some prose, no frontmatter, no headings", summary: "x" },
      { messages: [], toolCallId: "t2b", abort: () => {} } as never,
    )) as never;
    expect(out.target).toBe("profile");
    expect(typeof out.proposed).toBe("string");
  });
});

describe("coauthor-tools: edit_greeting", () => {
  test("returns the greeting target with the given index", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_greeting.execute(
      { index: 0, content: "The door slams open.", summary: "Stronger opener." },
      { messages: [], toolCallId: "t3", abort: () => {} } as never,
    )) as never;

    expect(out.target).toBe("greeting");
    expect(out.greetingIndex).toBe(0);
    expect(out.isAdd).toBeUndefined();
    expect(out.proposed).toBe("The door slams open.");
    expect(out.summary).toBe("Stronger opener.");
  });

  test("accepts alternate-greeting indices (1+)", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_greeting.execute(
      { index: 2, content: "An alt opener.", summary: "Add tension variant." },
      { messages: [], toolCallId: "t4", abort: () => {} } as never,
    )) as never;
    expect(out.greetingIndex).toBe(2);
  });

  test("rejects empty content", async () => {
    const tools = buildCoauthorTools();
    await expect(
      tools.edit_greeting.execute(
        { index: 0, content: "   ", summary: "x" },
        { messages: [], toolCallId: "t5", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/empty/);
  });
});

describe("coauthor-tools: add_alt_greeting", () => {
  test("returns the greeting target flagged as an add", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.add_alt_greeting.execute(
      { content: "A new alternate opener.", summary: "New scenario entry." },
      { messages: [], toolCallId: "t6", abort: () => {} } as never,
    )) as never;

    expect(out.target).toBe("greeting");
    expect(out.isAdd).toBe(true);
    expect(out.greetingIndex).toBeUndefined();
    expect(out.proposed).toBe("A new alternate opener.");
  });

  test("rejects empty content", async () => {
    const tools = buildCoauthorTools();
    await expect(
      tools.add_alt_greeting.execute(
        { content: "", summary: "x" },
        { messages: [], toolCallId: "t7", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/empty/);
  });
});
