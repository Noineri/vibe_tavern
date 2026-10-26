/**
 * The sidechat's ONE open flag (SIDECHAT_PLAN, Wave 5 / SC-18a) — the shared
 * store both surfaces read and write through.
 *
 * Pins the unit's outcome at the seam (no component harness — the surfaces
 * themselves are pinned by `SidechatPanel.test.tsx` and
 * `PlayMode.sidechat.test.tsx`, which gain one outside-write test each):
 *   - two hook readers on the same chat follow one flag (write via one, the
 *     other updates; the stored value carries over under the same key);
 *   - a write from outside React (`getState().setOpen`) opens a closed reader;
 *   - a stored pre-unit value (seeded localStorage, the `"true"`/`"false"`
 *     encoding SC-14 established) is read — nothing was migrated;
 *   - switching chats reads the new chat's key, never carries one chat's
 *     state into another, and never cross-writes.
 *
 * Runner: bun:test with scoped happy-dom (the hook needs a React tree).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  readSidechatOpen,
  useSidechatOpen,
  useSidechatOpenStore,
  SIDECHAT_OPEN_KEY_PREFIX,
} from "./sidechat-open-store.js";

useDomEnv();

const { render, act, fireEvent } = await import("@testing-library/react");

function resetState(): void {
  localStorage.clear();
  useSidechatOpenStore.setState({ openByChat: {} });
}

beforeEach(resetState);
afterEach(resetState);

/** A hook reader with a toggle button (one surface's read+write pair). */
function Probe({ chatId, testId }: { chatId: string | null; testId: string }) {
  const [open, setOpen] = useSidechatOpen(chatId);
  return (
    <button type="button" data-testid={testId} onClick={() => setOpen(!open)}>
      {open ? "open" : "closed"}
    </button>
  );
}

// ── One flag ────────────────────────────────────────────────────────────────

describe("sidechat-open-store — one flag for every reader (SC-18a)", () => {
  it("two readers on the same chat follow one flag under the same persisted key", () => {
    const { getByTestId } = render(
      <>
        <Probe chatId="chat-a" testId="probe-one" />
        <Probe chatId="chat-a" testId="probe-two" />
      </>,
    );
    // Default closed (nothing stored, nothing in the map).
    expect(getByTestId("probe-one").textContent).toBe("closed");
    expect(getByTestId("probe-two").textContent).toBe("closed");

    fireEvent.click(getByTestId("probe-one"));
    expect(getByTestId("probe-one").textContent).toBe("open");
    expect(getByTestId("probe-two").textContent).toBe("open");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`)).toBe("true");

    fireEvent.click(getByTestId("probe-two"));
    expect(getByTestId("probe-one").textContent).toBe("closed");
    expect(getByTestId("probe-two").textContent).toBe("closed");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`)).toBe("false");
  });

  it("a write from outside React opens a closed reader", () => {
    const { getByTestId } = render(<Probe chatId="chat-a" testId="probe" />);
    expect(getByTestId("probe").textContent).toBe("closed");

    act(() => {
      useSidechatOpenStore.getState().setOpen("chat-a", true);
    });
    expect(getByTestId("probe").textContent).toBe("open");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`)).toBe("true");
  });
});

// ── Stored values carry over ────────────────────────────────────────────────

describe("sidechat-open-store — stored values carry over (SC-18a)", () => {
  it("a stored pre-unit value is read (same key, same encoding)", () => {
    localStorage.setItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`, "true");
    const { getByTestId } = render(<Probe chatId="chat-a" testId="probe" />);
    expect(getByTestId("probe").textContent).toBe("open");
    // The pure read agrees (the outside caller SC-18 imports reads the same).
    expect(readSidechatOpen("chat-a")).toBe(true);
    expect(readSidechatOpen("chat-b")).toBe(false);
    expect(readSidechatOpen(null)).toBe(false);
  });
});

// ── Chat-switch isolation (SC-14 semantics) ─────────────────────────────────

describe("sidechat-open-store — chat switches never carry state across (SC-18a)", () => {
  it("a switch reads the new chat's key and never cross-writes", () => {
    localStorage.setItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`, "true");
    localStorage.setItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-b`, "false");
    const { getByTestId, rerender } = render(<Probe chatId="chat-a" testId="probe" />);
    expect(getByTestId("probe").textContent).toBe("open");

    // Switch WITHOUT a remount — the hook re-reads under the new chat's key.
    rerender(<Probe chatId="chat-b" testId="probe" />);
    expect(getByTestId("probe").textContent).toBe("closed");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-b`)).toBe("false");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`)).toBe("true");

    // Writing under B never touches A's stored value.
    fireEvent.click(getByTestId("probe"));
    expect(getByTestId("probe").textContent).toBe("open");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-b`)).toBe("true");
    expect(localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}chat-a`)).toBe("true");

    // And back: A still reads its own stored value.
    rerender(<Probe chatId="chat-a" testId="probe" />);
    expect(getByTestId("probe").textContent).toBe("open");
  });
});
