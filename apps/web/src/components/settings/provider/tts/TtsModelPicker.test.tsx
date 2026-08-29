import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// Dynamic RTL import BELOW the dom registration (AGENTS gotcha: a static
// import binds @testing-library/dom to a missing document permanently).
const { render, fireEvent, waitFor, cleanup } = await import("@testing-library/react");

// Same i18n fake as KokoroModelPanel.test.tsx: raw-key t (interpolated
// params appended after ":"). Registered BEFORE the component import so
// the picker picks up the mocked context.
const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params === "object") {
        return `${key}:${Object.values(params).map(String).join(":")}`;
      }
      return key;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { TtsModelPicker } = await import("./TtsModelPicker.js");

const ENRICHED = [
  {
    id: "deepgram/flux-tts:free",
    label: "Flux TTS",
    isFree: true,
    description: "Fast TTS model by Deepgram",
    contextLength: 4096,
  },
  { id: "paid/tts", label: "Paid TTS" },
];

function mountPicker(overrides: Partial<React.ComponentProps<typeof TtsModelPicker>> = {}) {
  const onChange = mock((_v: string) => {});
  const view = render(
    React.createElement(TtsModelPicker, {
      value: "",
      onChange,
      models: ENRICHED,
      fetching: false,
      fetchError: null,
      onRefresh: () => {},
      label: "tts_field_model",
      ...overrides,
    }),
  );
  return { view, onChange };
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(async () => {
  cleanup();
  document.body.innerHTML = "";
});

describe("TtsModelPicker (ProviderModelSelector fork)", () => {
  it("no placeholder stub (owner directive): the trigger reports loading while the first fetch is in flight", () => {
    const { view } = mountPicker({ models: [], fetching: true });
    const trigger = view.getByTestId("tts-field-model") as HTMLElement;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("tts_models_loading");
    // And it never surfaces a fake example model id.
    expect(trigger.textContent).not.toContain("tts-1");
  });

  it("an idle empty list still renders the dropdown trigger (custom slug stays reachable)", () => {
    const { view } = mountPicker({ models: [], fetching: false, fetchError: null });
    const trigger = view.getByTestId("tts-field-model") as HTMLElement;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("select_model");
  });

  it("renders enriched rows: free badge, wire id, description, ctx (aggregator payload)", async () => {
    const { view, onChange } = mountPicker();
    const trigger = view.getByTestId("tts-field-model") as HTMLButtonElement;
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    await waitFor(() => {
      const bodyText = document.body.textContent ?? "";
      expect(bodyText).toContain("Flux TTS");
      expect(bodyText).toContain("free");
      expect(bodyText).toContain("deepgram/flux-tts:free");
      expect(bodyText).toContain("Fast TTS model by Deepgram");
      expect(bodyText).toContain("4.1k ctx");
    });
    // Selecting a row reports the wire id.
    const item = Array.from(document.querySelectorAll("[cmdk-item]")).find((el) => el.textContent?.includes("Flux TTS"));
    expect(item).toBeTruthy();
    fireEvent.click(item!);
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("deepgram/flux-tts:free");
  });

  it("search miss offers the custom-slug row (same pattern as the LLM list)", async () => {
    const { view, onChange } = mountPicker();
    fireEvent.click(view.getByTestId("tts-field-model"));
    const input = await waitFor(() => {
      const el = document.querySelector("[cmdk-input]") as HTMLInputElement | null;
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    }, { timeout: 2500 });
    fireEvent.input(input, { target: { value: "custom/model-id" } });
    const slug = await waitFor(() => {
      const el = document.querySelector('[data-testid="use-custom-model"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.click(slug);
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("custom/model-id");
  });

  it("the current value stays visible even when absent from the fetched list", () => {
    const { view } = mountPicker({ value: "gone/model" });
    expect((view.getByTestId("tts-field-model") as HTMLElement).textContent).toContain("gone/model");
  });
});
