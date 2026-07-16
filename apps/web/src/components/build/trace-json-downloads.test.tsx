import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TraceJsonDownloads } from "./trace-json-downloads.js";

const NOOP = () => {};

vi.mock("../../i18n/context.js", () => ({
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

describe("TraceJsonDownloads", () => {
  it("offers separate request and response JSON downloads when a provider response exists", () => {
    const { getByRole } = render(
      <TraceJsonDownloads
        traceId="trace_1"
        requestPayload={{ messages: [{ role: "user", content: "Hi" }] }}
        providerResponse={{
          mode: "nonstream",
          steps: [{
            response: {
              id: "response_1",
              modelId: "model-a",
              headers: { "x-ratelimit-remaining-requests": "9" },
              body: { choices: [{ text: "Hello" }] },
            },
          }],
        }}
      />,
    );

    expect(getByRole("button", { name: "trace_json_request" })).toBeTruthy();
    expect(getByRole("button", { name: "trace_json_response" })).toBeTruthy();
  });

  it("omits the response download for preview and legacy traces without captured response data", () => {
    const { getByRole, queryByRole } = render(
      <TraceJsonDownloads
        traceId="trace_legacy"
        requestPayload={{ messages: [] }}
      />,
    );

    expect(getByRole("button", { name: "trace_json_request" })).toBeTruthy();
    expect(queryByRole("button", { name: "trace_json_response" })).toBeNull();
  });
});
