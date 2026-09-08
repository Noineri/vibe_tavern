/**
 * Lorebook import service — `enabled` threading (L1a).
 *
 * The DB layer always supported disabled books (createLorebook defaults
 * `enabled ?? true`), but importLorebook never accepted or forwarded the flag,
 * so every import landed enabled. These tests pin the forwarding at the
 * service boundary using a minimal fake lorebooks store (the service takes
 * StoreContainer as a DI seam — no mocks needed):
 *
 *   1. mode:"new" + enabled:false → createLorebook receives enabled:false.
 *   2. mode:"new" + enabled absent → createLorebook receives enabled:true
 *      (the historical default is preserved, not flipped).
 *   3. merge into an existing book ignores `enabled` — only the creation
 *      branch consumes it; merging entries never flips the book's toggle.
 *
 * Parsing runs through the REAL ST parser (dynamic import inside the
 * service) so the entry pipeline below the flag stays honest.
 */
import { describe, it, expect, mock } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import { importLorebook } from "../src/domain/lorebook/lorebook-import-service.js";

const ST_BOOK = {
  name: "Svc World",
  entries: {
    "0": {
      uid: 0, key: ["greeting"], keysecondary: [],
      content: "Greetings lore entry.", comment: "test",
      constant: false, vectorized: false, selective: true,
      selectiveLogic: 0, addMemo: false, order: 100, position: 0,
      disable: false, excludeRecursion: false, preventRecursion: false,
      delayUntilRecursion: false, probability: 100, useProbability: true,
      depth: 4, group: "", groupOverride: false, groupWeight: 100,
      scanDepth: null, caseSensitive: null, matchWholeWords: null,
      useGroupScoring: null, automationId: "", role: null, sticky: null,
      cooldown: null, delay: null, displayIndex: 0,
    },
  },
};

function makeStores() {
  const createLorebook = mock(async (data: Record<string, unknown>) => ({ id: "lb_1", ...data }));
  const bulkCreateEntries = mock(async (_lorebookId: string, _entries: unknown[]) => 1);
  const stores = {
    lorebooks: {
      createLorebook,
      bulkCreateEntries,
      getLorebook: async (_id: string) => ({ id: "lb_x", name: "Existing" }),
      deleteAllEntries: async (_id: string) => {},
    },
  } as unknown as StoreContainer;
  return { stores, createLorebook, bulkCreateEntries };
}

describe("lorebook-import-service — enabled threading (L1a)", () => {
  it("mode:new + enabled:false reaches createLorebook as enabled:false", async () => {
    const { stores, createLorebook } = makeStores();

    const result = await importLorebook(stores, null, {
      format: "st",
      data: ST_BOOK,
      mode: "new",
      scopeType: "global",
      fallbackName: "SvcWorld",
      enabled: false,
    });

    expect(result.lorebookId).toBe("lb_1");
    expect(result.imported).toBe(1);
    expect(createLorebook).toHaveBeenCalledTimes(1);
    const created = createLorebook.mock.calls[0][0] as Record<string, unknown>;
    expect(created.enabled).toBe(false);
    expect(created.scopeType).toBe("global");
  });

  it("mode:new + enabled absent still creates an enabled book (default preserved)", async () => {
    const { stores, createLorebook } = makeStores();

    await importLorebook(stores, null, {
      format: "st",
      data: ST_BOOK,
      mode: "new",
      scopeType: "entity",
      fallbackName: "SvcWorld",
    });

    expect(createLorebook).toHaveBeenCalledTimes(1);
    const created = createLorebook.mock.calls[0][0] as Record<string, unknown>;
    expect(created.enabled).toBe(true);
  });

  it("merge into an existing book ignores enabled (no creation, no toggle flip)", async () => {
    const { stores, createLorebook, bulkCreateEntries } = makeStores();

    const result = await importLorebook(stores, "lb_x", {
      format: "st",
      data: ST_BOOK,
      mode: "merge",
      enabled: false,
    });

    expect(result.lorebookId).toBe("lb_x");
    expect(createLorebook).not.toHaveBeenCalled();
    expect(bulkCreateEntries).toHaveBeenCalledTimes(1);
  });
});
