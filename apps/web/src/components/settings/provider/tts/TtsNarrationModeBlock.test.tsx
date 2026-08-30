import { describe, expect, test, beforeEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_NARRATION_MODE_KEY, persistTtsNarrationMode } from "../../../../lib/local-storage.js";
import { TtsNarrationModeBlock } from "./TtsNarrationModeBlock.js";

const { render, act, cleanup, fireEvent, waitFor } = await import("@testing-library/react");

beforeEach(() => {
  window.localStorage.removeItem(TTS_NARRATION_MODE_KEY);
  cleanup();
});

/** Open the mode dropdown (trigger currently showing `triggerText`) and pick
 *  the item whose text matches `optionLabel` — the cmdk-portal pattern from
 *  ExperienceEditor.test.tsx. Without an i18n provider, useT returns raw keys,
 *  so trigger/items show the key strings. */
async function pickMode(view: { container: HTMLElement; baseElement: HTMLElement }, triggerText: string, optionText: string): Promise<void> {
  const trigger = view.container.querySelector('[data-testid="tts-narration-mode-select"]');
  if (!(trigger instanceof HTMLButtonElement)) throw new Error("mode select trigger missing");
  if (!(trigger.textContent ?? "").includes(triggerText)) {
    throw new Error(`trigger shows "${trigger.textContent}", expected "${triggerText}"`);
  }
  await act(async () => {
    fireEvent.click(trigger);
  });
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
  const items = [...view.baseElement.querySelectorAll("[cmdk-item]")];
  if (items.length !== 3) throw new Error(`expected 3 mode items, got ${items.length}`);
  const item = items.find((i) => (i.textContent ?? "").includes(optionText));
  if (!item) throw new Error(`no cmdk item containing "${optionText}"`);
  await act(async () => {
    fireEvent.click(item);
  });
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
}

describe("TtsNarrationModeBlock (D26, footer-inline dropdown)", () => {
  test("renders label + trigger with the default full mode; storage untouched", async () => {
    let container: HTMLElement | null = null;
    await act(async () => {
      const r = render(React.createElement(TtsNarrationModeBlock));
      container = r.container;
    });
    expect(container!.textContent).toContain("tts_narration_mode_label");
    const trigger = container!.querySelector('[data-testid="tts-narration-mode-select"]');
    expect((trigger?.textContent ?? "")).toContain("tts_narration_mode_full");
    expect(window.localStorage.getItem(TTS_NARRATION_MODE_KEY)).toBeNull();
  });

  test("preseeded skip mode shows on the trigger", async () => {
    persistTtsNarrationMode("skip-asterisk-spans");
    let container: HTMLElement | null = null;
    await act(async () => {
      const r = render(React.createElement(TtsNarrationModeBlock));
      container = r.container;
    });
    const trigger = container!.querySelector('[data-testid="tts-narration-mode-select"]');
    expect((trigger?.textContent ?? "")).toContain("tts_narration_mode_skip");
  });

  test("open list exposes all three modes with their descriptions as details; picking quoted persists", async () => {
    let view: { container: HTMLElement; baseElement: HTMLElement } | null = null;
    await act(async () => {
      view = render(React.createElement(TtsNarrationModeBlock));
    });
    await act(async () => {
      const trigger = view!.container.querySelector('[data-testid="tts-narration-mode-select"]');
      fireEvent.click(trigger as HTMLElement);
    });
    await waitFor(() => expect(view!.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
    const listText = view!.baseElement.textContent ?? "";
    expect(listText).toContain("tts_narration_mode_full_desc");
    expect(listText).toContain("tts_narration_mode_skip_desc");
    expect(listText).toContain("tts_narration_mode_quoted_desc");
    const item = [...view!.baseElement.querySelectorAll("[cmdk-item]")].find((i) =>
      (i.textContent ?? "").includes("tts_narration_mode_quoted"),
    );
    await act(async () => {
      fireEvent.click(item as HTMLElement);
    });
    expect(window.localStorage.getItem(TTS_NARRATION_MODE_KEY)).toBe("quoted-dialogue");
    const trigger = view!.container.querySelector('[data-testid="tts-narration-mode-select"]');
    expect((trigger?.textContent ?? "")).toContain("tts_narration_mode_quoted");
  });
});
