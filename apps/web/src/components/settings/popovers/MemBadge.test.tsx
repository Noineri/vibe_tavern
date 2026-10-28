/**
 * Contracts for `MemBadge` — the W7 auto-summary lifecycle indicator.
 *
 * Three states mirror the backend notifications:
 *   idle       → green dot
 *   generating → spinner (CSS animate-spin)
 *   ready      → checkmark (Icons.checkCircle), auto-reverts to idle after 2 s
 *
 * The store is driven via `getState()` directly — no module mock needed.
 * CustomTooltip is mocked out to isolate from radix.
 */
import { beforeEach, describe, it, expect, mock } from "bun:test";

import { act, type ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { MemBadge } = await import("./MemBadge.js");
const { useChatNotifications } = await import("../../../stores/index.js");
const { useChatStore } = await import("../../../stores/chat-store.js");
const { brandId } = await import("@vibe-tavern/domain");
import type { ChatId } from "@vibe-tavern/domain";

beforeEach(() => {
	useChatNotifications.setState({ byChat: {}, holdsByChat: {} });
	useChatStore.getState().setActiveChatId(brandId<ChatId>("chat-1"));
});

const flush = async () => {
	await act(async () => {
		await Promise.resolve();
	});
};

describe("MemBadge — W7 lifecycle indicator", () => {
	it("shows the idle dot by default", () => {
		const { container } = render(<MemBadge label="Memory" onClick={() => {}} />);
		expect(container.querySelector(".animate-spin")).toBeNull();
		expect(container.querySelector("polyline")).toBeNull();
		expect(container.querySelector(".bg-success")).not.toBeNull();
	});

	it("shows a spinner while generating", async () => {
		const { container } = render(<MemBadge label="Memory" onClick={() => {}} />);
		await act(async () => { useChatNotifications.getState().setGenerating("chat-1"); });
		await flush();
		expect(container.querySelector(".animate-spin")).not.toBeNull();
		expect(container.querySelector("polyline")).toBeNull();
	});

	it("shows a checkmark on ready, then reverts to idle on click", async () => {
		const { container, getByRole } = render(<MemBadge label="Memory" onClick={() => {}} />);
		await act(async () => { useChatNotifications.getState().setReady("chat-1", "s-1", "T1–T10"); });
		await flush();
		expect(container.querySelector("polyline")).not.toBeNull();

		fireEvent.click(getByRole("status"));
		await flush();
		expect(container.querySelector("polyline")).toBeNull();
		expect(container.querySelector(".bg-success")).not.toBeNull();
	});

	it("opening memory during generation preserves the spinner", async () => {
		const onClick = mock();
		const { container, getByRole } = render(<MemBadge label="Memory" onClick={onClick} />);
		await act(async () => { useChatNotifications.getState().setGenerating("chat-1"); });
		fireEvent.click(getByRole("status"));
		await flush();
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".animate-spin")).not.toBeNull();
	});

	it("switching chats selects only that chat's indicator and keeps background completion", async () => {
		const { container } = render(<MemBadge label="Memory" onClick={() => {}} />);
		await act(async () => { useChatNotifications.getState().setGenerating("chat-1"); });
		await act(async () => { useChatStore.getState().setActiveChatId(brandId<ChatId>("chat-2")); });
		expect(container.querySelector(".animate-spin")).toBeNull();
		await act(async () => { useChatNotifications.getState().setReady("chat-1", "s-1", "A"); });
		expect(container.querySelector("polyline")).toBeNull();
		await act(async () => { useChatStore.getState().setActiveChatId(brandId<ChatId>("chat-1")); });
		expect(container.querySelector("polyline")).not.toBeNull();
	});

	it("a stale checkmark reset cannot dismiss a newer completion or a running summary", () => {
		const store = useChatNotifications.getState();
		store.setReady("chat-1", "s-1", "First");
		const seq = useChatNotifications.getState().byChat["chat-1"]?.ready?.seq;
		store.setReady("chat-1", "s-2", "Second");
		store.setIdle("chat-1", seq);
		expect(useChatNotifications.getState().byChat["chat-1"]?.ready?.summaryId).toBe("s-2");
		store.setGenerating("chat-1");
		store.setIdle("chat-1");
		expect(useChatNotifications.getState().byChat["chat-1"]?.status).toBe("generating");
	});
});
