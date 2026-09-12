import { describe, expect, it } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { cleanup, render } = await import("@testing-library/react");
const { ConnectionProbeStatus } = await import("./connection-probe-status.js");

function renderStatus(ok: boolean) {
  return render(
    React.createElement(ConnectionProbeStatus, {
      ok,
      successTestId: "p11-probe-success",
      failureTestId: "p11-probe-failure",
      successText: "connected",
      failureText: "not connected",
    }),
  );
}

describe("ConnectionProbeStatus", () => {
  it("renders only the success badge for a passing probe", () => {
    const view = renderStatus(true);
    const badge = view.getByTestId("p11-probe-success");
    expect(badge.getAttribute("class")).toBe("mt-3");
    expect(badge.textContent).toBe("connected");
    expect(view.queryByTestId("p11-probe-failure")).toBeNull();
    cleanup();
  });

  it("renders only the failure badge for a failing probe", () => {
    const view = renderStatus(false);
    const badge = view.getByTestId("p11-probe-failure");
    expect(badge.getAttribute("class")).toBe("mt-3");
    expect(badge.textContent).toBe("not connected");
    expect(view.queryByTestId("p11-probe-success")).toBeNull();
    cleanup();
  });
});
