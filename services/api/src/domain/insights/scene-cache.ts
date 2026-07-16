/**
 * Derived current-Scene cache projection (SCENE_TRACKER_PLAN SCN-6).
 *
 * `chats.insightsCurrentSceneJson` is a REBUILDABLE, NON-AUTHORITATIVE mirror
 * of the active branch's current Scene — the selected variant's record of the
 * latest assistant message. Canonical state lives on
 * `message_variants.scene_tracker_json` (owned by the immutable variant id);
 * prompt injection (SCN-7) queries those records directly and never trusts this
 * cache as source of truth. The cache exists so the chat-level projection carries
 * the current Scene without re-walking the branch each time it is read.
 *
 * The cache ALWAYS reflects the actual current selection and never a
 * just-finished nonselected job: a generation that completes for a now-unselected
 * variant persists its own record on that variant, but this rebuild reads back
 * from the SELECTED variant of the latest assistant message.
 *
 * A record is a PERSISTED FACT, not a cache entry of the current generation
 * recipe: the live tracker config (schema/model/provider/prompt/render/injection)
 * NEVER gates visibility here. Whatever schema/revision the selected variant's
 * record was generated under, as long as the record exists it is mirrored —
 * rendered via its own `schema` snapshot (falling back to the live config only
 * for legacy records persisted before the snapshot contract). Schema
 * compatibility (`schemaHash`) is reused only as a COHERENCE check for injection
 * and continuity baselines, never as a visibility gate; see
 * {@link isRecordSchemaCompatible}.
 *
 * Rebuild is triggered by every mutation that can change the current selection:
 * generate/edit/delete (tracker-service), selection/branch/variant/message
 * deletion and content edit (runtime, SCN-8), and schema/config change
 * (chat-adapter). This module is the engine; the wiring lands in the units that
 * own each mutation site.
 */
import type { ChatId, SceneTrackerDsl, ScenePromptFormat } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";

/** The chat-level current-Scene cache value (the selected variant's record +
 *  enough identity for the projection to know which variant it mirrors). */
export interface CurrentSceneCache {
	messageId: string;
	variantId: string;
	schemaHash: string;
	configRevision: number;
	sourceHash: string;
	/** The record's own schema snapshot (absent on legacy records → consumer
	 *  falls back to the live config schema to render). */
	schema: SceneTrackerDsl | undefined;
	/** The record's own prompt-format snapshot (absent on legacy records). */
	promptFormat: ScenePromptFormat | undefined;
	sceneState: Record<string, unknown>;
	modelId: string | null;
	generatedAt: string;
}

/** Record/config shapes carrying the identity stamps compared for coherence. */
interface SceneRecordIdentity {
	schemaHash: string;
}
interface SceneConfigIdentity {
	schemaHash: string;
}

/**
 * A record is "schema-compatible" with the live config when its captured
 * `schemaHash` matches — i.e. it was generated under the same schema shape the
 * chat uses right now (a `label`-stripped structural identity; model/provider/
 * prompt/render changes do NOT change it). This is a COHERENCE check only: it
 * decides whether a record may act as a continuity baseline or be injected into
 * the current-schema prompt. It is NEVER a visibility gate — an incompatible
 * record stays visible/renderable/retained; it is simply omitted from continuity
 * and current-schema injection until the schema matches again (or replaced via
 * an explicit rebuild).
 */
export function isRecordSchemaCompatible(record: SceneRecordIdentity, config: SceneConfigIdentity): boolean {
	return record.schemaHash === config.schemaHash;
}

/**
 * Rebuild `insightsCurrentSceneJson` from the live variant state and return the
 * computed cache (or null when there is no current Scene). Writes the cache
 * column on every call — including the empty (`'{}'`) reset — so the stored value
 * never drifts from the actual selection. Null when the chat, the active
 * branch's latest assistant selected variant, or its record is absent. NEVER
 * nulls out a record because of a schema/config mismatch — the record is a
 * persisted fact and is mirrored with its own schema snapshot regardless.
 */
export async function rebuildCurrentSceneCache(
	stores: StoreContainer,
	chatId: ChatId,
): Promise<CurrentSceneCache | null> {
	const chat = await stores.chats.getById(chatId);
	if (!chat) return null;

	const target = await stores.messages.getCurrentSceneTarget(chat.activeBranchId);
	if (!target) {
		// No latest-assistant selected record → empty cache. The nonselected
		// variant's own record is NOT substituted.
		await stores.chats.updateInsightsCurrentScene(chatId, null);
		return null;
	}

	const cache: CurrentSceneCache = {
		messageId: target.messageId,
		variantId: target.variantId,
		schemaHash: target.record.schemaHash,
		configRevision: target.record.configRevision,
		sourceHash: target.record.sourceHash,
		schema: target.record.schema,
		promptFormat: target.record.promptFormat,
		sceneState: target.record.sceneState,
		modelId: target.record.modelId,
		generatedAt: target.record.generatedAt,
	};
	await stores.chats.updateInsightsCurrentScene(chatId, cache);
	return cache;
}
