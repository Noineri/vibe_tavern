import { describe, expect, test } from "bun:test";

import { STT_BACKENDS } from "@vibe-tavern/domain";

import { createDb } from "../src/db-connection.js";
import { sttListingSnapshots } from "../src/db-schema.js";
import { SttListingSnapshotStore, STT_LISTING_SNAPSHOT_KINDS } from "../src/stores/stt-listing-snapshot-store.js";
import { SttStore } from "../src/stores/stt-store.js";
import type { CreateSttProfileData } from "../src/stores/stt-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b — stt_listing_snapshots
// persistence (fork #1 of the image-gen listing snapshot store). One row per
// (profile, kind); the profile FK cascades.

let tick = 0;
const advancingClock: StoreClock = { now: () => `2026-10-16T00:00:${String(++tick).padStart(2, "0")}.000Z` };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

function profileInput(name: string, endpoint: string): CreateSttProfileData {
  return {
    name,
    backend: STT_BACKENDS.OpenAiCompat,
    config: { endpoint, model: "whisper-1" },
    emotionAnnotation: false,
    isDefault: false,
  };
}

async function setup() {
  const db = await createDb(":memory:");
  const profiles = new SttStore(db, { clock: advancingClock, idGenerator: idGen });
  const snapshots = new SttListingSnapshotStore(db, { clock: advancingClock });
  const profile = await profiles.create(profileInput("Cloud", "http://localhost:8000/v1"));
  return { db, profiles, snapshots, profileId: profile.id };
}

describe("SttListingSnapshotStore", () => {
  test("put then get round-trips the payload and stamps the fetch time", async () => {
    const { snapshots, profileId } = await setup();
    const models = [{ id: "whisper-1", label: "Whisper" }];

    expect(await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models)).toBeNull();
    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, models);

    const stored = await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models);
    expect(stored).not.toBeNull();
    expect(stored!.payload).toEqual(models);
    expect(Number.isNaN(Date.parse(stored!.fetchedAt))).toBe(false);
  });

  test("a second put overwrites the row (never duplicates) and advances the fetch time", async () => {
    const { db, snapshots, profileId } = await setup();
    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "old", label: "old" }]);
    const first = await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models);

    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "new", label: "new" }]);
    const second = await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models);

    expect(second!.payload).toEqual([{ id: "new", label: "new" }]);
    expect(second!.fetchedAt).not.toBe(first!.fetchedAt);
    expect(await db.select().from(sttListingSnapshots)).toHaveLength(1);
  });

  test("an empty list is a stored list, not an absent one", async () => {
    const { snapshots, profileId } = await setup();
    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, []);
    const stored = await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models);
    expect(stored).not.toBeNull();
    expect(stored!.payload).toEqual([]);
  });

  test("snapshots are per profile", async () => {
    const { profiles, snapshots, profileId } = await setup();
    const other = await profiles.create(profileInput("Other", "http://localhost:9000/v1"));
    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "a", label: "a" }]);

    expect(await snapshots.get(other.id, STT_LISTING_SNAPSHOT_KINDS.Models)).toBeNull();
  });

  test("clear(profile, kind) drops that kind; clear(profile) drops all of the profile", async () => {
    const { profiles, snapshots, profileId } = await setup();
    const other = await profiles.create(profileInput("Other", "http://localhost:9000/v1"));
    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "a", label: "a" }]);
    await snapshots.put(other.id, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "b", label: "b" }]);

    await snapshots.clear(profileId, STT_LISTING_SNAPSHOT_KINDS.Models);
    expect(await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models)).toBeNull();
    expect(await snapshots.get(other.id, STT_LISTING_SNAPSHOT_KINDS.Models)).not.toBeNull();

    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "a", label: "a" }]);
    await snapshots.clear(profileId);
    expect(await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models)).toBeNull();
    expect(await snapshots.get(other.id, STT_LISTING_SNAPSHOT_KINDS.Models)).not.toBeNull();
  });

  test("a corrupt row reads as nothing stored and is dropped", async () => {
    const { db, snapshots, profileId } = await setup();
    await db.insert(sttListingSnapshots).values({
      sttProfileId: profileId,
      kind: STT_LISTING_SNAPSHOT_KINDS.Models,
      payloadJson: "{not json",
      fetchedAt: "2026-10-16T00:00:00.000Z",
    });

    expect(await snapshots.get(profileId, STT_LISTING_SNAPSHOT_KINDS.Models)).toBeNull();
    expect(await db.select().from(sttListingSnapshots)).toHaveLength(0);
  });

  test("deleting the profile cascades its snapshots", async () => {
    const { db, profiles, snapshots, profileId } = await setup();
    await snapshots.put(profileId, STT_LISTING_SNAPSHOT_KINDS.Models, [{ id: "a", label: "a" }]);

    await profiles.delete(profileId);

    expect(await db.select().from(sttListingSnapshots)).toHaveLength(0);
  });
});
