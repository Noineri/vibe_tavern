import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const { useDomEnv } = await import("../../test/dom-env.js");
GlobalRegistrator.unregister();

useDomEnv();

let copyText: typeof import("./clipboard.js").copyText;
let originalNavigator: PropertyDescriptor | undefined;
let originalIsSecureContext: PropertyDescriptor | undefined;
let originalExecCommand: PropertyDescriptor | undefined;

beforeAll(async () => {
  ({ copyText } = await import("./clipboard.js"));
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  originalIsSecureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
});

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

describe("copyText", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
      ...globalThis.navigator,
      clipboard: undefined,
      },
    });
    Object.defineProperty(globalThis, "isSecureContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    restoreProperty(globalThis, "navigator", originalNavigator);
    restoreProperty(globalThis, "isSecureContext", originalIsSecureContext);
    restoreProperty(document, "execCommand", originalExecCommand);
  });

  test("secure context + clipboard API succeeds → ok", async () => {
    Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true, writable: true });
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(globalThis, "navigator", {
      value: { ...globalThis.navigator, clipboard: { writeText } },
      configurable: true,
      writable: true,
    });

    const result = await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result).toEqual({ ok: true });
  });

  test("secure context + clipboard API rejects → error: rejected", async () => {
    Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true, writable: true });
    const writeText = mock(() => Promise.reject(new Error("denied")));
    Object.defineProperty(globalThis, "navigator", {
      value: { ...globalThis.navigator, clipboard: { writeText } },
      configurable: true,
      writable: true,
    });

    const result = await copyText("hello");

    expect(result).toEqual({ ok: false, error: "rejected" });
  });

  test("non-secure context falls back to execCommand('copy')", async () => {
    Object.defineProperty(globalThis, "isSecureContext", { value: false, configurable: true, writable: true });
    const execCommand = mock(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });

    const result = await copyText("fallback text");

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(result).toEqual({ ok: true });
  });

  test("non-secure context + failed execCommand → error: unsupported", async () => {
    Object.defineProperty(globalThis, "isSecureContext", { value: false, configurable: true, writable: true });
    const execCommand = mock(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });

    const result = await copyText("fallback text");

    expect(result).toEqual({ ok: false, error: "unsupported" });
  });

  test("server-side (no window) → error: unsupported", async () => {
    const result = await copyText("n/a");
    expect(result).toEqual({ ok: false, error: "unsupported" });
  });
});
