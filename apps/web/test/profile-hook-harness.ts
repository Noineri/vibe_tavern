import { mock } from "bun:test";
import { createElement } from "react";
import { installI18nContextSeam } from "./i18n-context-seam.js";

export interface ProfileReorderUpdate {
	id: string;
	sortOrder: number;
}

export interface ProfileCrudHarnessOptions<
	TRecord extends { id: string },
	TCreateBody,
	TUpdateBody,
> {
	createRecord: (body: TCreateBody, id: string) => TRecord;
	applyUpdate: (current: TRecord, body: TUpdateBody) => TRecord;
	withDefault: (record: TRecord, isDefault: boolean) => TRecord;
	withSortOrder?: (record: TRecord, sortOrder: number) => TRecord;
	defaultFailMessage?: string;
}

/**
 * Shared in-memory CRUD store + 6 mock endpoints for settings-profile hook
 * suites (ImageGen, STT, TTS). Callers supply concrete record construction
 * and patch lambdas so mocked updates stay strictly typed without casts.
 */
export function createProfileCrudHarness<
	TRecord extends { id: string },
	TCreateBody,
	TUpdateBody,
>(options: ProfileCrudHarnessOptions<TRecord, TCreateBody, TUpdateBody>) {
	const baseFailMessage = options.defaultFailMessage ?? "save boom";
	let store: TRecord[] = [];
	let failUpdate = false;
	let failMessage = baseFailMessage;

	const listAllMock = mock(async (): Promise<TRecord[]> => [...store]);

	const createMock = mock(async (body: TCreateBody): Promise<TRecord> => {
		const record = options.createRecord(body, `p${store.length + 1}`);
		store.push(record);
		return record;
	});

	const updateMock = mock(async (id: string, body: TUpdateBody): Promise<TRecord> => {
		if (failUpdate) throw new Error(failMessage);
		const idx = store.findIndex((profile) => profile.id === id);
		if (idx === -1) throw new Error("not found");
		const current = store[idx];
		if (!current) throw new Error("not found");
		const updated = options.applyUpdate(current, body);
		store[idx] = updated;
		return updated;
	});

	const deleteMock = mock(async (id: string): Promise<void> => {
		store = store.filter((profile) => profile.id !== id);
	});

	const setDefaultMock = mock(async (id: string): Promise<TRecord> => {
		store = store.map((profile) => options.withDefault(profile, profile.id === id));
		const updated = store.find((profile) => profile.id === id);
		if (!updated) throw new Error("not found");
		return updated;
	});

	const reorderMock = mock(async (updates: ProfileReorderUpdate[]): Promise<TRecord[]> => {
		const order = new Map(updates.map((update) => [update.id, update.sortOrder]));
		store = [...store]
			.map((profile) => {
				const sortOrder = order.get(profile.id);
				return sortOrder !== undefined && options.withSortOrder
					? options.withSortOrder(profile, sortOrder)
					: profile;
			})
			.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		return [...store];
	});

	return {
		get store(): TRecord[] {
			return store;
		},
		set store(next: TRecord[]) {
			store = next;
		},
		get failUpdate(): boolean {
			return failUpdate;
		},
		set failUpdate(next: boolean) {
			failUpdate = next;
		},
		get failMessage(): string {
			return failMessage;
		},
		set failMessage(next: string) {
			failMessage = next;
		},
		listAllMock,
		createMock,
		updateMock,
		deleteMock,
		setDefaultMock,
		reorderMock,
		reset(): void {
			store = [];
			failUpdate = false;
			failMessage = baseFailMessage;
			listAllMock.mockClear();
			createMock.mockClear();
			updateMock.mockClear();
			deleteMock.mockClear();
			setDefaultMock.mockClear();
			reorderMock.mockClear();
		},
	};
}

export interface AutoKeyProviderPoolEntry {
	endpoint: string;
	hasStoredApiKey: boolean;
	name: string;
}

/**
 * Shared provider-list mock pool used by profile hooks to resolve
 * client-side auto-key hints.
 */
export function createAutoKeyProviderPool(initial: readonly AutoKeyProviderPoolEntry[] = []) {
	let rows: AutoKeyProviderPoolEntry[] = [...initial];
	const listProvidersMock = mock(async (): Promise<AutoKeyProviderPoolEntry[]> => [...rows]);

	return {
		get rows(): AutoKeyProviderPoolEntry[] {
			return rows;
		},
		set rows(next: AutoKeyProviderPoolEntry[]) {
			rows = [...next];
		},
		listProvidersMock,
		reset(): void {
			rows = [...initial];
			listProvidersMock.mockClear();
		},
	};
}

/**
 * Installs the key-echoing i18n seam shared by profile hook suites that
 * interpolate `{ name }` translation params.
 */
export function installProfileI18nSeam(): void {
	installI18nContextSeam({
		custom: {
			t: (key, params?) => {
				if (params && typeof params === "object" && "name" in params) {
					return `${key}:${String(params.name)}`;
				}
				return key;
			},
			tDynamic: (key) => key,
		},
	});
}

export interface HookProbe<T> {
	current: T | null;
}

/**
 * Renders a hook inside a minimal Probe component and keeps `probe.current`
 * synchronized with the latest render result. Dynamically imports
 * `@testing-library/react` so importing this module stays safe before `useDomEnv()`.
 */
export async function mountProfileHook<T>(useHook: () => T): Promise<HookProbe<T>> {
	const { render } = await import("@testing-library/react");
	const probe: HookProbe<T> = { current: null };
	function Probe() {
		probe.current = useHook();
		return null;
	}
	render(createElement(Probe));
	return probe;
}
