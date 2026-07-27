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
import { describe, it, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
	CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { MemBadge } = await import("./MemBadge.js");
const { useChatNotifications } = await import("../../../stores/index.js");

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
		useChatNotifications.getState().setGenerating();
		await flush();
		expect(container.querySelector(".animate-spin")).not.toBeNull();
		expect(container.querySelector("polyline")).toBeNull();
	});

	it("shows a checkmark on ready, then reverts to idle on click", async () => {
		const { container, getByRole } = render(<MemBadge label="Memory" onClick={() => {}} />);
		useChatNotifications.getState().setReady("s-1", "T1–T10");
		await flush();
		expect(container.querySelector("polyline")).not.toBeNull();

		fireEvent.click(getByRole("status"));
		await flush();
		expect(container.querySelector("polyline")).toBeNull();
		expect(container.querySelector(".bg-success")).not.toBeNull();
	});
});
