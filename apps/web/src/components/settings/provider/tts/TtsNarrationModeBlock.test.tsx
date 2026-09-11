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
  test("inline-footer canon (MUI W7): bounded trigger, no description in the trigger line, no row ownership", async () => {
    let view: { container: HTMLElement } | null = null;
    await act(async () => {
      view = render(React.createElement(TtsNarrationModeBlock));
    });
    const root = view!.container.querySelector('[data-testid="tts-narration-mode-block"]') as HTMLElement;
    // W7: the block is width-agnostic — the mobile full-width row is owned
    // by MasterDetailFooter's `mobileBottomRow`. Step 18/19's basis-full
    // resolved against the auto-width right group and overflowed the
    // viewport; it must not come back.
    expect(root.className).not.toContain("basis-full");
    const trigger = view!.container.querySelector('[data-testid="tts-narration-mode-select"]') as HTMLElement;
    // Content-sized trigger with a cap — never the w-full form-field chrome.
    // 220px: the longest RU mode label «Игнорировать *звёздочки*» (~205px
    // with chrome) must not ellipsize (authored strings are never cut).
    expect(trigger.className).toContain("max-w-[220px]");
    expect(trigger.className).toContain("w-auto");
    // The per-mode description rides the opened list items only.
    expect(trigger.textContent).not.toContain("tts_narration_mode_full_desc");
    expect(trigger.textContent).toContain("tts_narration_mode_full");
  });

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
    // W7: footer trigger sits ~45px above the screen edge on phones — the
    // list opens UPWARD into the modal body.
    expect(view!.baseElement.querySelector('[data-side="top"]')).toBeTruthy();
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
