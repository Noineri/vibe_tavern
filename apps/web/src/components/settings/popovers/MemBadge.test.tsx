/**
 * Contracts for `MemBadge` pulse — the W7 / SPC-7b visual feedback.
 *
 * The badge is idle by default; when the chat-notifications store records a
 * `summary.generated` pulse it gains the `mem-badge-pulse` class (the CSS
 * keyframe animation); a click consumes the pulse and clears it.
 *
 * The store is driven via `getState()` directly — no vi.mock needed.
 */
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/react";
import { act } from "react";

vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { MemBadge } from "./MemBadge.js";
import { useChatNotifications } from "../../../stores/index.js";

const flush = async () => {
  // External store updates (zustand getState().set…) schedule a React re-render
  // outside React's own event handler; flush it so the DOM reflects the new state.
  await act(async () => {
    await Promise.resolve();
  });
};

describe("MemBadge — SPC-7b pulse", () => {
  it("is idle by default", () => {
    const { getByRole } = render(<MemBadge label="Memory" onClick={() => {}} />);
    const badge = getByRole("status");
    expect(badge).not.toHaveClass("mem-badge-pulse");
  });

  it("pulses when a summary notification lands and clears on click", async () => {
    const { getByRole } = render(<MemBadge label="Memory" onClick={() => {}} />);
    const badge = getByRole("status");

    useChatNotifications.getState().triggerSummaryPulse("s-1", "T1–T10");
    await flush();
    expect(badge).toHaveClass("mem-badge-pulse");
    expect(badge).toHaveAttribute("aria-label", "Memory — new");

    fireEvent.click(badge);
    await flush();
    expect(badge).not.toHaveClass("mem-badge-pulse");
  });
});
