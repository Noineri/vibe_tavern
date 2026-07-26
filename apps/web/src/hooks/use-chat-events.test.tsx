/**
 * Contracts for `useChatEvents` — the per-chat SSE subscription (W7 / SPC-7b).
 *
 * Pins the subscription lifecycle, NOT the forwarding logic (that lives in the
 * backend chat-events-feature.test.ts). Three things must hold:
 *   1. an EventSource opens for the active chat and closes on unmount;
 *   2. changing chatId closes the previous source and opens a new one;
 *   3. a null activeChatId opens nothing.
 *
 * `EventSource` is stubbed globally (happy-dom's EventSource has no useful
 * constructor surface for this); i18n's `useT` is mocked so the hook does not
 * need a provider.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../i18n/context.js");
mock.module("../i18n/context.js", () => ({
	...realI18n,
	useT: () => ({ t: (k: string) => k, setLocale: () => {} }),
}));

class MockEventSource {
	static instances: MockEventSource[] = [];
	url: string;
	closed = false;
	addEventListener = mock();
	constructor(url: string) {
		this.url = url;
		MockEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
	}
}

beforeEach(() => {
	MockEventSource.instances = [];
	globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

const { useChatEvents } = await import("./use-chat-events.js");

describe("useChatEvents — SPC-7b", () => {
	it("opens an EventSource for the active chat and closes it on unmount", () => {
		const { unmount } = renderHook(({ id }) => useChatEvents(id), {
			initialProps: { id: "chat-1" as string | null },
		});

		expect(MockEventSource.instances).toHaveLength(1);
		expect(MockEventSource.instances[0]!.url).toContain("/api/chats/chat-1/events");
		// The three auto-summary lifecycle listeners are registered.
		for (const kind of ["summary.started", "summary.generated", "summary.failed"]) {
			expect(MockEventSource.instances[0]!.addEventListener).toHaveBeenCalledWith(kind, expect.any(Function));
		}

		unmount();
		expect(MockEventSource.instances[0]!.closed).toBe(true);
	});

	it("closes the previous source and opens a new one when chatId changes", () => {
		const { rerender } = renderHook(({ id }) => useChatEvents(id), {
			initialProps: { id: "chat-1" as string | null },
		});
		expect(MockEventSource.instances).toHaveLength(1);

		rerender({ id: "chat-2" });
		expect(MockEventSource.instances).toHaveLength(2);
		expect(MockEventSource.instances[0]!.closed).toBe(true);
		expect(MockEventSource.instances[1]!.url).toContain("/api/chats/chat-2/events");
	});

	it("opens nothing when activeChatId is null", () => {
		renderHook(() => useChatEvents(null));
		expect(MockEventSource.instances).toHaveLength(0);
	});
});
