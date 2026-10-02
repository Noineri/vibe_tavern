/**
 * One-time startup migration: global image prompt variants → image prompt
 * profiles (IMAGEGEN_FOLLOWUP_REPORT, IF-1a — the IPT-1 rework).
 *
 * IPT Wave 1 stored user image-prompt overrides in a single GLOBAL
 * `image_prompt_variants` table (one row per (rowKey, family) — no profile
 * machinery). IF-1 rebuilds the surface on separately-living profiles; this
 * migration snapshots every existing global row into ONE new profile named
 * "Imported" and makes it the ACTIVE image prompt profile, so an upgrading
 * install keeps generating byte-identical prompts (the same overrides are
 * simply reached through the active profile instead of the global table).
 * The old table is NOT touched (non-destructive; its retirement is a later
 * unit) and nothing a user had customized is ever lost.
 *
 * Idempotency: guarded by the `uiSettings.imagePromptVariantsMigrated`
 * marker. The marker flips in the FINAL settings write, so a clean
 * completion never re-runs. Crash window: if the process dies between
 * profile creation and the marker write, the next run would create a second
 * "Imported" profile — accepted for the same reason as the SP-7 migration:
 * a millisecond-scale, at-most-a-handful-of-rows startup pass; a
 * mid-migration crash loses nothing, and the duplicate is deletable from
 * the UI. Name collisions (a user already created an "Imported") resolve
 * with an English "(copy)" suffix — stored data, generated before any
 * locale is known (SP-7 precedent).
 *
 * A fresh install (no global rows) flips the marker and creates nothing;
 * the active pointer stays null (Default profile).
 */
import type { AppDb, ImagePromptVariantStore, ImagePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import type { ImagePromptProfile } from "@vibe-tavern/db";
import { makeImagePromptCellKey } from "@vibe-tavern/domain";
import type { ImagePromptOverridesInput } from "@vibe-tavern/db";

/** Structural dependency set — the full StoreContainer satisfies it; tests
 *  can pass a three-store literal. */
export interface GlobalVariantMigrationStores {
	db: AppDb;
	imagePromptVariants: ImagePromptVariantStore;
	imagePromptProfiles: ImagePromptProfileStore;
	uiSettings: UiSettingsStore;
}

export interface GlobalVariantMigrationResult {
	/** False when the marker was already set (nothing done). */
	ran: boolean;
	/** The created "Imported" profile id, or null when no global rows existed. */
	createdProfileId: string | null;
	/** Number of (rowKey, family) cells carried into the profile. */
	cellCount: number;
	/** Final active image prompt profile id (null = Default). */
	activeProfileId: string | null;
}

/** Suffix appended when the target name collides with an existing profile
 *  name (SP-7 precedent — English on purpose: stored data, generated before
 *  any locale is known). */
const COPY_SUFFIX = " (copy)";

/** The name of the single snapshot profile this migration creates. */
const IMPORTED_PROFILE_NAME = "Imported";

function uniqueProfileName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	let name = `${base}${COPY_SUFFIX}`;
	let counter = 2;
	while (taken.has(name)) {
		name = `${base}${COPY_SUFFIX} ${counter}`;
		counter += 1;
	}
	return name;
}

/** Run the one-time migration. Safe to call on every startup — the marker
 *  short-circuits after the first successful pass. */
export async function migrateGlobalImagePromptVariants(stores: GlobalVariantMigrationStores): Promise<GlobalVariantMigrationResult> {
	const settings = await stores.uiSettings.get();
	if (settings.imagePromptVariantsMigrated) {
		return { ran: false, createdProfileId: null, cellCount: 0, activeProfileId: settings.activeImagePromptProfileId };
	}

	const rows = await stores.imagePromptVariants.listAll();
	if (rows.length === 0) {
		// Fresh (or never-customized) install: nothing to carry.
		await stores.uiSettings.update({ imagePromptVariantsMigrated: true });
		return { ran: true, createdProfileId: null, cellCount: 0, activeProfileId: null };
	}

	const overrides: ImagePromptOverridesInput = {};
	for (const row of rows) {
		const key = makeImagePromptCellKey(row.rowKey, row.family);
		overrides[key] = { body: row.body, qualityText: row.qualityText ?? null };
	}

	const existing = await stores.imagePromptProfiles.listImagePromptProfiles();
	const takenNames = new Set(existing.map((profile) => profile.name));
	const profileName = uniqueProfileName(IMPORTED_PROFILE_NAME, takenNames);
	const profile: ImagePromptProfile = await stores.imagePromptProfiles.createImagePromptProfile({
		name: profileName,
		overrides,
	});

	await stores.uiSettings.update({
		imagePromptVariantsMigrated: true,
		activeImagePromptProfileId: profile.id,
	});
	return { ran: true, createdProfileId: profile.id, cellCount: rows.length, activeProfileId: profile.id };
}
