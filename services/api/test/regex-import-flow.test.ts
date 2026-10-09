/**
 * RXU-23 — card `regex_scripts` land as ONE character-linked Regex Profile
 * bundle (REGEX_RULE_PROFILE_UX_PORTABILITY, Wave 2 step 3).
 *
 * Full-path boundary test over the REAL SessionRuntime.importJson /
 * importJsonBatch entry points (the same ones the HTTP routes delegate to):
 * a V3 card carrying data.extensions.regex_scripts becomes exactly ONE
 * Profile linked to the imported character, created in a single atomic
 * RegexStore.createProfileBundle write.
 *
 * Pins (the RXU-23 contract):
 *   - default (option omitted): bundle created with master `disabled: true`,
 *     member rules keep their SOURCE enabled/disabled states (RXU-11 drafts,
 *     no force-disable pass); the master switch alone keeps rules inert;
 *   - option true: master `disabled: false`, source-enabled rules are active
 *     immediately (resolver pin), source-disabled rules stay disabled;
 *   - one rule and many rules both land as one bundle;
 *   - duplicate suppression within one card (same name+findRegex key) and on
 *     re-import against the SAME character: no duplicate rules, and an
 *     all-duplicates re-import creates NO zero-rule Profile;
 *   - no-regex card → no bundle write, count 0, import succeeds;
 *   - bundle-store failure → character import still succeeds, count 0, no
 *     partial rows (containment; transactional atomicity is the store's own
 *     RXU-12 test surface);
 *   - batch input carries the option through per item;
 *   - skipExisting whole-character skipping never touches the regex store.
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { importJson } from "../src/runtime/session/session-runtime-import-export.js";
import type { ImportExportModuleDeps } from "../src/runtime/session/session-runtime-import-export.js";

const tmpDirs: string[] = [];

async function setup(): Promise<SessionRuntime> {
  const tmpDir = resolve(tmpdir(), "vt-rxu23flow-" + crypto.randomUUID().slice(0, 8));
  tmpDirs.push(tmpDir);
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  return new SessionRuntime(stores);
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
});

/** Minimal chara_card_v3 with regex_scripts embedded under data.extensions. */
function makeCard(scripts: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    name: "RegexCard",
    data: {
      name: "RegexCard",
      description: "A card with regex.",
      first_mes: "Hi!",
      extensions: {
        regex_scripts: scripts,
      },
    },
  });
}

function stScript(scriptName: string, findRegex: string, opts?: { disabled?: boolean }): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    scriptName,
    findRegex,
    replaceString: "[x]",
    trimStrings: [],
    placement: [2],
    // Source state — RXU-11 fidelity: the import must keep it verbatim; only
    // the Profile master switch is request-controlled.
    disabled: opts?.disabled ?? false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** One enabled + one disabled + one enabled source script (mixed states). */
function mixedScripts(): Array<Record<string, unknown>> {
  return [
    stScript("on-a", "/foo/g"),
    stScript("off-b", "/bar/g", { disabled: true }),
    stScript("on-c", "/baz/g"),
  ];
}

describe("RXU-23 card regex import flow", () => {
  it("default (omitted option): ONE profile, master off, source states intact; master keeps source-enabled rules inert", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "card.json",
      jsonText: makeCard(mixedScripts()),
    });

    expect(result.createdRegexPresets).toBe(3);

    const profiles = await runtime.stores.regex.listProfiles();
    expect(profiles).toHaveLength(1);
    const profile = profiles[0]!;
    expect(profile.disabled).toBe(true); // option omitted → master OFF
    expect(profile.isGlobal).toBe(false);
    expect(profile.name).toBe("RegexCard's Regex");
    expect(await runtime.stores.regex.getProfileLinks(profile.id)).toEqual([
      { regexProfileId: profile.id, targetType: "character", targetId: result.characterId },
    ]);

    // Member rules round-trip their SOURCE states and are born in the profile.
    const rules = await runtime.stores.regex.listAll();
    expect(rules).toHaveLength(3);
    const states = Object.fromEntries(rules.map((r) => [r.name, r.disabled]));
    expect(states).toEqual({ "on-a": false, "off-b": true, "on-c": false });
    for (const rule of rules) {
      expect(rule.profileId).toBe(profile.id);
    }

    // The master switch is the only bundle-level gate: with the profile off,
    // even source-enabled members resolve as inert.
    expect(await runtime.stores.regex.resolveActiveRegexPresets({
      characterId: result.characterId as string,
      presetId: null,
    })).toEqual([]);
  });

  it("option true: master on, source-enabled rules active immediately, source-disabled stay off", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "card.json",
      jsonText: makeCard(mixedScripts()),
      enableImportedRegexProfile: true,
    });

    expect(result.createdRegexPresets).toBe(3);

    const profiles = await runtime.stores.regex.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.disabled).toBe(false);

    // Full gate chain end-to-end: profile enabled + character-linked + rule's
    // own source state → exactly the source-enabled rules act at once.
    const active = await runtime.stores.regex.resolveActiveRegexPresets({
      characterId: result.characterId as string,
      presetId: null,
    });
    expect(active.map((r) => r.name)).toEqual(["on-a", "on-c"]);
  });

  it("a one-script card lands as a one-rule bundle", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "solo.json",
      jsonText: makeCard([stScript("Only", "/only/g")]),
    });

    expect(result.createdRegexPresets).toBe(1);
    const profiles = await runtime.stores.regex.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.disabled).toBe(true);
    const rules = await runtime.stores.regex.listAll();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.profileId).toBe(profiles[0]!.id);
  });

  it("each import owns its own character's bundle (imports create fresh characters)", async () => {
    const runtime = await setup();
    const card = makeCard([stScript("Strip", "/foo/g"), stScript("Censor", "/bar/g")]);
    const first = await runtime.importJson({ fileName: "card.json", jsonText: card });
    const second = await runtime.importJson({ fileName: "card.json", jsonText: card });

    // Re-import creates a NEW character row (fresh id per import — the
    // deterministic bundle id is a lookup key, not the stored row id), so
    // each character carries its own linked bundle — no cross-character
    // dedupe, matching ST semantics.
    expect(first.characterId).not.toBe(second.characterId);
    expect(first.createdRegexPresets).toBe(2);
    expect(second.createdRegexPresets).toBe(2);

    expect(await runtime.stores.regex.listAll()).toHaveLength(4);
    expect(await runtime.stores.regex.listProfiles()).toHaveLength(2);
    // First character keeps exactly its two rules, via its own profile.
    const firstRules: string[] = [];
    for (const profile of await runtime.stores.regex.listProfiles()) {
      const links = await runtime.stores.regex.getProfileLinks(profile.id);
      if (links.some((l) => l.targetId === first.characterId)) {
        for (const memberId of await runtime.stores.regex.listProfileMemberIds(profile.id)) {
          const member = await runtime.stores.regex.getById(memberId);
          if (member) firstRules.push(member.name);
        }
      }
    }
    expect(firstRules.sort()).toEqual(["Censor", "Strip"]);
  });

  it("identical scripts WITHIN one card dedupe to a single bundle rule", async () => {
    const runtime = await setup();
    const result = await runtime.importJson({
      fileName: "card.json",
      jsonText: makeCard([stScript("Strip", "/foo/g"), stScript("Strip", "/foo/g")]),
    });
    expect(result.createdRegexPresets).toBe(1);
    expect(await runtime.stores.regex.listAll()).toHaveLength(1);
    expect(await runtime.stores.regex.listProfiles()).toHaveLength(1);
  });

  it("re-import against the SAME character: no duplicate rules, no second zero-rule profile", async () => {
    // Real-store imports mint a fresh character id per card (previous test),
    // and the update branch chats under the card's deterministic id — which
    // needs a real row at that id (chats carry an FK on characterId). So pin
    // the same-character world at the module seam (import-lean.test.ts
    // idiom): a REAL RegexStore over a real store container, with the
    // character id held fixed so BOTH imports persist regex under ONE
    // character — the stable-id re-import scenario the dedupe scope serves.
    const tmpDir = resolve(tmpdir(), "vt-rxu23dedupe-" + crypto.randomUUID().slice(0, 8));
    tmpDirs.push(tmpDir);
    await mkdir(resolve(tmpDir, "data"), { recursive: true });
    const stores = await createRuntimeStore(resolve(tmpDir, "data"));
    const deps = {
      stores: {
        ...stores,
        characters: {
          getById: async () => null,
          create: async () => ({ id: "char_dedupe_1" }),
          update: async () => {
            throw new Error("update must not run while getById returns null");
          },
          resolveFolderName: async (id: string) => id,
        },
        content: {
          ...stores.content,
          writeEntity: async () => "stub/path",
        },
      },
      chatApp: {
        createChat: async () => ({ id: "chat_dedupe_1", activeBranchId: "br_1" }),
      },
      chatOrder: { add: () => {} },
      resolveDefaultPersonaId: async () => "persona_default",
      resolveDefaultPromptPresetId: async () => "preset_default",
      seedImportedOpening: async () => {},
      getSnapshot: async () => ({ chats: [], messages: [] }),
    } as unknown as ImportExportModuleDeps;

    const card = makeCard([stScript("Strip", "/foo/g"), stScript("Censor", "/bar/g")]);
    const first = await importJson(deps, { fileName: "card.json", jsonText: card, lean: true });
    const second = await importJson(deps, { fileName: "card.json", jsonText: card, lean: true });

    expect(first.characterId).toBe(second.characterId);
    expect(first.createdRegexPresets).toBe(2);
    // Every (name + findRegex) key is already owned → all duplicates →
    // report 0 and create NO profile (a bundle requires ≥ 1 rule).
    expect(second.createdRegexPresets).toBe(0);
    expect(await stores.regex.listProfiles()).toHaveLength(1);
    expect(await stores.regex.listAll()).toHaveLength(2);
  });

  it("a card without regex_scripts creates no bundle and succeeds", async () => {
    const runtime = await setup();
    const originalCreateBundle = runtime.stores.regex.createProfileBundle.bind(runtime.stores.regex);
    runtime.stores.regex.createProfileBundle = () => {
      throw new Error("createProfileBundle must not be called for a no-regex card");
    };
    try {
      const result = await runtime.importJson({
        fileName: "plain.json",
        jsonText: makeCard([]),
      });
      expect(result.characterId).toBeDefined();
      expect(result.imported.kind).toBe("character");
      expect(result.createdRegexPresets).toBe(0);
      expect(await runtime.stores.regex.listAll()).toHaveLength(0);
      expect(await runtime.stores.regex.listProfiles()).toHaveLength(0);
    } finally {
      runtime.stores.regex.createProfileBundle = originalCreateBundle;
    }
  });

  it("a bundle-store failure never breaks the card import (containment)", async () => {
    const runtime = await setup();
    const originalCreateBundle = runtime.stores.regex.createProfileBundle.bind(runtime.stores.regex);
    runtime.stores.regex.createProfileBundle = async () => {
      throw new Error("regex store exploded");
    };
    try {
      const result = await runtime.importJson({
        fileName: "card.json",
        jsonText: makeCard([stScript("Strip", "/foo/g")]),
      });
      // Card import succeeded; regex import degraded to zero created rules.
      expect(result.characterId).toBeDefined();
      expect(result.imported.kind).toBe("character");
      expect(result.createdRegexPresets).toBe(0);
      // No partial rows survived the failure (the store transaction owns
      // atomicity; containment here means nothing leaked from this path).
      expect(await runtime.stores.regex.listAll()).toHaveLength(0);
      expect(await runtime.stores.regex.listProfiles()).toHaveLength(0);
    } finally {
      runtime.stores.regex.createProfileBundle = originalCreateBundle;
    }
  });

  it("batch input carries the option through per item", async () => {
    const runtime = await setup();
    const cardOn = makeCard([stScript("Strip", "/foo/g"), stScript("Censor", "/bar/g")]);
    const cardOff = makeCard([stScript("Strip", "/foo/g"), stScript("Censor", "/bar/g")]);

    const batch = await runtime.importJsonBatch({
      lean: true,
      items: [
        { fileName: "on.json", jsonText: cardOn, enableImportedRegexProfile: true },
        { fileName: "off.json", jsonText: cardOff },
      ],
    });
    expect(batch.results).toHaveLength(2);
    expect(batch.results.every((r) => !r.error)).toBe(true);
    const [onItem, offItem] = batch.results;

    const profiles = await runtime.stores.regex.listProfiles();
    expect(profiles).toHaveLength(2);
    const stateById = new Map(profiles.map((p) => [p.id, p.disabled]));
    const disabledByCharacter = new Map<string, boolean>();
    for (const profile of profiles) {
      const links = await runtime.stores.regex.getProfileLinks(profile.id);
      expect(links).toHaveLength(1);
      expect(links[0]!.targetType).toBe("character");
      disabledByCharacter.set(links[0]!.targetId, stateById.get(profile.id)!);
    }
    // Item 1 opted in → its character's profile master is ON.
    expect(disabledByCharacter.get(onItem!.characterId as string)).toBe(false);
    // Item 2 sent nothing → defaults to master OFF.
    expect(disabledByCharacter.get(offItem!.characterId as string)).toBe(true);
    expect(await runtime.stores.regex.listAll()).toHaveLength(4);
  });

  it("skipExisting against an existing character skips the whole card — the regex store is never touched", async () => {
    // import-lean.test.ts seam: the whole-character skip branch needs an
    // existing character at the card's deterministic id, which real-store
    // imports never produce (fresh store ids). Stub deps pin that the early
    // return happens BEFORE any regex work — the RXU-23-preserved behavior.
    const regexExplosion = () => {
      throw new Error("regex store must not be touched on the skipExisting path");
    };
    const deps = {
      stores: {
        characters: {
          getById: mock(async () => ({ id: "char_existing_1", name: "Already Here" })),
          update: mock(async () => ({ id: "char_existing_1", name: "Already Here" })),
          resolveFolderName: mock(async (id: string) => id),
        },
        chats: {
          listByCharacter: mock(async () => []),
        },
        content: {
          writeEntity: mock(async () => "stub/path"),
        },
        regex: {
          listProfiles: regexExplosion,
          listAll: regexExplosion,
          createProfileBundle: regexExplosion,
        },
      },
      chatApp: {
        createChat: mock(async () => ({ id: "chat_skip_1", activeBranchId: "br_1" })),
      },
      chatOrder: { add: mock(() => {}) },
      resolveDefaultPersonaId: mock(async () => "persona_default"),
      resolveDefaultPromptPresetId: mock(async () => "preset_default"),
      seedImportedOpening: mock(async () => {}),
      getSnapshot: mock(async () => ({ chats: [], messages: [] })),
      resolver: {
        getCharacter: () => { throw new Error("resolver.getCharacter should not be called by importJson"); },
        getPersona: () => { throw new Error("resolver.getPersona should not be called by importJson"); },
      },
      fileStore: {
        resolvePath: () => { throw new Error("fileStore should not be called by importJson"); },
      },
    } as unknown as ImportExportModuleDeps;

    const result = await importJson(deps, {
      fileName: "card.json",
      jsonText: makeCard([stScript("Strip", "/foo/g")]),
      skipExisting: true,
      lean: true,
    });

    expect(result.imported.kind).toBe("character");
    expect(result.activeChatId).toBe("chat_skip_1");
    // Whole-character skip: no regex count at all (field omitted, not 0).
    expect(result.createdRegexPresets).toBeUndefined();
  });
});
