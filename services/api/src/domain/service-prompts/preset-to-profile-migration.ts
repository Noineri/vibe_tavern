/**
 * One-time startup migration: preset-stored service-prompt overrides →
 * service-prompt profiles (SERVICE_PROMPTS_PROFILES_PLAN, SP-7).
 *
 * Before SP-4, service prompts lived inside prompt presets in three places:
 *  - `aiAssistantPrompts` JSON (assistant-mode overrides, keys === the mode
 *    `presetKey`s, which are exactly the assistant-family field keys);
 *  - the legacy `scriptAiSystemPrompt` column (script mode only, loser to a
 *    non-empty `aiAssistantPrompts.script` — same precedence preserved here);
 *  - the `summaryPrompt` column (summary instruction override).
 * SP-4 removed every read path; this migration snapshots those values into
 * standalone profiles NAMED AFTER their source preset, so nothing a user had
 * configured is lost when upgrading. Preset rows themselves are NEVER touched.
 *
 * Idempotency: guarded by the `uiSettings.servicePromptPresetMigrated` marker.
 * The marker flips in the FINAL settings write, so a clean completion never
 * re-runs. Crash window: if the process dies mid-loop, already-created profiles
 * would be duplicated by the next run — accepted because the loop is a
 * millisecond-scale, at-most-a-handful-of-rows startup pass (same reasoning as
 * the builtin-experience seed); a mid-migration crash loses nothing, and the
 * duplicate is deletable from the UI.
 *
 * Active pointer: `uiSettings.activePromptPresetId` names a preset that
 * produced a profile → that profile becomes the active service-prompt profile;
 * otherwise the pointer resolves to null (Default). Non-destructive overall:
 * the preset table, its JSON, and the legacy columns stay byte-identical.
 */
import type { AppDb } from "@vibe-tavern/db";
import type { PresetStore } from "@vibe-tavern/db";
import type { UiSettingsStore } from "@vibe-tavern/db";
import { ServicePromptProfileStore } from "@vibe-tavern/db";
import type { ServicePromptProfile } from "@vibe-tavern/db";
import type { PromptPreset } from "@vibe-tavern/db";
import { SERVICE_PROMPT_FIELD_KEYS } from "@vibe-tavern/domain";
import type { ServicePromptFieldKey } from "@vibe-tavern/domain";
import { getAllModeConfigs } from "../ai-assistant/ai-assistant-modes.js";

/** Structural dependency set — the full StoreContainer satisfies it; tests
 *  can pass a three-store literal. */
export interface PresetMigrationStores {
	db: AppDb;
	presets: PresetStore;
	uiSettings: UiSettingsStore;
}

export interface PresetMigrationResult {
	/** False when the marker was already set (nothing done). */
	ran: boolean;
	/** One entry per created profile, in preset order. */
	created: Array<{ presetId: string; presetName: string; profileId: string; fieldCount: number }>;
	/** Presets whose `aiAssistantPrompts` JSON failed to parse (skipped, logged). */
	skippedInvalidJson: string[];
	/** Final active service-prompt profile id (null = Default). */
	activeProfileId: string | null;
}

/** The keys the preset editor ever wrote into `aiAssistantPrompts` — the
 *  assistant family, taken from the mode registry (single source of truth). */
const PRESET_JSON_KEYS: readonly string[] = getAllModeConfigs().map((config) => config.presetKey);

const FIELD_KEY_SET = new Set<string>(SERVICE_PROMPT_FIELD_KEYS);

function isFieldKey(key: string): key is ServicePromptFieldKey {
	return FIELD_KEY_SET.has(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract trim-non-empty overrides from one preset row. Order of precedence
 *  mirrors the pre-SP-4 read path: JSON wins; legacy `scriptAiSystemPrompt`
 *  backs the `script` field only when the JSON slot is empty. */
function extractOverrides(preset: PromptPreset, onInvalidJson: () => void): Partial<Record<ServicePromptFieldKey, string>> {
	let parsed: Record<string, unknown> = {};
	if (preset.aiAssistantPrompts.trim() !== "") {
		try {
			const value: unknown = JSON.parse(preset.aiAssistantPrompts);
			if (isRecord(value)) {
				parsed = value;
			} else {
				onInvalidJson();
			}
		} catch {
			onInvalidJson();
		}
	}

	const overrides: Partial<Record<ServicePromptFieldKey, string>> = {};
	for (const key of PRESET_JSON_KEYS) {
		if (!isFieldKey(key)) continue;
		const value = parsed[key];
		if (typeof value === "string" && value.trim().length > 0) {
			overrides[key] = value;
		}
	}
	// Legacy column backs `script` only when the JSON slot produced nothing
	// (pre-SP-4 the preset override always won over the legacy column).
	if (overrides.script === undefined && preset.scriptAiSystemPrompt.trim().length > 0) {
		overrides.script = preset.scriptAiSystemPrompt;
	}
	if (preset.summaryPrompt.trim().length > 0) {
		overrides.summary = preset.summaryPrompt;
	}
	return overrides;
}

/** Run the one-time migration. Safe to call on every startup — the marker
 *  short-circuits after the first successful pass. */
export async function migratePresetServicePrompts(stores: PresetMigrationStores): Promise<PresetMigrationResult> {
	const settings = await stores.uiSettings.get();
	if (settings.servicePromptPresetMigrated) {
		return { ran: false, created: [], skippedInvalidJson: [], activeProfileId: settings.activeServicePromptProfileId };
	}

	const profileStore = new ServicePromptProfileStore(stores.db);
	const allPresets = await stores.presets.listAll();
	const created: PresetMigrationResult["created"] = [];
	const skippedInvalidJson: string[] = [];

	for (const preset of allPresets) {
		const overrides = extractOverrides(preset, () => skippedInvalidJson.push(preset.name));
		const fieldCount = Object.keys(overrides).length;
		if (fieldCount === 0) continue;
		const profile: ServicePromptProfile = await profileStore.createServicePromptProfile({
			name: preset.name,
			overrides,
		});
		created.push({ presetId: preset.id, presetName: preset.name, profileId: profile.id, fieldCount });
	}

	const activePresetId = settings.activePromptPresetId;
	const activeMatch = activePresetId ? created.find((entry) => entry.presetId === activePresetId) : undefined;
	const activeProfileId = activeMatch ? activeMatch.profileId : null;

	await stores.uiSettings.update({ servicePromptPresetMigrated: true, activeServicePromptProfileId: activeProfileId });
	return { ran: true, created, skippedInvalidJson, activeProfileId };
}
