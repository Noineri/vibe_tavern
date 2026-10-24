import { describe, expect, it } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { cleanup, render } = await import("@testing-library/react");
const { ConnectionAutoKeyHint } = await import("./connection-auto-key-hint.js");

describe("ConnectionAutoKeyHint", () => {
  it("keeps the caller test id, lock row styling, and message", () => {
    const view = render(
      React.createElement(ConnectionAutoKeyHint, { testId: "p11-key-source-hint", message: "key from Example" }),
    );
    const row = view.getByTestId("p11-key-source-hint");
    // Behavior change (FIXED_FONT_SIZE_AUDIT_REPORT verdict, step 3):
    // was `text-[11px]` → now `text-[calc(var(--ui-fs)-3px)]`.
    expect(row.getAttribute("class")).toBe("mt-1.5 flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t3");
    expect(row.textContent).toBe("key from Example");
    cleanup();
  });
});
