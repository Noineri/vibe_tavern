import { describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { createDb } from "../src/db-connection.js";
import { ttsListingSnapshots } from "../src/db-schema.js";
import {
  TtsListingSnapshotStore,
  TTS_LISTING_SNAPSHOT_KINDS,
  ttsVoicesSnapshotKind,
} from "../src/stores/tts-listing-snapshot-store.js";
import { TtsStore } from "../src/stores/tts-store.js";
import type { CreateTtsProfileData } from "../src/stores/tts-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b — tts_listing_snapshots
// persistence (fork #2 of the image-gen listing snapshot store). One row per
// (profile, kind) where kind is `models` or `voices:<modelId>`; the profile
// FK cascades.

let tick = 0;
const advancingClock: StoreClock = { now: () => `2026-10-16T00:00:${String(++tick).padStart(2, "0")}.000Z` };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

function profileInput(name: string): CreateTtsProfileData {
  return {
    name,
    backend: TTS_BACKEND.OpenAiCompatible,
    config: { endpoint: "http://localhost:8880/v1", model: "tts-1" },
    apiKey: null,
    providerRef: null,
    voiceId: "",
    narratorVoiceId: null,
    lang: "en",
    sortOrder: 0,
    isDefault: false,
  };
}

async function setup() {
  const db = await createDb(":memory:");
  const profiles = new TtsStore(db, { clock: advancingClock, idGenerator: idGen });
  const snapshots = new TtsListingSnapshotStore(db, { clock: advancingClock });
  const profile = await profiles.create(profileInput("Local"));
  return { db, profiles, snapshots, profileId: profile.id };
}

const MODELS = TTS_LISTING_SNAPSHOT_KINDS.Models;
const envelope = (voiceId: string, supportsCloning = false) => ({
  voices: [{ id: voiceId, label: voiceId, lang: "en" }],
  capabilities: { supportsCloning },
});

describe("TtsListingSnapshotStore", () => {
  test("put then get round-trips the payload and stamps the fetch time", async () => {
    const { snapshots, profileId } = await setup();
    const models = [{ id: "tts-1", label: "tts-1" }];

    expect(await snapshots.get(profileId, MODELS)).toBeNull();
    await snapshots.put(profileId, MODELS, models);

    const stored = await snapshots.get(profileId, MODELS);
    expect(stored).not.toBeNull();
    expect(stored!.payload).toEqual(models);
    expect(Number.isNaN(Date.parse(stored!.fetchedAt))).toBe(false);
  });

  test("a second put overwrites the row (never duplicates) and advances the fetch time", async () => {
    const { db, snapshots, profileId } = await setup();
    await snapshots.put(profileId, MODELS, [{ id: "old", label: "old" }]);
    const first = await snapshots.get(profileId, MODELS);

    await snapshots.put(profileId, MODELS, [{ id: "new", label: "new" }]);
    const second = await snapshots.get(profileId, MODELS);

    expect(second!.payload).toEqual([{ id: "new", label: "new" }]);
    expect(second!.fetchedAt).not.toBe(first!.fetchedAt);
    expect(await db.select().from(ttsListingSnapshots)).toHaveLength(1);
  });

  test("voice envelopes are separate rows per model id, whole with their capabilities", async () => {
    const { snapshots, profileId } = await setup();
    const kindA = ttsVoicesSnapshotKind("model-a");
    const kindB = ttsVoicesSnapshotKind("model-b");
    const noModel = ttsVoicesSnapshotKind("");

    expect(kindA).toBe("voices:model-a");
    expect(noModel).toBe("voices:");

    await snapshots.put(profileId, kindA, envelope("alice", true));
    await snapshots.put(profileId, kindB, envelope("bob"));

    expect((await snapshots.get(profileId, kindA))!.payload).toEqual(envelope("alice", true));
    expect((await snapshots.get(profileId, kindB))!.payload).toEqual(envelope("bob"));
    expect(await snapshots.get(profileId, noModel)).toBeNull();
  });

  test("a null-voices envelope is a stored envelope, not an absent one", async () => {
    const { snapshots, profileId } = await setup();
    const kind = ttsVoicesSnapshotKind("m");
    await snapshots.put(profileId, kind, { voices: null, capabilities: { supportsCloning: true } });
    const stored = await snapshots.get(profileId, kind);
    expect(stored).not.toBeNull();
    expect(stored!.payload).toEqual({ voices: null, capabilities: { supportsCloning: true } });
  });

  test("snapshots are per profile", async () => {
    const { profiles, snapshots, profileId } = await setup();
    const other = await profiles.create(profileInput("Other"));
    await snapshots.put(profileId, MODELS, [{ id: "a", label: "a" }]);

    expect(await snapshots.get(other.id, MODELS)).toBeNull();
  });

  test("clear(profile, kind) drops that kind only; clear(profile) drops every kind of the profile", async () => {
    const { profiles, snapshots, profileId } = await setup();
    const other = await profiles.create(profileInput("Other"));
    const voices = ttsVoicesSnapshotKind("m");
    await snapshots.put(profileId, MODELS, [{ id: "a", label: "a" }]);
    await snapshots.put(profileId, voices, envelope("v"));
    await snapshots.put(other.id, MODELS, [{ id: "b", label: "b" }]);

    await snapshots.clear(profileId, MODELS);
    expect(await snapshots.get(profileId, MODELS)).toBeNull();
    expect(await snapshots.get(profileId, voices)).not.toBeNull();

    await snapshots.put(profileId, MODELS, [{ id: "a", label: "a" }]);
    await snapshots.clear(profileId);
    expect(await snapshots.get(profileId, MODELS)).toBeNull();
    expect(await snapshots.get(profileId, voices)).toBeNull();
    expect(await snapshots.get(other.id, MODELS)).not.toBeNull();
  });

  test("a corrupt row reads as nothing stored and is dropped", async () => {
    const { db, snapshots, profileId } = await setup();
    await db.insert(ttsListingSnapshots).values({
      ttsProfileId: profileId,
      kind: MODELS,
      payloadJson: "{not json",
      fetchedAt: "2026-10-16T00:00:00.000Z",
    });

    expect(await snapshots.get(profileId, MODELS)).toBeNull();
    expect(await db.select().from(ttsListingSnapshots)).toHaveLength(0);
  });

  test("deleting the profile cascades its snapshots", async () => {
    const { db, profiles, snapshots, profileId } = await setup();
    await snapshots.put(profileId, MODELS, [{ id: "a", label: "a" }]);
    await snapshots.put(profileId, ttsVoicesSnapshotKind("m"), envelope("v"));

    await profiles.delete(profileId);

    expect(await db.select().from(ttsListingSnapshots)).toHaveLength(0);
  });
});
