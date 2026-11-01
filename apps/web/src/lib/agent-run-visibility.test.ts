import { expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { isAgentThreadVisible, registerVisibleAgentThread, useVisibleAgentThread } from "./agent-run-visibility.js";
useDomEnv();
const { renderHook } = await import("@testing-library/react");

test("visible view leases are independently scoped and old cleanup is idempotent", () => {
  const first = registerVisibleAgentThread("script", "lease-thread");
  const second = registerVisibleAgentThread("script", "lease-thread");
  try {
    first(); first();
    expect(isAgentThreadVisible("script", "lease-thread")).toBe(true);
    expect(isAgentThreadVisible("experience", "lease-thread")).toBe(false);
    second();
    expect(isAgentThreadVisible("script", "lease-thread")).toBe(false);
  } finally { first(); second(); }
});

test("a mounted hidden pane is not on screen; tab/owner changes and unmount release visibility", () => {
  const h = renderHook(({ id, onScreen }) => useVisibleAgentThread("sidechat-ooc", id, onScreen), {
    initialProps: { id: "first-thread", onScreen: false },
  });
  try {
    expect(isAgentThreadVisible("sidechat-ooc", "first-thread")).toBe(false);
    h.rerender({ id: "first-thread", onScreen: true });
    expect(isAgentThreadVisible("sidechat-ooc", "first-thread")).toBe(true);
    h.rerender({ id: "second-thread", onScreen: true });
    expect(isAgentThreadVisible("sidechat-ooc", "first-thread")).toBe(false);
    expect(isAgentThreadVisible("sidechat-ooc", "second-thread")).toBe(true);
    h.rerender({ id: "second-thread", onScreen: false });
    expect(isAgentThreadVisible("sidechat-ooc", "second-thread")).toBe(false);
    h.rerender({ id: "second-thread", onScreen: true });
  } finally { h.unmount(); }
  expect(isAgentThreadVisible("sidechat-ooc", "second-thread")).toBe(false);
});
