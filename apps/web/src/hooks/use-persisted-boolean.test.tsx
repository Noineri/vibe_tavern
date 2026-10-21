/**
 * Contracts for `use-persisted-boolean.ts` — the boolean hook and its numeric
 * sibling (SIDECHAT_PLAN, Wave 4 / SC-14).
 *
 * Pins the pre-SC-14 behavior first (read once on mount, write on change,
 * absent/unparseable handling), then the SC-14 behavior change: the hook
 * RE-READS when `key` changes and never writes the previous key's value under
 * the new key (the sidechat panel is not remounted on a chat switch, so with a
 * per-chat key chat A's open state would show in chat B and then be persisted
 * under B's key). The numeric sibling shares the rule, plus clamp-on-read.
 */
import { beforeEach, describe, expect, it } from "bun:test";

import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { renderHook, act } = await import("@testing-library/react");
const { usePersistedBoolean, usePersistedNumber } = await import("./use-persisted-boolean.js");

beforeEach(() => {
  localStorage.clear();
});

describe("usePersistedBoolean", () => {
  it("reads the stored value; an absent key falls back to the default", () => {
    localStorage.setItem("hb:stored", "true");
    const { result: stored } = renderHook(() => usePersistedBoolean("hb:stored", false));
    expect(stored.current[0]).toBe(true);

    const { result: absentTrue } = renderHook(() => usePersistedBoolean("hb:absent-true", true));
    expect(absentTrue.current[0]).toBe(true);
    const { result: absentFalse } = renderHook(() => usePersistedBoolean("hb:absent-false", false));
    expect(absentFalse.current[0]).toBe(false);
  });

  it("a non-\"true\" stored value reads as false", () => {
    localStorage.setItem("hb:other", "yes");
    const { result } = renderHook(() => usePersistedBoolean("hb:other", true));
    expect(result.current[0]).toBe(false);
  });

  it("writes on every change (updater functions included)", () => {
    const { result } = renderHook(() => usePersistedBoolean("hb:write", false));
    act(() => {
      result.current[1](true);
    });
    expect(localStorage.getItem("hb:write")).toBe("true");
    act(() => {
      result.current[1]((v) => !v);
    });
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem("hb:write")).toBe("false");
  });

  it("re-reads when the key changes and never writes the old value under the new key", () => {
    localStorage.setItem("hb:chat-a", "true");
    localStorage.setItem("hb:chat-b", "false");
    const { result, rerender } = renderHook(({ key }) => usePersistedBoolean(key, false), {
      initialProps: { key: "hb:chat-a" },
    });
    expect(result.current[0]).toBe(true);

    // Chat A (open) → chat B (stored closed): B shows closed immediately —
    // no stale frame — and B's stored value is untouched (never "true").
    rerender({ key: "hb:chat-b" });
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem("hb:chat-b")).toBe("false");
    expect(localStorage.getItem("hb:chat-a")).toBe("true");
  });

  it("a key with no stored value falls back to the default on switch", () => {
    localStorage.setItem("hb:chat-a", "true");
    const { result, rerender } = renderHook(({ key }) => usePersistedBoolean(key, false), {
      initialProps: { key: "hb:chat-a" },
    });
    expect(result.current[0]).toBe(true);

    rerender({ key: "hb:chat-fresh" });
    expect(result.current[0]).toBe(false);
  });

  it("toggling after a switch persists under the new key only", () => {
    localStorage.setItem("hb:chat-a", "true");
    localStorage.setItem("hb:chat-b", "false");
    const { result, rerender } = renderHook(({ key }) => usePersistedBoolean(key, false), {
      initialProps: { key: "hb:chat-a" },
    });
    rerender({ key: "hb:chat-b" });
    act(() => {
      result.current[1](true);
    });
    expect(localStorage.getItem("hb:chat-b")).toBe("true");
    expect(localStorage.getItem("hb:chat-a")).toBe("true");
  });
});

describe("usePersistedNumber", () => {
  it("restores the stored value; an absent key falls back to the default", () => {
    localStorage.setItem("hn:stored", "450");
    const { result: stored } = renderHook(() => usePersistedNumber("hn:stored", 400));
    expect(stored.current[0]).toBe(450);

    const { result: absent } = renderHook(() => usePersistedNumber("hn:absent", 400));
    expect(absent.current[0]).toBe(400);
  });

  it("an unparseable stored value falls back to the default", () => {
    localStorage.setItem("hn:bad", "abc");
    const { result } = renderHook(() => usePersistedNumber("hn:bad", 400));
    expect(result.current[0]).toBe(400);
  });

  it("clamps on read (min and max)", () => {
    localStorage.setItem("hn:low", "100");
    const { result: low } = renderHook(() => usePersistedNumber("hn:low", 400, { min: 320 }));
    expect(low.current[0]).toBe(320);

    localStorage.setItem("hn:high", "5000");
    const { result: high } = renderHook(() => usePersistedNumber("hn:high", 400, { max: 800 }));
    expect(high.current[0]).toBe(800);
  });

  it("the setter clamps and persists the clamped value", () => {
    const { result } = renderHook(() => usePersistedNumber("hn:set", 400, { min: 320, max: 800 }));
    act(() => {
      result.current[1](50);
    });
    expect(result.current[0]).toBe(320);
    expect(localStorage.getItem("hn:set")).toBe("320");
    act(() => {
      result.current[1](9000);
    });
    expect(result.current[0]).toBe(800);
    expect(localStorage.getItem("hn:set")).toBe("800");
  });

  it("a non-finite setter value falls back to the default", () => {
    const { result } = renderHook(() => usePersistedNumber("hn:finite", 400, { min: 320 }));
    act(() => {
      result.current[1](Number.NaN);
    });
    expect(result.current[0]).toBe(400);
  });

  it("re-reads when the key changes and never writes the old value under the new key", () => {
    localStorage.setItem("hn:key-a", "700");
    localStorage.setItem("hn:key-b", "450");
    const { result, rerender } = renderHook(({ key }) => usePersistedNumber(key, 400), {
      initialProps: { key: "hn:key-a" },
    });
    expect(result.current[0]).toBe(700);

    rerender({ key: "hn:key-b" });
    expect(result.current[0]).toBe(450);
    expect(localStorage.getItem("hn:key-b")).toBe("450");
    expect(localStorage.getItem("hn:key-a")).toBe("700");
  });
});
