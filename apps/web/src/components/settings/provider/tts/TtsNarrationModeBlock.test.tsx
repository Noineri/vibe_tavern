import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_NARRATION_MODE_KEY, persistTtsNarrationMode } from "../../../../lib/local-storage.js";
import { TtsNarrationModeBlock } from "./TtsNarrationModeBlock.js";

const { render, act, cleanup, fireEvent } = await import("@testing-library/react");

beforeEach(() => {
  window.localStorage.removeItem(TTS_NARRATION_MODE_KEY);
  cleanup();
});

describe("TtsNarrationModeBlock (D26)", () => {
  test("renders three segments; default is full with its description; storage untouched", async () => {
    let container: HTMLElement | null = null;
    await act(async () => {
      const r = render(React.createElement(TtsNarrationModeBlock));
      container = r.container;
    });
    const radios = container!.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(3);
    expect((radios[0] as HTMLElement).getAttribute("aria-checked")).toBe("true");
    // useT without a provider returns raw keys — pin the label + description keys.
    expect(container!.textContent).toContain("tts_narration_mode_label");
    expect(container!.textContent).toContain("tts_narration_mode_full_desc");
    expect(window.localStorage.getItem(TTS_NARRATION_MODE_KEY)).toBeNull();
  });

  test("preseeded skip mode is active on mount", async () => {
    persistTtsNarrationMode("skip-asterisk-spans");
    let container: HTMLElement | null = null;
    await act(async () => {
      const r = render(React.createElement(TtsNarrationModeBlock));
      container = r.container;
    });
    const radios = container!.querySelectorAll('[role="radio"]');
    expect((radios[1] as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(container!.textContent).toContain("tts_narration_mode_skip_desc");
  });

  test("clicking quoted persists the mode and swaps the description", async () => {
    let container: HTMLElement | null = null;
    await act(async () => {
      const r = render(React.createElement(TtsNarrationModeBlock));
      container = r.container;
    });
    const radios = container!.querySelectorAll('[role="radio"]');
    await act(async () => {
      fireEvent.click(radios[2] as HTMLElement);
    });
    expect(window.localStorage.getItem(TTS_NARRATION_MODE_KEY)).toBe("quoted-dialogue");
    const after = container!.querySelectorAll('[role="radio"]');
    expect((after[2] as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(container!.textContent).toContain("tts_narration_mode_quoted_desc");
  });
});
