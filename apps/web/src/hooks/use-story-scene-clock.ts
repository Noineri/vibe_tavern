import { useMemo } from "react";
import {
  findSceneClockField,
  readStoryClock,
  SCENE_CLOCK_MARKER,
  type SceneTrackerDsl,
  type StoryClock,
} from "@vibe-tavern/domain";
import { useSnapshotStore } from "../stores/snapshot-store.js";

/**
 * useStorySceneClock (DIRECTOR_DECK_CALENDAR_PLAN DK-9) — the web's ONE
 * branch story-clock read: the chat's tracker schema over the latest valid
 * scene record, through the domain's {@link readStoryClock}. The scene
 * records reach the snapshot store per message (`messagesById[id].
 * sceneTracker`); no shared "latest valid record" selector existed before
 * this module (the Scene zone kept its helpers private), so this hook is
 * that ONE selector — every clock consumer reads through it, never a second
 * hand-written derivation.
 *
 * The selection mirrors the server's composition (`readBranchStoryClock`
 * over `MessageStore.getCurrentSceneTarget`, story-plan-sync.ts): the
 * ACTIVE branch's LATEST assistant message — no fallback to earlier ones —
 * its currently SELECTED variant's record, valid against the live config
 * (`schemaHash` match — the Scene zone's freshness rule; the server's cache
 * layer applies the same). Null clock when the day cannot be read; the
 * caller treats null as "no clock".
 *
 * `clockOn` is the calendar's off-state gate (mockup §8): the schema marks a
 * day field at all — independent of any record.
 *
 * Selectors return STRING BLOBS (the scene-zone idiom): a snapshot replace
 * swaps object identities, so raw-object selectors would re-render on every
 * sync; the blobs change only when the selected record or the config
 * actually changes. Reads the ACTIVE chat (the curtain exists only on the
 * active branch's owner — callers never pass ids).
 */
export function useStorySceneClock(): {
  /** The schema marks the day field — the calendar's on/off gate. */
  clockOn: boolean;
  /** The read clock; null without a marked schema, a readable latest valid record, or a valid day. */
  clock: StoryClock | null;
  /** Where the latest valid record lives — the target the clock writes go back through. */
  target: { messageId: string; variantId: string } | null;
  /** The latest valid record's scene state (the write base for the clock moves). */
  sceneState: Record<string, unknown> | null;
  /** The live schema (the enable write extends it with the canonical fields). */
  schema: SceneTrackerDsl;
} {
  // The tracker config the record's validity gates against (schema + hash).
  const configBlob = useSnapshotStore((s) => {
    const tracker = s.activeChat?.insightsConfig.tracker;
    return tracker ? JSON.stringify([tracker.schema, tracker.schemaHash]) : "";
  });
  // The latest assistant message's selected variant's record — walked from
  // the tail of the active branch's ordered list (the scene-zone idiom),
  // stringified so only a real record change re-renders.
  const recordBlob = useSnapshotStore((s) => {
    for (let i = s.messageOrder.length - 1; i >= 0; i--) {
      const message = s.messagesById[s.messageOrder[i]];
      if (!message || message.role !== "assistant") continue;
      const variant = message.variants?.[message.selectedVariantIndex ?? -1];
      if (!variant) return "";
      return JSON.stringify([message.id, variant.id, message.sceneTracker]);
    }
    return "";
  });

  return useMemo(() => {
    const schema = parseSchema(configBlob);
    const [messageId, variantId, record] = parseRecord(recordBlob);
    const clockOn = findSceneClockField(schema, SCENE_CLOCK_MARKER.day) !== null;
    const valid = record !== null && record.schemaHash === parseSchemaHash(configBlob);
    const clock = clockOn && valid ? readStoryClock(schema, record.sceneState) : null;
    return {
      clockOn,
      clock,
      target: valid && messageId !== null && variantId !== null ? { messageId, variantId } : null,
      sceneState: valid && record !== null ? (record.sceneState as Record<string, unknown> | null) : null,
      schema,
    };
  }, [configBlob, recordBlob]);
}

function parseSchema(configBlob: string): SceneTrackerDsl {
  if (configBlob === "") return {};
  try {
    const [schema] = JSON.parse(configBlob) as [SceneTrackerDsl, string];
    return schema ?? {};
  } catch {
    return {};
  }
}

function parseSchemaHash(configBlob: string): string {
  try {
    const [, schemaHash] = JSON.parse(configBlob) as [SceneTrackerDsl, string];
    return typeof schemaHash === "string" ? schemaHash : "";
  } catch {
    return "";
  }
}

function parseRecord(recordBlob: string): [
  string | null,
  string | null,
  { sceneState: unknown; schemaHash: string } | null,
] {
  if (recordBlob === "") return [null, null, null];
  try {
    const [messageId, variantId, record] = JSON.parse(recordBlob) as [
      string,
      string,
      { sceneState: unknown; schemaHash: string } | null,
    ];
    return [messageId, variantId, record];
  } catch {
    return [null, null, null];
  }
}
