import { describe, expect, test } from 'bun:test';

import { IMAGE_GEN_BACKENDS, IMAGE_GEN_TARGET_TYPE } from '@vibe-tavern/domain';
import type { ImageGenCapabilityFlags } from '@vibe-tavern/domain';
import { eq } from 'drizzle-orm';

import { createDb } from '../src/db-connection.js';
import { imageGenLinks, imageGenModelSettings, imageGenProfiles } from '../src/db-schema.js';
import { ImageGenStore } from '../src/stores/image-gen-store.js';
import type { CreateImageGenProfileData } from '../src/stores/image-gen-store.js';
import type { StoreClock, StoreIdGenerator } from '../src/persistence.js';

const fixedClock: StoreClock = { now: () => '2026-09-14T00:00:00.000Z' };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const db = await createDb(':memory:');
	const store = new ImageGenStore(db, { clock: fixedClock, idGenerator: idGen });
	return { store, db };
}

const a1111Capabilities: ImageGenCapabilityFlags = {
	supportsNegativePrompt: true,
	supportsSamplers: true,
	supportsSeed: true,
	sizeSupport: { kind: 'free' },
	noApiKey: true,
	supportsLiveProgress: true,
	localExecution: true,
	supportsImg2img: false,
	supportsInpaint: false,
};

const openaiImagesCapabilities: ImageGenCapabilityFlags = {
	supportsNegativePrompt: false,
	supportsSamplers: false,
	supportsSeed: false,
	sizeSupport: { kind: 'vendor-set', sizes: ['1024x1024', '1024x1536', '1536x1024'] },
	noApiKey: false,
	supportsLiveProgress: false,
	localExecution: false,
	supportsImg2img: false,
	supportsInpaint: false,
};

let inputCounter = 0;
function baseInput(overrides: Partial<CreateImageGenProfileData> = {}): CreateImageGenProfileData {
	inputCounter += 1;
	return {
		name: `image_gen_${inputCounter}`,
		backend: IMAGE_GEN_BACKENDS.A1111,
		presetId: 'a1111-local',
		endpoint: 'http://127.0.0.1:7860',
		defaultParams: { steps: undefined, cfgScale: undefined, sampler: undefined },
		modeSizePresets: { portrait: { width: 832, height: 1216 } },
		llmAssistEnabled: false,
		capabilities: a1111Capabilities,
		sortOrder: 0,
		...overrides,
	};
}

describe('ImageGenStore CRUD', () => {
	test('create → getById round-trips params, sizes, capabilities, llmAssist fields', async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({
				name: 'Forge — local',
				modelId: 'sd_xl_base.safetensors',
				llmAssistEnabled: true,
				llmProviderProfileId: 'provider_1',
				llmModelId: 'gpt-4o-mini',
			}),
		);

		expect(created.id).toStartWith('image_gen_profile_');
		expect(created.createdAt).toBe(fixedClock.now());
		expect(created.updatedAt).toBe(fixedClock.now());
		expect(created.modelId).toBe('sd_xl_base.safetensors');
		expect(created.modeSizePresets).toEqual({ portrait: { width: 832, height: 1216 } });
		expect(created.capabilities).toEqual(a1111Capabilities);
		expect(created.llmAssistEnabled).toBe(true);
		expect(created.llmProviderProfileId).toBe('provider_1');
		expect(created.llmModelId).toBe('gpt-4o-mini');

		const loaded = await store.getById(created.id);
		expect(loaded).toEqual(created);
	});

	test('apiKey round-trips on create but never inside JSON columns', async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ apiKey: 'sk-secret' }));
		expect(created.apiKey).toBe('sk-secret');

		const loaded = await store.getById(created.id);
		expect(loaded?.apiKey).toBe('sk-secret');
		// The key must not leak into the JSON blobs (IG-1/ST-1 strip rule).
		expect(JSON.stringify(loaded?.defaultParams)).not.toContain('sk-secret');
		expect(JSON.stringify(loaded?.modeSizePresets)).not.toContain('sk-secret');
	});

	test('update patch: undefined apiKey keeps the stored key, "" clears it, new value replaces it', async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ apiKey: 'sk-original' }));

		const untouched = await store.update(created.id, { name: 'renamed' });
		expect(untouched?.apiKey).toBe('sk-original');
		expect(untouched?.name).toBe('renamed');

		const cleared = await store.update(created.id, { apiKey: '' });
		expect(cleared?.apiKey).toBeUndefined();

		const replaced = await store.update(created.id, { apiKey: 'sk-new' });
		expect(replaced?.apiKey).toBe('sk-new');

		const missing = await store.update('image_gen_profile_nope', { name: 'x' });
		expect(missing).toBeNull();
	});

	test('backend flip clears the stored key unless the same patch provides a new one', async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({ backend: IMAGE_GEN_BACKENDS.OpenAiImages, capabilities: openaiImagesCapabilities, apiKey: 'sk-cloud' }),
		);

		const flipped = await store.update(created.id, {
			backend: IMAGE_GEN_BACKENDS.A1111,
			capabilities: a1111Capabilities,
		});
		expect(flipped?.apiKey).toBeUndefined();
		expect(flipped?.backend).toBe(IMAGE_GEN_BACKENDS.A1111);

		const flippedWithKey = await store.update(flipped!.id, {
			backend: IMAGE_GEN_BACKENDS.OpenRouter,
			apiKey: 'sk-or',
		});
		expect(flippedWithKey?.apiKey).toBe('sk-or');
	});

	test('update applies params/sizes/capabilities patches and bumps updatedAt order', async () => {
		const { store } = await setup();
		const created = await store.create(baseInput());
		const updated = await store.update(created.id, {
			defaultParams: { steps: 30, cfgScale: 7, sampler: 'DPM++ 2M', clipSkip: 2 },
			modeSizePresets: { 'scene-background': { width: 1536, height: 640 } },
			capabilities: openaiImagesCapabilities,
		});
		expect(updated?.defaultParams).toEqual({ steps: 30, cfgScale: 7, sampler: 'DPM++ 2M', clipSkip: 2 });
		expect(updated?.modeSizePresets).toEqual({ 'scene-background': { width: 1536, height: 640 } });
		expect(updated?.capabilities).toEqual(openaiImagesCapabilities);
	});

	test('IG-20a: user size entries persist on create, replace on update, and absent column reads as none', async () => {
		const { store, db } = await setup();
		// Absent on create → the field stays undefined (pre-IG-20a rows).
		const plain = await store.create(baseInput());
		expect(plain.userSizes).toBeUndefined();

		const entries = [
			{ width: 1152, height: 896, ratio: '9:7' },
			{ width: 1216, height: 896 },
		];
		const created = await store.create(baseInput({ userSizes: entries }));
		expect(created.userSizes).toEqual(entries);
		expect((await store.getById(created.id))?.userSizes).toEqual(entries);

		// PATCH replaces the whole list; an empty list clears the field.
		const updated = await store.update(created.id, {
			userSizes: [{ width: 1024, height: 576, ratio: '16:9' }],
		});
		expect(updated?.userSizes).toEqual([{ width: 1024, height: 576, ratio: '16:9' }]);
		const cleared = await store.update(created.id, { userSizes: [] });
		expect(cleared?.userSizes).toBeUndefined();

		// A malformed column degrades to none (the forward-compat read rule).
		await store.update(created.id, { userSizes: entries });
		await db
			.update(imageGenProfiles)
			.set({ userSizesJson: '{broken' })
			.where(eq(imageGenProfiles.id, created.id))
			.run();
		expect((await store.getById(created.id))?.userSizes).toBeUndefined();
	});

	test('listAll orders by sortOrder, then name; delete removes the row', async () => {
		const { store } = await setup();
		const a = await store.create(baseInput({ name: 'B-profile', sortOrder: 1 }));
		const b = await store.create(baseInput({ name: 'A-profile', sortOrder: 1 }));
		const c = await store.create(baseInput({ name: 'Z-profile', sortOrder: 0 }));

		const list = await store.listAll();
		expect(list.map((p) => p.name)).toEqual(['Z-profile', 'A-profile', 'B-profile']);

		await store.delete(c.id);
		expect(await store.getById(c.id)).toBeNull();
		// The other rows survive.
		expect((await store.listAll()).map((p) => p.id)).toEqual([b.id, a.id]);
	});

	test('malformed JSON columns degrade instead of throwing (rows survive)', async () => {
		const { store, db } = await setup();
		const created = await store.create(baseInput());
		// Simulate hand-edited / forward-versioned rows. (Raw `db.run(sql, ?)`
		// param binding is a silent no-op in drizzle's bun-sqlite driver, so the
		// drizzle `.update()` builder is used — same as the STT legacy-row test.)
		await db
			.update(imageGenProfiles)
			.set({ defaultParamsJson: '{broken', modeSizePresetsJson: 'null', capabilitiesJson: '[]' })
			.where(eq(imageGenProfiles.id, created.id))
			.run();
		const loaded = await store.getById(created.id);
		expect(loaded?.defaultParams).toEqual({});
		expect(loaded?.modeSizePresets).toEqual({});
		expect(loaded?.capabilities).toEqual({
			supportsNegativePrompt: false,
			supportsSamplers: false,
			supportsSeed: false,
			sizeSupport: { kind: 'free' },
			noApiKey: false,
			supportsLiveProgress: false,
			localExecution: false,
			supportsImg2img: false,
			supportsInpaint: false,
		});
	});

	test('unknown backend slug degrades to a roster member (forward-compatible read)', async () => {
		const { store, db } = await setup();
		const created = await store.create(baseInput());
		await db
			.update(imageGenProfiles)
			.set({ backend: 'future-protocol' })
			.where(eq(imageGenProfiles.id, created.id))
			.run();
		const loaded = await store.getById(created.id);
		expect(loaded?.backend).toBe(IMAGE_GEN_BACKENDS.OpenRouter);
	});
});

describe('ImageGenStore links (character bindings)', () => {
	test('setLinks replaces the set atomically; getLinks/listAllLinks read back', async () => {
		const { store } = await setup();
		const profile = await store.create(baseInput());
		const other = await store.create(baseInput());

		await store.setLinks(profile.id, [
			{ targetType: IMAGE_GEN_TARGET_TYPE.Character, targetId: 'char_1' },
			{ targetType: IMAGE_GEN_TARGET_TYPE.Character, targetId: 'char_2' },
		]);
		expect((await store.getLinks(profile.id)).map((l) => l.targetId).sort()).toEqual(['char_1', 'char_2']);

		// Replace: old bindings vanish, new land.
		await store.setLinks(profile.id, [{ targetType: IMAGE_GEN_TARGET_TYPE.Character, targetId: 'char_3' }]);
		expect((await store.getLinks(profile.id)).map((l) => l.targetId)).toEqual(['char_3']);

		await store.addLink(other.id, IMAGE_GEN_TARGET_TYPE.Character, 'char_1');
		const all = await store.listAllLinks();
		expect(all).toHaveLength(2);

		await store.removeLink(other.id, IMAGE_GEN_TARGET_TYPE.Character, 'char_1');
		expect((await store.listAllLinks()).map((l) => l.imageGenProfileId)).toEqual([profile.id]);
	});

	test('duplicate tuples in one setLinks payload dedup before the replace (PK integrity)', async () => {
		const { store } = await setup();
		const profile = await store.create(baseInput());
		await store.setLinks(profile.id, [
			{ targetType: IMAGE_GEN_TARGET_TYPE.Character, targetId: 'char_1' },
			{ targetType: IMAGE_GEN_TARGET_TYPE.Character, targetId: 'char_1' },
		]);
		expect(await store.getLinks(profile.id)).toHaveLength(1);
	});

	test('unknown targetType rows are skipped on read, not thrown', async () => {
		const { store, db } = await setup();
		const profile = await store.create(baseInput());
		await db
			.insert(imageGenLinks)
			.values({ imageGenProfileId: profile.id, targetType: 'persona', targetId: 'p_1' })
			.run();
		expect(await store.listAllLinks()).toHaveLength(0);
	});

	describe('ImageGenStore model favorites + per-model settings (IG-12b)', () => {
		test('starring is idempotent per (profile, model) and refreshes the label', async () => {
			const { store } = await setup();
			const profile = await store.create(baseInput());
			const first = await store.addModelFavorite(profile.id, { modelId: 'sd_xl', label: 'SD XL' });
			const again = await store.addModelFavorite(profile.id, { modelId: 'sd_xl', label: 'SDXL 1.0' });
			expect(await store.listModelFavorites(profile.id)).toHaveLength(1);
			expect(again.label).toBe('SDXL 1.0');
			expect(first.label).toBe('SD XL');
		});

		test('favorites are per-profile (no scope column — single surface)', async () => {
			const { store } = await setup();
			const a = await store.create(baseInput());
			const b = await store.create(baseInput());
			await store.addModelFavorite(a.id, { modelId: 'sd_xl' });
			await store.addModelFavorite(b.id, { modelId: 'sd_xl' });
			expect(await store.listModelFavorites(a.id)).toHaveLength(1);
			expect(await store.listModelFavorites(b.id)).toHaveLength(1);
		});

		test('un-starring removes only that row; a no-op on an unstarred model', async () => {
			const { store } = await setup();
			const profile = await store.create(baseInput());
			await store.addModelFavorite(profile.id, { modelId: 'keep' });
			await store.addModelFavorite(profile.id, { modelId: 'drop' });
			await store.removeModelFavorite(profile.id, 'drop');
			await store.removeModelFavorite(profile.id, 'never-starred');
			const rows = await store.listModelFavorites(profile.id);
			expect(rows.map((r) => r.modelId)).toEqual(['keep']);
		});

		test('overlay upsert is idempotent per (profile, model) and rewrites wholesale', async () => {
			const { store } = await setup();
			const profile = await store.create(baseInput());
			await store.upsertModelSettings(profile.id, 'sd_xl', { steps: 30, sampler: 'DPM++ 2M' });
			const updated = await store.upsertModelSettings(profile.id, 'sd_xl', { cfgScale: 7 });
			expect(updated.settings).toEqual({ cfgScale: 7 });
			expect(await store.listModelSettings(profile.id)).toHaveLength(1);
		});

		test('overlay delete reverts the model to the profile base; no-op if none', async () => {
			const { store } = await setup();
			const profile = await store.create(baseInput());
			await store.upsertModelSettings(profile.id, 'sd_xl', { steps: 30 });
			await store.deleteModelSettings(profile.id, 'sd_xl');
			await store.deleteModelSettings(profile.id, 'sd_xl');
			expect(await store.getModelSettings(profile.id, 'sd_xl')).toBeNull();
		});

		test('a malformed hand-edited settingsJson degrades to the empty overlay (rows-survive rule)', async () => {
			const { store, db } = await setup();
			const profile = await store.create(baseInput());
			await store.upsertModelSettings(profile.id, 'sd_xl', { steps: 30 });
			await db
				.update(imageGenModelSettings)
				.set({ settingsJson: '{not json' })
				.where(eq(imageGenModelSettings.modelId, 'sd_xl'))
				.run();
			const row = await store.getModelSettings(profile.id, 'sd_xl');
			expect(row?.settings).toEqual({});
		});

		test('deleting a profile cascades favorites and overlays', async () => {
			const { store } = await setup();
			const profile = await store.create(baseInput());
			await store.addModelFavorite(profile.id, { modelId: 'sd_xl' });
			await store.upsertModelSettings(profile.id, 'sd_xl', { steps: 30 });
			await store.delete(profile.id);
			expect(await store.listModelFavorites(profile.id)).toHaveLength(0);
			expect(await store.listModelSettings(profile.id)).toHaveLength(0);
		});

		test('an apiKey smuggled into an overlay is stripped on write (IG-1 secret rule)', async () => {
			const { store } = await setup();
			const profile = await store.create(baseInput());
			// Simulate a caller that stuffs the key into the JSON blob.
			const dirty = { steps: 30, apiKey: 'sk-secret' } as unknown as import('@vibe-tavern/domain').ImageGenModelSettingsOverlay;
			await store.upsertModelSettings(profile.id, 'sd_xl', dirty);
			const row = await store.getModelSettings(profile.id, 'sd_xl');
			expect(row?.settings).toEqual({ steps: 30 });
		});
	});
});
