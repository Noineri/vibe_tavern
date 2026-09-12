import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
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
const { TtsApiKeyField } = await import("./TtsApiKeyField.js");

describe("TtsApiKeyField", () => {
  it("renders masked by default and passes value through", () => {
    const onChange = mock(() => {});
    const view = render(React.createElement(TtsApiKeyField as never, { value: "sk-secret", onChange, placeholder: "sk-..." } as never));
    const input = view.getByTestId("tts-field-api-key") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");
    expect(input.value).toBe("sk-secret");
    expect(input.getAttribute("placeholder")).toBe("sk-...");
    cleanup();
  });

  it("typing calls onChange with the new value", () => {
    const onChange = mock(() => {});
    const view = render(React.createElement(TtsApiKeyField as never, { value: "", onChange } as never));
    const input = view.getByTestId("tts-field-api-key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new-key" } });
    expect(onChange).toHaveBeenCalled();
    expect((onChange.mock.calls[0] as unknown[])[0]).toBe("new-key");
    cleanup();
  });

  it("clicking the toggle flips between password and text", async () => {
    const onChange = mock(() => {});
    const view = render(React.createElement(TtsApiKeyField as never, { value: "k", onChange } as never));
    const input = view.getByTestId("tts-field-api-key") as HTMLInputElement;
    const toggle = view.getByTestId("tts-field-api-key-toggle") as HTMLButtonElement;

    expect(input.getAttribute("type")).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("tts_field_api_key_show");

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(input.getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe("tts_field_api_key_hide");

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(input.getAttribute("type")).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("tts_field_api_key_show");
    cleanup();
  });

  it("toggle button is focusable and has type button", () => {
    const view = render(React.createElement(TtsApiKeyField as never, { value: "", onChange: mock(() => {}) } as never));
    const toggle = view.getByTestId("tts-field-api-key-toggle") as HTMLButtonElement;
    expect(toggle.getAttribute("type")).toBe("button");
    // tabIndex not -1 — focusable by default
    expect(toggle.getAttribute("tabindex")).toBeNull();
    cleanup();
  });
});
