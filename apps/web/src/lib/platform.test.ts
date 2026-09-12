import { describe, expect, test } from "bun:test";

import { isAndroidDevice, isAndroidUserAgent } from "./platform.js";

describe("platform signals (TPE-18c)", () => {
  test("android UA matches (any case); desktop UAs do not", () => {
    expect(
      isAndroidUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"),
    ).toBe(true);
    expect(isAndroidUserAgent("android")).toBe(true);
    expect(
      isAndroidUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"),
    ).toBe(false);
    expect(
      isAndroidUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toBe(false);
    expect(isAndroidUserAgent("")).toBe(false);
  });

  test("isAndroidDevice answers a boolean in this runtime", () => {
    expect(typeof isAndroidDevice()).toBe("boolean");
  });
});
