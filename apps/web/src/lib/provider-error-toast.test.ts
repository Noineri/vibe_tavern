import { describe, expect, test } from "bun:test";
import { ProviderStreamError } from "../api/provider-stream-error.js";
import type { TFunc } from "../i18n/locale-helpers.js";
import { getProviderErrorText } from "./provider-error-toast.js";

const translate: TFunc = (key) => `translated:${key}`;

describe("getProviderErrorText", () => {
  test("uses the same provider-stream message shown by the toast", () => {
    expect(getProviderErrorText(new ProviderStreamError("upstream rate limit", "rate_limit"), translate))
      .toBe("upstream rate limit");
  });

  test("uses the toast fallback for a non-Error failure", () => {
    expect(getProviderErrorText({ failure: "opaque" }, translate)).toBe("translated:message_send_failed");
  });
});
