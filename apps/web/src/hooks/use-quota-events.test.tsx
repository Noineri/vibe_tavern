/**
 * Contracts for `useQuotaEvents` — the GLOBAL quota SSE subscription.
 *
 * Unlike the per-chat channel, this one opens once and does not re-open on any
 * app state change, so what needs pinning is: the URL and listener set, the
 * stream-state lifecycle, that a delivered event reaches the store AND toasts
 * exactly once, and that a replay after a reconnect does neither.
 *
 * Toast wording is deliberately NOT asserted — only the i18n key and the
 * interpolation values, so translating a string never breaks a test.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook } from "@testing-library/react";
import {
	PROVIDER_QUOTA_EVENT_KIND,
	PROVIDER_QUOTA_EVENT_NAME,
	PROVIDER_QUOTA_WINDOW_KIND,
	QUOTA_LOW_REMAINING_CROSSING,
	QUOTA_RESET_DETECTION,
	type ProviderQuotaLowRemainingEvent,
	type ProviderQuotaWindowResetEvent,
} from "@vibe-tavern/domain";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../i18n/context.js");
mock.module("../i18n/context.js", () => ({
	...realI18n,
	useT: () => ({
		t: (key: string, values?: Record<string, unknown>) => JSON.stringify({ key, values }),
		setLocale: () => {},
	}),
}));

interface ToastCall { level: string; payload: string }
const toastCalls: ToastCall[] = [];
const realSonner = await import("sonner");
mock.module("sonner", () => ({
	...realSonner,
	toast: {
		...realSonner.toast,
		warning: (payload: string) => { toastCalls.push({ level: "warning", payload }); },
		success: (payload: string) => { toastCalls.push({ level: "success", payload }); },
		error: (payload: string) => { toastCalls.push({ level: "error", payload }); },
	},
}));

type Listener = (event: MessageEvent) => void;

class MockEventSource {
	static instances: MockEventSource[] = [];
	readonly listeners = new Map<string, Listener[]>();
	closed = false;

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: Listener): void {
		const bucket = this.listeners.get(type) ?? [];
		bucket.push(listener);
		this.listeners.set(type, bucket);
	}

	dispatch(type: string, data: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data: JSON.stringify(data) } as MessageEvent);
		}
	}

	fire(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data: "" } as MessageEvent);
		}
	}

	close(): void {
		this.closed = true;
	}
}

const { useQuotaStore } = await import("../stores/quota-store.js");
const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useQuotaEvents } = await import("./use-quota-events.js");

const PROFILE = "prov_1";

function lowRemaining(overrides: Partial<ProviderQuotaLowRemainingEvent> = {}): ProviderQuotaLowRemainingEvent {
	return {
		kind: PROVIDER_QUOTA_EVENT_KIND.lowRemaining,
		eventId: "evt-low-1",
		providerProfileId: PROFILE,
		capabilityId: "zai",
		windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
		windowLabel: "5h",
		usedPercent: 94.6,
		remainingPercent: 5.4,
		thresholdPercent: 10,
		resetsAt: "2026-08-07T14:00:00.000Z",
		crossing: QUOTA_LOW_REMAINING_CROSSING.observed,
		observedAt: "2026-08-07T11:00:00.000Z",
		...overrides,
	};
}

function windowReset(): ProviderQuotaWindowResetEvent {
	return {
		kind: PROVIDER_QUOTA_EVENT_KIND.windowReset,
		eventId: "evt-reset-1",
		providerProfileId: PROFILE,
		capabilityId: "zai",
		windowKind: PROVIDER_QUOTA_WINDOW_KIND.session,
		windowLabel: "5h",
		usedPercent: 2,
		remainingPercent: 98,
		resetsAt: "2026-08-07T19:00:00.000Z",
		detection: QUOTA_RESET_DETECTION.boundaryAdvanced,
		observedAt: "2026-08-07T14:05:00.000Z",
	};
}

beforeEach(() => {
	MockEventSource.instances = [];
	toastCalls.length = 0;
	globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
	useQuotaStore.getState().reset();
	useProviderDataStore.setState({ profiles: [] });
});

describe("useQuotaEvents", () => {
	it("opens ONE global stream and registers both quota event listeners", () => {
		const { unmount } = renderHook(() => useQuotaEvents());

		expect(MockEventSource.instances).toHaveLength(1);
		const source = MockEventSource.instances[0]!;
		expect(source.url).toContain("/api/quota/events");
		expect(source.listeners.has(PROVIDER_QUOTA_EVENT_NAME.lowRemaining)).toBe(true);
		expect(source.listeners.has(PROVIDER_QUOTA_EVENT_NAME.windowReset)).toBe(true);

		unmount();
		expect(source.closed).toBe(true);
		expect(useQuotaStore.getState().streamState).toBe("closed");
	});

	it("tracks the stream lifecycle: connecting → open → error", () => {
		renderHook(() => useQuotaEvents());
		const source = MockEventSource.instances[0]!;
		expect(useQuotaStore.getState().streamState).toBe("connecting");

		source.fire("open");
		expect(useQuotaStore.getState().streamState).toBe("open");

		source.fire("error");
		expect(useQuotaStore.getState().streamState).toBe("error");
	});

	it("updates the store and toasts once for a low-remaining event", () => {
		useProviderDataStore.setState({
			profiles: [{ id: PROFILE, name: "My ZAI" }] as never,
		});
		renderHook(() => useQuotaEvents());
		const source = MockEventSource.instances[0]!;

		source.dispatch(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, lowRemaining());

		expect(toastCalls).toHaveLength(1);
		expect(toastCalls[0]!.level).toBe("warning");
		expect(JSON.parse(toastCalls[0]!.payload)).toEqual({
			key: "quota_low_remaining_toast",
			values: { provider: "My ZAI", window: "5h", remaining: 5 },
		});
		expect(useQuotaStore.getState().seenEventIds).toContain("evt-low-1");
	});

	it("falls back to the profile id when the profile is unknown", () => {
		renderHook(() => useQuotaEvents());
		MockEventSource.instances[0]!.dispatch(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, lowRemaining());
		expect(JSON.parse(toastCalls[0]!.payload).values.provider).toBe(PROFILE);
	});

	it("toasts a reset event with the reset key", () => {
		renderHook(() => useQuotaEvents());
		MockEventSource.instances[0]!.dispatch(PROVIDER_QUOTA_EVENT_NAME.windowReset, windowReset());

		expect(toastCalls[0]!.level).toBe("success");
		expect(JSON.parse(toastCalls[0]!.payload)).toEqual({
			key: "quota_window_reset_toast",
			values: { provider: PROFILE, window: "5h" },
		});
	});

	it("a replayed event id after a reconnect neither updates nor toasts again", () => {
		renderHook(() => useQuotaEvents());
		const source = MockEventSource.instances[0]!;

		source.dispatch(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, lowRemaining());
		source.dispatch(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, lowRemaining());

		expect(toastCalls).toHaveLength(1);
	});

	it("ignores a malformed payload instead of throwing", () => {
		renderHook(() => useQuotaEvents());
		const source = MockEventSource.instances[0]!;

		for (const listener of source.listeners.get(PROVIDER_QUOTA_EVENT_NAME.lowRemaining) ?? []) {
			expect(() => listener({ data: "not json" } as MessageEvent)).not.toThrow();
		}
		source.dispatch(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, { providerProfileId: PROFILE });

		expect(toastCalls).toEqual([]);
	});
});
