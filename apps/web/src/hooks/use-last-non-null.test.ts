import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLastNonNull } from "./use-last-non-null.js";

describe("useLastNonNull", () => {
  it("returns null before any non-null value has been seen", () => {
    const { result } = renderHook(() => useLastNonNull<string>(null));
    expect(result.current).toBeNull();
  });

  it("returns the live value while it is non-null", () => {
    const { result, rerender } = renderHook(({ v }) => useLastNonNull(v), {
      initialProps: { v: "a" as string | null },
    });
    expect(result.current).toBe("a");
    rerender({ v: "b" });
    expect(result.current).toBe("b");
  });

  it("retains the last non-null value once the current goes null (exit-transition freeze)", () => {
    // The core invariant for the ActionSheet exit-animation fix: when the
    // caller nulls its open-state (menuId → null) to close the sheet, the
    // derived title/items must keep rendering from the last non-null id so
    // the closing sheet does not empty mid-exit.
    const { result, rerender } = renderHook(({ v }) => useLastNonNull(v), {
      initialProps: { v: "char-1" as string | null },
    });
    expect(result.current).toBe("char-1");

    // Close → null. The snapshot holds.
    rerender({ v: null });
    expect(result.current).toBe("char-1");

    // Stays null-safe while closed.
    rerender({ v: null });
    expect(result.current).toBe("char-1");
  });

  it("updates to the new live value when re-opened with a different id", () => {
    const { result, rerender } = renderHook(({ v }) => useLastNonNull(v), {
      initialProps: { v: "a" as string | null },
    });
    rerender({ v: null });
    expect(result.current).toBe("a");
    // Re-open a different item → live value wins, snapshot refreshes.
    rerender({ v: "b" });
    expect(result.current).toBe("b");
    rerender({ v: null });
    expect(result.current).toBe("b");
  });

  it("works for object values (e.g. a {chatId,branchId,label} branch handle)", () => {
    const handle = { chatId: "c1", branchId: "b1", label: "main" };
    const { result, rerender } = renderHook(
      ({ v }) => useLastNonNull(v),
      { initialProps: { v: handle as { chatId: string; branchId: string; label: string } | null } },
    );
    expect(result.current).toBe(handle);
    rerender({ v: null });
    expect(result.current).toBe(handle);
  });

  it("never treats a falsy-but-non-null value (0, '', false) as absent", () => {
    // `null` is the closed sentinel; other falsy values are real and must
    // be returned as-is (the hook uses `!== null`, not truthiness).
    const { result } = renderHook(() => useLastNonNull<number>(0));
    expect(result.current).toBe(0);
    const { result: empty } = renderHook(() => useLastNonNull<string>(""));
    expect(empty.current).toBe("");
  });
});
