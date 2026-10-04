/**
 * COAUTHOR_LORE_FULL_SETTINGS steps 2–3 — schema-source tests for the lore
 * tools' full settings surface.
 *
 * Pins three contracts:
 *  1. Description-map coverage — every settings field the lorebook API
 *     contracts define has a model-facing description (a contract field
 *     without one is drift; the compile-time mapped types make it an error,
 *     this makes it a runtime guarantee).
 *  2. Tool exposure — every contract settings field (minus the documented
 *     content-path / dead-alias exclusions) is a parameter of the tools, so a
 *     field added to the contracts reaches the Co-Author by editing the
 *     description map only.
 *  3. Full round-trip — a create with EVERY field set flows tool → draft
 *     bundle → the Apply RPC's own contract validation (the same schemas the
 *     lorebook API uses; no parallel validator set).
 */
import { describe, expect, test } from "bun:test";
import {
  coauthorApplySchema,
  updateLoreEntrySchema,
  updateLorebookMetaSchema,
} from "@vibe-tavern/api-contracts";
import type { CoauthorLoreBundleOutput } from "@vibe-tavern/api-contracts";
import { buildCoauthorTools } from "../src/domain/chat/coauthor-tools.js";
import {
  addLoreEntryToolInputSchema,
  createLoreEntryToolInputSchema,
  createLorebookToolInputSchema,
  editLoreEntryToolInputSchema,
  editLorebookToolInputSchema,
  LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS,
  LORE_TOOL_EXCLUDED_ENTRY_FIELDS,
  LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS,
} from "../src/domain/coauthor/lore/lore-tool-schemas.js";

import type { ToolExecutionContext } from "ai";

/** Shared tool-execution context stub (the tools ignore it). */
const ctx = { messages: [], toolCallId: "t", abort: () => {} } as ToolExecutionContext;

/** Deterministic id generator so assertions can name lorebook_1 / lore_entry_1. */
function deterministicIdGen(): (prefix: "lorebook" | "lore_entry") => string {
  const counters = new Map<string, number>();
  return (prefix) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${n}`;
  };
}

/** Every entry settings field with a DISTINCT non-default value (round-trip payload). */
const FULL_ENTRY_SETTINGS = {
  title: "Guardians",
  constant: true,
  position: "at_depth",
  depth: 9,
  logic: "not_all",
  enabled: true,
  priority: 42,
  probability: 77,
  ignoreBudget: true,
  role: "assistant",
  groupName: "squad",
  groupWeight: 55,
  prioritizeInclusion: true,
  useGroupScoring: true,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: true,
  recursionLevel: 4,
  scanDepthOverride: 9,
  caseSensitive: true,
  matchWholeWords: true,
  caseFormsKeys: ["дракон"],
  characterFilter: [{ id: null, name: "Alice" }, { id: "char_9", name: "Bob" }],
  characterFilterExclude: true,
  matchSources: ["chat_messages", "scenario"],
  stickyWindow: 3,
  cooldownWindow: 5,
  minChatMessages: 2,
} as const;

describe("lore-tool-schemas: description-map coverage (step 2 drift guard)", () => {
  test("every updateLorebookMetaSchema field has a non-empty description, with no extras", () => {
    const contractKeys = Object.keys(updateLorebookMetaSchema.shape).sort();
    const mapKeys = Object.keys(LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS).sort();
    expect(mapKeys).toEqual(contractKeys);
    for (const [key, description] of Object.entries(LOREBOOK_SETTINGS_FIELD_DESCRIPTIONS)) {
      expect(description.trim().length, `book field '${key}' needs a non-empty description`).toBeGreaterThan(10);
    }
  });

  test("every updateLoreEntrySchema settings field has a non-empty description, with no extras", () => {
    const excluded = new Set(Object.keys(LORE_TOOL_EXCLUDED_ENTRY_FIELDS));
    const contractKeys = Object.keys(updateLoreEntrySchema.shape)
      .filter((key) => !excluded.has(key))
      .sort();
    const mapKeys = Object.keys(LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS).sort();
    expect(mapKeys).toEqual(contractKeys);
    for (const [key, description] of Object.entries(LORE_ENTRY_SETTINGS_FIELD_DESCRIPTIONS)) {
      expect(description.trim().length, `entry field '${key}' needs a non-empty description`).toBeGreaterThan(10);
    }
  });

  test("the exclusion list is exactly the documented content-path trio + the dead order alias", () => {
    // content/keys/secondaryKeys are delegate-only (no new content path);
    // order is an ST wire alias of priority with no store column — exposing a
    // field the API PATCH path silently drops would be a trap.
    expect(Object.keys(LORE_TOOL_EXCLUDED_ENTRY_FIELDS).sort()).toEqual(
      ["content", "keys", "order", "secondaryKeys"],
    );
  });
});

describe("lore-tool-schemas: tool exposure of every contract field (step 2)", () => {
  const excluded = new Set(Object.keys(LORE_TOOL_EXCLUDED_ENTRY_FIELDS));

  test("create_lorebook / edit_lorebook expose every book settings field", () => {
    const createFields = Object.keys(createLorebookToolInputSchema.shape);
    const editFields = Object.keys(editLorebookToolInputSchema.shape);
    for (const field of Object.keys(updateLorebookMetaSchema.shape)) {
      expect(createFields).toContain(field);
      expect(editFields).toContain(field);
    }
    expect(editFields).toContain("lorebookId");
    // create requires a name (the draft engine rejects empty names) — the
    // update contract's optional name must not have leaked in.
    expect(createLorebookToolInputSchema.safeParse({ summary: "s" }).success).toBe(false);
    expect(createLorebookToolInputSchema.safeParse({ name: "Book", summary: "s" }).success).toBe(true);
  });

  test("create/add/edit lore entry tools expose every entry settings field and no content path", () => {
    for (const schema of [createLoreEntryToolInputSchema, addLoreEntryToolInputSchema, editLoreEntryToolInputSchema]) {
      const fields = Object.keys(schema.shape);
      for (const field of Object.keys(updateLoreEntrySchema.shape)) {
        if (excluded.has(field)) {
          expect(fields, `${field} must stay out of the tools`).not.toContain(field);
        } else {
          expect(fields, `${field} must be exposed`).toContain(field);
        }
      }
    }
    expect(Object.keys(createLoreEntryToolInputSchema.shape)).toContain("lorebookId");
    expect(Object.keys(editLoreEntryToolInputSchema.shape)).toContain("entryId");
  });

  test("stringly contract fields are narrowed to the domain enums (garbage rejected)", () => {
    expect(editLoreEntryToolInputSchema.safeParse({ entryId: "e", summary: "s", position: "middle_of_nowhere" }).success).toBe(false);
    expect(editLoreEntryToolInputSchema.safeParse({ entryId: "e", summary: "s", logic: "xor" }).success).toBe(false);
    expect(editLoreEntryToolInputSchema.safeParse({ entryId: "e", summary: "s", role: "narrator" }).success).toBe(false);
    expect(editLoreEntryToolInputSchema.safeParse({ entryId: "e", summary: "s", matchSources: ["chat_messages", "bogus"] }).success).toBe(false);
    expect(editLorebookToolInputSchema.safeParse({ lorebookId: "lb", summary: "s", scopeType: "banana" }).success).toBe(false);
    // The full settings payload itself parses, incl. the enum narrowings and
    // tri-state nulls.
    expect(editLoreEntryToolInputSchema.safeParse({ entryId: "e", summary: "s", useGroupScoring: null, scanDepthOverride: null }).success).toBe(true);
    expect(editLoreEntryToolInputSchema.safeParse({ entryId: "e", summary: "s", position: "before_persona", role: "user", matchSources: ["persona_desc"], logic: "and_all" }).success).toBe(true);
  });
});

describe("lore tools: full-settings round trip (step 3)", () => {
  test("create_lorebook + create_lore_entry carry every field into the bundle, and the bundle passes the Apply contract", async () => {
    const tools = buildCoauthorTools({ loreIdGen: deterministicIdGen() });
    const book = await tools.create_lorebook.execute(
      {
        name: "Tuned Book",
        description: "Full settings.",
        scopeType: "entity",
        enabled: true,
        scanDepth: 12,
        tokenBudget: 777,
        tokenBudgetPercent: 25,
        tokenBudgetCap: 3000,
        recursiveScanning: true,
        useGroupScoring: true,
        caseSensitive: true,
        matchWholeWords: true,
        maxRecursionSteps: 4,
        includeNames: true,
        minActivations: 2,
        minActivationsDepthMax: 30,
        overflowAlert: true,
        characterStrategy: 2,
        summary: "s",
      },
      ctx,
    );
    expect(book.bundle.lorebooks[0]).toMatchObject({
      tokenBudgetPercent: 25,
      tokenBudgetCap: 3000,
      useGroupScoring: true,
      caseSensitive: true,
      matchWholeWords: true,
      maxRecursionSteps: 4,
      includeNames: true,
      minActivations: 2,
      minActivationsDepthMax: 30,
      overflowAlert: true,
      characterStrategy: 2,
    });

    const entry = await tools.create_lore_entry.execute(
      { lorebookId: "lorebook_1", ...FULL_ENTRY_SETTINGS, summary: "s" },
      ctx,
    );
    const node = entry.bundle.entries[0];
    // Every settings field landed on the draft node (base + settings alike).
    expect(node).toMatchObject({ ...FULL_ENTRY_SETTINGS });

    // The same bundle validates against the Apply RPC's contract — the SAME
    // schemas the lorebook API uses (no parallel validator set).
    const parsed = coauthorApplySchema.safeParse({ loreBundle: entry.bundle });
    expect(parsed.success).toBe(true);
  });

  test("edit_lore_entry patches the new settings fields on a turn-drafted entry", async () => {
    const tools = buildCoauthorTools({ loreIdGen: deterministicIdGen() });
    await tools.create_lorebook.execute({ name: "LB", summary: "s" }, ctx);
    await tools.create_lore_entry.execute({ lorebookId: "lorebook_1", title: "T", summary: "s" }, ctx);
    const out: CoauthorLoreBundleOutput = await tools.edit_lore_entry.execute(
      {
        entryId: "lore_entry_1",
        probability: 30,
        stickyWindow: 4,
        cooldownWindow: 2,
        minChatMessages: 10,
        groupName: "oath",
        groupWeight: 80,
        prioritizeInclusion: true,
        useGroupScoring: null,
        excludeRecursion: true,
        delayUntilRecursion: true,
        recursionLevel: 2,
        scanDepthOverride: 3,
        caseSensitive: false,
        matchWholeWords: true,
        characterFilter: [{ id: null, name: "Alice" }],
        characterFilterExclude: true,
        matchSources: ["chat_messages", "character_desc"],
        role: "user",
        position: "at_depth",
        priority: 7,
        summary: "s",
      },
      ctx,
    );
    const e = out.bundle.entries[0];
    expect(e).toMatchObject({
      probability: 30, stickyWindow: 4, cooldownWindow: 2, minChatMessages: 10,
      groupName: "oath", groupWeight: 80, prioritizeInclusion: true,
      useGroupScoring: null, excludeRecursion: true, delayUntilRecursion: true,
      recursionLevel: 2, scanDepthOverride: 3, caseSensitive: false, matchWholeWords: true,
      characterFilter: [{ id: null, name: "Alice" }], characterFilterExclude: true,
      matchSources: ["chat_messages", "character_desc"], role: "user", position: "at_depth", priority: 7,
    });
    // Content/keys are still delegate-only — untouched by the settings edit.
    expect(e.content).toBe("");
    expect(e.keys).toEqual([]);
  });

  test("edit_lorebook patches the new book settings fields on a turn-drafted book", async () => {
    const tools = buildCoauthorTools({ loreIdGen: deterministicIdGen() });
    await tools.create_lorebook.execute({ name: "LB", summary: "s" }, ctx);
    const out = await tools.edit_lorebook.execute(
      {
        lorebookId: "lorebook_1",
        tokenBudgetPercent: 40,
        tokenBudgetCap: 900,
        maxRecursionSteps: 3,
        includeNames: false,
        minActivations: 1,
        minActivationsDepthMax: 12,
        overflowAlert: true,
        characterStrategy: 0,
        summary: "s",
      },
      ctx,
    );
    expect(out.bundle.lorebooks[0]).toMatchObject({
      tokenBudgetPercent: 40, tokenBudgetCap: 900, maxRecursionSteps: 3,
      includeNames: false, minActivations: 1, minActivationsDepthMax: 12,
      overflowAlert: true, characterStrategy: 0,
    });
  });
});
