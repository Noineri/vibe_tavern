import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  attachmentSchema,
  cloneChatSchema,
  createChatSchema,
  editMessageSchema,
  renameBranchSchema,
  renameChatSchema,
  sendMessageSchema,
  setGreetingIndexSchema,
} from "../src/schemas/chat-schema.js";

/**
 * Characterization tests for the chat schemas.
 *
 * These pin the load-bearing constraints of each schema so a silent change
 * (a dropped `.max(5)`, a `.positive()` removal, an enum-member flip, a
 * `sizeBytes` boundary shift) is caught here rather than in a broken request
 * on either side of the frontend↔backend contract.
 *
 * Pattern (mirrors `character-schema.test.ts`):
 *   - `safeParse` everywhere — a failure yields `{ success: false, error }`
 *     instead of throwing.
 *   - Inline factories return a fresh valid baseline; each `it` mutates one
 *     field to isolate the constraint under test.
 *   - Numeric boundary cases (sizeBytes, greetingIndex, max-5 attachments)
 *     assert BOTH sides of the boundary.
 *   - Note the deliberate asymmetries: `name`/`mimeType` have NO `.min(1)`
 *     (empty string is valid), unlike `id`/`assetId` which are `.min(1)`.
 *     These are pinned so a future "cleanup" that adds/removes `.min(1)` is
 *     caught.
 */

// --- helpers ----------------------------------------------------------------

/**
 * Asserts a `safeParse` result is a rejection and (defensively) that it carries
 * at least one issue. Generic over the parsed type so it works for any schema.
 */
function expectReject(result: z.SafeParseReturnType<unknown, unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

/** Build a string of exactly `n` characters ("a" repeated). */
function repeat(n: number): string {
  return "a".repeat(n);
}

// --- factories --------------------------------------------------------------

/** A fully-valid attachment baseline; mutate copies to isolate a constraint. */
function validAttachment() {
  return {
    id: "att-1",
    assetId: "asset-1",
    type: "image" as const,
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: 1024,
  };
}

/** Build `count` distinct valid attachments (unique ids). */
function validAttachments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...validAttachment(),
    id: `att-${i}`,
    assetId: `asset-${i}`,
  }));
}

// --- createChatSchema -------------------------------------------------------

describe("createChatSchema", () => {
  it("accepts a payload with the required characterId", () => {
    expect(createChatSchema.safeParse({ characterId: "c1" }).success).toBe(true);
  });

  it("rejects a payload missing characterId", () => {
    expectReject(createChatSchema.safeParse({}));
  });

  it("rejects a non-string characterId", () => {
    expectReject(createChatSchema.safeParse({ characterId: 123 }));
  });

  it("rejects a null characterId (not nullable)", () => {
    expectReject(createChatSchema.safeParse({ characterId: null }));
  });
});

// --- cloneChatSchema --------------------------------------------------------

describe("cloneChatSchema", () => {
  it("accepts an empty object", () => {
    expect(cloneChatSchema.safeParse({}).success).toBe(true);
  });

  // z.object defaults to non-strict (strip), so unknown keys are accepted and
  // dropped — not a rejection. Pin this so a switch to `.strict()` is caught.
  it("accepts unknown keys (non-strict; they are stripped, not rejected)", () => {
    expect(cloneChatSchema.safeParse({ unexpected: 1 }).success).toBe(true);
  });
});

// --- attachmentSchema -------------------------------------------------------

describe("attachmentSchema", () => {
  it("accepts a fully-valid attachment", () => {
    expect(attachmentSchema.safeParse(validAttachment()).success).toBe(true);
  });

  // id / assetId are `.min(1)` — empty string is rejected.
  it("rejects an empty id (min(1))", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), id: "" }));
  });

  it("rejects an empty assetId (min(1))", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), assetId: "" }));
  });

  it("rejects a missing id", () => {
    const { id: _omit, ...rest } = validAttachment();
    expectReject(attachmentSchema.safeParse(rest));
  });

  it("rejects a missing assetId", () => {
    const { assetId: _omit, ...rest } = validAttachment();
    expectReject(attachmentSchema.safeParse(rest));
  });

  // type enum.
  it("accepts every documented type enum member", () => {
    for (const type of ["image", "file", "video"]) {
      expect(attachmentSchema.safeParse({ ...validAttachment(), type }).success).toBe(true);
    }
  });

  it("rejects an unknown type enum member", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), type: "audio" }));
  });

  it("rejects a missing type", () => {
    const { type: _omit, ...rest } = validAttachment();
    expectReject(attachmentSchema.safeParse(rest));
  });

  // name is `.max(255)` — boundary both sides. NOTE: no `.min(1)`, so empty is OK.
  it("accepts a name of exactly 255 characters (max boundary)", () => {
    expect(attachmentSchema.safeParse({ ...validAttachment(), name: repeat(255) }).success).toBe(true);
  });

  it("rejects a name of 256 characters (over max)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), name: repeat(256) }));
  });

  it("accepts an empty name (no min(1) — asymmetry vs id/assetId)", () => {
    expect(attachmentSchema.safeParse({ ...validAttachment(), name: "" }).success).toBe(true);
  });

  // mimeType is `.max(100)` — boundary both sides. NOTE: no `.min(1)`.
  it("accepts a mimeType of exactly 100 characters (max boundary)", () => {
    expect(attachmentSchema.safeParse({ ...validAttachment(), mimeType: repeat(100) }).success).toBe(true);
  });

  it("rejects a mimeType of 101 characters (over max)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), mimeType: repeat(101) }));
  });

  it("accepts an empty mimeType (no min(1) — asymmetry vs id/assetId)", () => {
    expect(attachmentSchema.safeParse({ ...validAttachment(), mimeType: "" }).success).toBe(true);
  });

  // sizeBytes: `.int().positive().max(50_000_000)` — the richest constraint.
  it("accepts sizeBytes 1 (positive lower bound) and 50_000_000 (max boundary)", () => {
    expect(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: 1 }).success).toBe(true);
    expect(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: 50_000_000 }).success).toBe(true);
  });

  it("rejects sizeBytes 0 (not positive)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: 0 }));
  });

  it("rejects sizeBytes -1 (negative)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: -1 }));
  });

  it("rejects sizeBytes 50_000_001 (over max)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: 50_000_001 }));
  });

  it("rejects sizeBytes 1.5 (not an integer)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: 1.5 }));
  });

  it("rejects sizeBytes \"5\" (string, not number)", () => {
    expectReject(attachmentSchema.safeParse({ ...validAttachment(), sizeBytes: "5" }));
  });

  it("rejects a missing sizeBytes", () => {
    const { sizeBytes: _omit, ...rest } = validAttachment();
    expectReject(attachmentSchema.safeParse(rest));
  });
});

// --- sendMessageSchema ------------------------------------------------------

describe("sendMessageSchema", () => {
  it("accepts a message with content and no attachments (attachments optional)", () => {
    expect(sendMessageSchema.safeParse({ content: "hi" }).success).toBe(true);
  });

  it("accepts a message with content and one valid attachment", () => {
    expect(sendMessageSchema.safeParse({ content: "hi", attachments: [validAttachment()] }).success).toBe(true);
  });

  it("rejects a message missing content", () => {
    expectReject(sendMessageSchema.safeParse({}));
  });

  it("rejects non-string content", () => {
    expectReject(sendMessageSchema.safeParse({ content: 123 }));
  });

  // attachments.max(5) — boundary both sides.
  it("accepts exactly 5 attachments (max boundary)", () => {
    expect(sendMessageSchema.safeParse({ content: "hi", attachments: validAttachments(5) }).success).toBe(true);
  });

  it("rejects 6 attachments (over max 5)", () => {
    expectReject(sendMessageSchema.safeParse({ content: "hi", attachments: validAttachments(6) }));
  });

  // An invalid attachment inside the array must fail the whole message.
  it("rejects an attachment with bad sizeBytes inside the array", () => {
    const bad = { ...validAttachment(), sizeBytes: 0 };
    expectReject(sendMessageSchema.safeParse({ content: "hi", attachments: [bad] }));
  });

  it("rejects attachments that is not an array", () => {
    expectReject(sendMessageSchema.safeParse({ content: "hi", attachments: "not-an-array" }));
  });

  // attachments is optional, not nullable.
  it("rejects null attachments (optional, not nullable)", () => {
    expectReject(sendMessageSchema.safeParse({ content: "hi", attachments: null }));
  });
});

// --- editMessageSchema ------------------------------------------------------

describe("editMessageSchema", () => {
  it("accepts explicit content", () => {
    expect(editMessageSchema.safeParse({ content: "edited" }).success).toBe(true);
  });

  // content is `.optional().default("")` — omitted content is NOT a rejection;
  // the default fills in. Pin this so a `.default` removal is caught.
  it("accepts an empty object (content optional, default kicks in)", () => {
    expect(editMessageSchema.safeParse({}).success).toBe(true);
  });

  it("accepts explicitly-undefined content (default kicks in)", () => {
    expect(editMessageSchema.safeParse({ content: undefined }).success).toBe(true);
  });

  it("rejects non-string content", () => {
    expectReject(editMessageSchema.safeParse({ content: 123 }));
  });

  it("rejects null content (not nullable, but default applies to undefined only)", () => {
    expectReject(editMessageSchema.safeParse({ content: null }));
  });
});

// --- renameChatSchema -------------------------------------------------------

describe("renameChatSchema", () => {
  it("accepts a title", () => {
    expect(renameChatSchema.safeParse({ title: "New title" }).success).toBe(true);
  });

  it("rejects a payload missing title", () => {
    expectReject(renameChatSchema.safeParse({}));
  });

  it("rejects a non-string title", () => {
    expectReject(renameChatSchema.safeParse({ title: 123 }));
  });

  // title has NO min(1) — empty string is valid. Pin the asymmetry vs renameBranch.
  it("accepts an empty title (no min(1) — asymmetry vs renameBranchSchema)", () => {
    expect(renameChatSchema.safeParse({ title: "" }).success).toBe(true);
  });
});

// --- setGreetingIndexSchema -------------------------------------------------

describe("setGreetingIndexSchema", () => {
  it("accepts greetingIndex 0 (min boundary) and 5", () => {
    expect(setGreetingIndexSchema.safeParse({ greetingIndex: 0 }).success).toBe(true);
    expect(setGreetingIndexSchema.safeParse({ greetingIndex: 5 }).success).toBe(true);
  });

  it("rejects greetingIndex -1 (below min 0)", () => {
    expectReject(setGreetingIndexSchema.safeParse({ greetingIndex: -1 }));
  });

  it("rejects greetingIndex 1.5 (not an integer)", () => {
    expectReject(setGreetingIndexSchema.safeParse({ greetingIndex: 1.5 }));
  });

  it("rejects greetingIndex \"0\" (string, not number)", () => {
    expectReject(setGreetingIndexSchema.safeParse({ greetingIndex: "0" }));
  });

  it("rejects a payload missing greetingIndex", () => {
    expectReject(setGreetingIndexSchema.safeParse({}));
  });
});

// --- renameBranchSchema -----------------------------------------------------

describe("renameBranchSchema", () => {
  it("accepts a non-empty label", () => {
    expect(renameBranchSchema.safeParse({ label: "main" }).success).toBe(true);
  });

  it("rejects an empty label (min(1))", () => {
    expectReject(renameBranchSchema.safeParse({ label: "" }));
  });

  it("rejects a payload missing label", () => {
    expectReject(renameBranchSchema.safeParse({}));
  });

  it("rejects a non-string label", () => {
    expectReject(renameBranchSchema.safeParse({ label: 123 }));
  });
});
