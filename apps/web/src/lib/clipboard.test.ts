// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { copyText } from "./clipboard.js";

describe("copyText", () => {
  const originalClipboard = globalThis.navigator.clipboard;
  const originalIsSecureContext = (globalThis as typeof globalThis & { isSecureContext?: boolean }).isSecureContext;

  beforeEach(() => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      clipboard: undefined,
    });
    Object.defineProperty(globalThis, "isSecureContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "isSecureContext", {
      value: originalIsSecureContext,
      configurable: true,
      writable: true,
    });
  });

  test("secure context + clipboard API succeeds → ok", async () => {
    (globalThis as typeof globalThis & { isSecureContext: boolean }).isSecureContext = true;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      clipboard: { writeText },
    });

    const result = await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result).toEqual({ ok: true });
  });

  test("secure context + clipboard API rejects → error: rejected", async () => {
    (globalThis as typeof globalThis & { isSecureContext: boolean }).isSecureContext = true;
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      clipboard: { writeText },
    });

    const result = await copyText("hello");

    expect(result).toEqual({ ok: false, error: "rejected" });
  });

  test("non-secure context falls back to execCommand('copy')", async () => {
    (globalThis as typeof globalThis & { isSecureContext: boolean }).isSecureContext = false;
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    const result = await copyText("fallback text");

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(result).toEqual({ ok: true });
  });

  test("non-secure context + failed execCommand → error: unsupported", async () => {
    (globalThis as typeof globalThis & { isSecureContext: boolean }).isSecureContext = false;
    const execCommand = vi.fn().mockReturnValue(false);
    document.execCommand = execCommand;

    const result = await copyText("fallback text");

    expect(result).toEqual({ ok: false, error: "unsupported" });
  });

  test("server-side (no window) → error: unsupported", async () => {
    const result = await copyText("n/a");
    expect(result).toEqual({ ok: false, error: "unsupported" });
  });
});
