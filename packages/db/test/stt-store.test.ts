import { describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { STT_BACKENDS } from '@vibe-tavern/domain';

import { createDb } from '../src/db-connection.js';
import { sttProfiles } from '../src/db-schema.js';
import { SttStore } from '../src/stores/stt-store.js';
import type { CreateSttProfileData } from '../src/stores/stt-store.js';
import type { StoreClock, StoreIdGenerator } from '../src/persistence.js';

const fixedClock: StoreClock = { now: () => '2026-08-27T00:00:00.000Z' };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const db = await createDb(':memory:');
	const store = new SttStore(db, { clock: fixedClock, idGenerator: idGen });
	return { store, db };
}

let inputCounter = 0;
function baseInput(overrides: Partial<CreateSttProfileData> = {}): CreateSttProfileData {
	inputCounter += 1;
	return {
		name: `stt_${inputCounter}`,
		backend: STT_BACKENDS.WhisperBrowser,
		config: { model: 'Xenova/whisper-small', language: 'en' },
		emotionAnnotation: false,
		isDefault: false,
		...overrides,
	};
}

describe('SttStore CRUD', () => {
	test('create → getById round-trips the config union, emotionAnnotation and booleans', async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({
				name: 'Local faster-whisper',
				backend: STT_BACKENDS.OpenAiCompat,
				config: { endpoint: 'http://localhost:8000/v1', model: 'whisper-1', language: 'ru' },
				emotionAnnotation: true,
				isDefault: true,
			}),
		);

		expect(created.id).toStartWith('stt_profile_');
		expect(created.createdAt).toBe(fixedClock.now());
		expect(created.updatedAt).toBe(fixedClock.now());
		expect(created.config).toEqual({
			endpoint: 'http://localhost:8000/v1',
			model: 'whisper-1',
			language: 'ru',
		});
		expect(created.emotionAnnotation).toBe(true);

		const loaded = await store.getById(created.id);
		expect(loaded).toEqual(created);
	});

	test('whisper-browser config round-trips without an endpoint; emotionAnnotation defaults false', async () => {
		const { store } = await setup();
		const created = await store.create(
			baseInput({ name: 'Default whisper', config: { model: 'Xenova/whisper-small' } }),
		);
		expect(created.config).toEqual({ model: 'Xenova/whisper-small' });
		expect(created.emotionAnnotation).toBe(false);
		expect((await store.getById(created.id))?.config).toEqual({ model: 'Xenova/whisper-small' });
	});

	test('create claiming default clears the previous default pointer', async () => {
		const { store } = await setup();
		const first = await store.create(baseInput({ isDefault: true }));
		const second = await store.create(baseInput({ isDefault: true }));

		const reloadedFirst = await store.getById(first.id);
		expect(reloadedFirst?.isDefault).toBe(false);
		expect((await store.getById(second.id))?.isDefault).toBe(true);

		const def = await store.getDefault();
		expect(def?.id).toBe(second.id);
	});

	test('getDefault returns null when no profile is default', async () => {
		const { store } = await setup();
		await store.create(baseInput({ isDefault: false }));
		expect(await store.getDefault()).toBeNull();
	});

	test('update patches fields, serializes config, bumps updatedAt; unknown id → null', async () => {
		const { store } = await setup();
		const created = await store.create(baseInput({ name: 'Old name' }));

		const updated = await store.update(created.id, {
			name: 'New name',
			config: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe' },
		});
		expect(updated?.name).toBe('New name');
		expect(updated?.config).toEqual({ endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-transcribe' });
		expect(updated?.createdAt).toBe(created.createdAt);
		expect(updated?.updatedAt).toBe(fixedClock.now());

		expect(await store.update('stt_profile_missing', { name: 'x' })).toBeNull();
	});

	test('setDefault moves the pointer atomically; unknown id → null', async () => {
		const { store } = await setup();
		const first = await store.create(baseInput({ isDefault: true }));
		const second = await store.create(baseInput());

		const moved = await store.setDefault(second.id);
		expect(moved?.isDefault).toBe(true);
		expect((await store.getById(first.id))?.isDefault).toBe(false);
		expect((await store.getDefault())?.id).toBe(second.id);

		expect(await store.setDefault('stt_profile_missing')).toBeNull();
	});

	test('deleting the default leaves no auto-promoted default', async () => {
		const { store } = await setup();
		const first = await store.create(baseInput({ isDefault: true }));
		await store.create(baseInput());

		await store.delete(first.id);
		expect(await store.getDefault()).toBeNull();
	});

	test('listAll orders by name then createdAt (no sortOrder in the STT schema)', async () => {
		const { store } = await setup();
		await store.create(baseInput({ name: 'zeta' }));
		await store.create(baseInput({ name: 'alpha' }));
		await store.create(baseInput({ name: 'mid' }));

		const names = (await store.listAll()).map((p) => p.name);
		expect(names).toEqual(['alpha', 'mid', 'zeta']);
	});
});

describe('SttStore typed key column (ST-1 / TE2-16 rule)', () => {
	test('create round-trips apiKey via the typed field; the config bag never carries it — and the raw config_json blob never contains it', async () => {
		const { store, db } = await setup();
		const created = await store.create(
			baseInput({
				backend: STT_BACKENDS.OpenAiCompat,
				config: { endpoint: 'https://api.example.com/v1', apiKey: 'smuggled', model: 'whisper-1' },
				apiKey: 'sk-real',
			}),
		);
		expect(created.apiKey).toBe('sk-real');
		// Strip-on-write: bag-sent secrets are dropped, not persisted.
		expect(created.config).toEqual({ endpoint: 'https://api.example.com/v1', model: 'whisper-1' });

		// The persisted JSON blob carries NO key in any form — the secret lives
		// only in the typed api_key column (binary criterion of ST-1).
		const row = db.select().from(sttProfiles).where(eq(sttProfiles.id, created.id)).get();
		expect(row!.configJson).not.toContain('sk-real');
		expect(row!.configJson).not.toContain('apiKey');
		expect(row!.apiKey).toBe('sk-real');
	});

	test('update tri-state: undefined keeps, empty clears, value replaces', async () => {
		const { store } = await setup();
		const p = await store.create(baseInput({ backend: STT_BACKENDS.OpenAiCompat, apiKey: 'sk-1' }));
		const kept = await store.update(p.id, { name: 'renamed' });
		expect(kept?.apiKey).toBe('sk-1');
		const replaced = await store.update(p.id, { apiKey: 'sk-2' });
		expect(replaced?.apiKey).toBe('sk-2');
		const cleared = await store.update(p.id, { apiKey: '' });
		expect(cleared?.apiKey).toBeUndefined();
		expect((await store.getById(p.id))?.apiKey).toBeUndefined();
	});

	test('backend flip clears the stored key; flip + new key keeps the new one', async () => {
		const { store } = await setup();
		const p = await store.create(baseInput({ backend: STT_BACKENDS.OpenAiCompat, apiKey: 'sk-old' }));
		const flipped = await store.update(p.id, { backend: STT_BACKENDS.WhisperBrowser, config: { model: 'x' } });
		expect(flipped?.apiKey).toBeUndefined();
		const flippedWithKey = await store.update(p.id, { backend: STT_BACKENDS.OpenAiCompat, apiKey: 'sk-new' });
		expect(flippedWithKey?.apiKey).toBe('sk-new');
	});

	test('legacy rows with a key inside config_json are stripped on read', async () => {
		const { store, db } = await setup();
		const profile = await store.create(baseInput());
		// Simulate a hand-edited / restored-backup row: the key sits in the blob.
		await db
			.update(sttProfiles)
			.set({ configJson: '{"apiKey":"sk-legacy","model":"whisper-1"}' })
			.where(eq(sttProfiles.id, profile.id))
			.run();
		const loaded = await store.getById(profile.id);
		expect(loaded?.config).toEqual({ model: 'whisper-1' });
		// The typed column was null → the write-only key is omitted on read.
		expect(loaded?.apiKey).toBeUndefined();
	});
});

describe('SttStore JSON hygiene', () => {
	test('malformed configJson and unknown backend slugs degrade instead of throwing', async () => {
		const { store, db } = await setup();
		const profile = await store.create(baseInput());
		// Simulate hand-edited / forward-versioned rows. (Raw `db.run(sql, ?)`
		// param binding is a silent no-op in drizzle's bun-sqlite driver, so the
		// drizzle `.update()` builder is used — same as the legacy-row test.)
		await db
			.update(sttProfiles)
			.set({ configJson: '{broken', backend: 'minimax' })
			.where(eq(sttProfiles.id, profile.id))
			.run();

		const loaded = await store.getById(profile.id);
		// The strict config union has no empty member — degrade to the minimal
		// membership-valid shape ({ model: '' }, the whisper-browser member)
		// so the row stays visible/editable in the list (house pattern: reads
		// never crash on forward-compatible data).
		expect(loaded?.config).toEqual({ model: '' });
		// Unknown future slug degrades to the zero-setup default backend.
		expect(loaded?.backend).toBe(STT_BACKENDS.WhisperBrowser);
	});

	test('fresh :memory: db applies the stt migration (tables exist)', async () => {
		const { db } = await setup();
		const row = db.select().from(sttProfiles).all();
		expect(row).toEqual([]);
	});
});