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
 * from the SELECTED variant of the latest assistant message. A record is current
 * only when its stamped `schemaHash`/`configRevision` match the live tracker
 * config — a stale or wrong-schema record yields an empty cache (the Scene is
 * invisible until regenerated under the current schema).
 *
 * Rebuild is triggered by every mutation that can change the current selection or
 * its freshness: generate/edit/delete (tracker-service, wired in SCN-9 routes),
 * selection/branch/variant/message deletion and content edit (runtime, SCN-8),
 * and schema/config change (chat-adapter). This module is the engine; the wiring
 * lands in the units that own each mutation site.
 */
import type { ChatId } from "@vibe-tavern/domain";
import { normalizeSceneTrackerConfig } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";

/** The chat-level current-Scene cache value (the selected variant's record +
 *  enough identity for the projection to know which variant it mirrors). */
export interface CurrentSceneCache {
	messageId: string;
	variantId: string;
	schemaHash: string;
	configRevision: number;
	sourceHash: string;
	sceneState: Record<string, unknown>;
	modelId: string | null;
	generatedAt: string;
}

/** Any record/config shape carrying the freshness stamps the cache compares. */
interface SceneRecordFreshness {
	schemaHash: string;
	configRevision: number;
}
interface SceneConfigFreshness {
	schemaHash: string;
	revision: number;
}

/**
 * A record is "current" when its captured schema/config stamps match the live
 * config — i.e. it was generated under the schema the chat uses right now.
 * (The record stamps `configRevision`; the config stamps `revision` — same value,
 * different field names at their respective layers.) Reused by the
 * prompt-injection path (SCN-7) so the same freshness rule governs both the
 * cache and main-model injection.
 */
export function isSceneRecordCurrent(record: SceneRecordFreshness, config: SceneConfigFreshness): boolean {
	return record.schemaHash === config.schemaHash && record.configRevision === config.revision;
}

/**
 * Rebuild `insightsCurrentSceneJson` from the live variant state and return the
 * computed cache (or null when there is no current Scene). Writes the cache
 * column on every call — including the empty (`'{}'`) reset — so the stored value
 * never drifts from the actual selection. Null when the chat, the active branch's
 * latest assistant selected variant, or its (fresh) record is absent.
 */
export async function rebuildCurrentSceneCache(
	stores: StoreContainer,
	chatId: ChatId,
): Promise<CurrentSceneCache | null> {
	const chat = await stores.chats.getById(chatId);
	if (!chat) return null;

	const config = normalizeSceneTrackerConfig(chat.insightsConfig.tracker);
	const target = await stores.messages.getCurrentSceneTarget(chat.activeBranchId);
	if (!target || !isSceneRecordCurrent(target.record, config)) {
		// No latest-assistant selected record, or it is stale (wrong schema/config)
		// → empty cache. The nonselected variant's own record is NOT substituted.
		await stores.chats.updateInsightsCurrentScene(chatId, null);
		return null;
	}

	const cache: CurrentSceneCache = {
		messageId: target.messageId,
		variantId: target.variantId,
		schemaHash: target.record.schemaHash,
		configRevision: target.record.configRevision,
		sourceHash: target.record.sourceHash,
		sceneState: target.record.sceneState,
		modelId: target.record.modelId,
		generatedAt: target.record.generatedAt,
	};
	await stores.chats.updateInsightsCurrentScene(chatId, cache);
	return cache;
}
