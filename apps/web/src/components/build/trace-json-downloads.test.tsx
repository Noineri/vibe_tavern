import { beforeAll, describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

const NOOP = () => {};

installI18nContextSeam();

let TraceJsonDownloads: typeof import("./trace-json-downloads.js").TraceJsonDownloads;
let render: typeof import("@testing-library/react").render;
beforeAll(async () => {
	({ render } = await import("@testing-library/react"));
	({ TraceJsonDownloads } = await import("./trace-json-downloads.js"));
});

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
