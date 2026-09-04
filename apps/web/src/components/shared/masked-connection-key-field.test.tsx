import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { MaskedConnectionKeyField } = await import("./masked-connection-key-field.js");

function renderField(overrides: Record<string, unknown> = {}) {
  const onChange = mock(() => {});
  const view = render(
    React.createElement(MaskedConnectionKeyField, {
      value: "sk-secret",
      onChange,
      placeholder: "plain-placeholder",
      stored: false,
      fieldTestId: "p11-field-api-key",
      toggleTestId: "p11-field-api-key-toggle",
      statusTestId: "p11-field-api-key-status",
      storedPlaceholder: "stored-placeholder",
      storedStatus: "stored-status",
      showLabel: "show-label",
      hideLabel: "hide-label",
      ...overrides,
    }),
  );
  return { onChange, view };
}

describe("MaskedConnectionKeyField", () => {
  it("keeps the caller test-id stem, masking, and plain placeholder", () => {
    const { view } = renderField();
    const input = view.getByTestId("p11-field-api-key") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");
    expect(input.value).toBe("sk-secret");
    expect(input.getAttribute("placeholder")).toBe("plain-placeholder");
    expect(view.getByTestId("p11-field-api-key-toggle").getAttribute("aria-label")).toBe("show-label");
    expect(view.queryByTestId("p11-field-api-key-status")).toBeNull();
    cleanup();
  });

  it("typing passes the new key value through and the toggle flips masking", async () => {
    const { onChange, view } = renderField({ value: "" });
    const input = view.getByTestId("p11-field-api-key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-key" } });
    expect(onChange).toHaveBeenCalled();
    expect((onChange.mock.calls[0] as unknown[])[0]).toBe("new-key");

    const toggle = view.getByTestId("p11-field-api-key-toggle") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(input.getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe("hide-label");
    cleanup();
  });

  it("an empty stored key shows the caller stored placeholder and status", () => {
    const { view } = renderField({ value: "", stored: true });
    const input = view.getByTestId("p11-field-api-key") as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBe("stored-placeholder");
    expect(view.getByTestId("p11-field-api-key-status").textContent).toBe("stored-status");
    cleanup();
  });
});
