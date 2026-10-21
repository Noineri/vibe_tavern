/**
 * DestructiveConfirmModal tests (SC-21).
 *
 * The first describe is a characterization pin of the app's only
 * three-button-capable confirm, written BEFORE the calm-tone prop landed:
 * single-action default, dual-action variant, and the shell renderer. It
 * proves the destructive default stayed byte-identical after the SC-21 edit.
 * The second describe pins the calm tone (accent primary, neutral
 * secondary) the fork confirm uses.
 *
 * Portal note: `Modal` renders through Radix `Dialog.Portal`, so the panel
 * lives under `document.body`, not the RTL `container` — all queries go
 * through `baseElement` (the render-bound queries, never global `screen`).
 */
import { describe, expect, mock, test } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");

const realI18nContext = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const { DestructiveConfirmModal, ShellDestructiveConfirmModal } = await import("./destructive-confirm-modal.js");
const { useCharacterStore } = await import("../../stores/character-store.js");

const PANEL_SINGLE = "w-[380px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl";
const PANEL_DUAL = "w-[440px] rounded-lg border border-border bg-surface p-7 text-center shadow-xl";
const ROW_EXPLICIT = "flex flex-wrap justify-center gap-2.5";
const ROW_SHELL_SINGLE = "flex justify-center gap-2.5";
const CANCEL_BTN = "h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1";
const PRIMARY_DESTRUCTIVE_BTN = "h-8 cursor-pointer rounded-md border-0 bg-danger px-[18px] font-ui text-[12.5px] font-medium text-on-danger transition-[filter] duration-100 hover:brightness-110";
const SECONDARY_DESTRUCTIVE_BTN = "h-8 cursor-pointer rounded-md border border-danger bg-transparent px-3.5 font-ui text-[12.5px] font-medium text-danger transition-colors duration-150 hover:bg-danger/10";
const PRIMARY_CALM_BTN = "h-8 cursor-pointer rounded-md border-0 bg-accent px-[18px] font-ui text-[12.5px] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110";

function panelOf(baseElement: HTMLElement, title: string): HTMLElement {
  const titleEl = Array.from(baseElement.querySelectorAll("div")).find((d) => d.textContent === title);
  if (!titleEl) throw new Error(`confirm title "${title}" missing`);
  // Title div's parent is the styled panel.
  const panel = titleEl.parentElement;
  if (!panel) throw new Error("confirm panel missing");
  return panel as HTMLElement;
}

function buttonsOf(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll("button")) as HTMLElement[];
}

describe("DestructiveConfirmModal characterization (destructive default)", () => {
  test("single-action renders the 380px panel with cancel + danger primary", () => {
    const view = render(
      <DestructiveConfirmModal
        title="t-title"
        body="t-body"
        confirmLabel="t-confirm"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    expect(panel.getAttribute("class")).toBe(PANEL_SINGLE);
    const row = buttonsOf(panel)[0]?.parentElement;
    expect(row?.getAttribute("class")).toBe(ROW_EXPLICIT);
    const buttons = buttonsOf(panel);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toBe("cancel");
    expect(buttons[0]?.getAttribute("class")).toBe(CANCEL_BTN);
    expect(buttons[1]?.textContent).toBe("t-confirm");
    expect(buttons[1]?.getAttribute("class")).toBe(PRIMARY_DESTRUCTIVE_BTN);
    view.unmount();
  });

  test("dual-action renders the 440px panel with [cancel][danger-outline secondary][danger primary] order", () => {
    const view = render(
      <DestructiveConfirmModal
        title="t-title"
        body="t-body"
        confirmLabel="t-confirm"
        secondaryLabel="t-secondary"
        onSecondary={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    expect(panel.getAttribute("class")).toBe(PANEL_DUAL);
    const buttons = buttonsOf(panel);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.textContent)).toEqual(["cancel", "t-secondary", "t-confirm"]);
    expect(buttons[0]?.getAttribute("class")).toBe(CANCEL_BTN);
    expect(buttons[1]?.getAttribute("class")).toBe(SECONDARY_DESTRUCTIVE_BTN);
    expect(buttons[2]?.getAttribute("class")).toBe(PRIMARY_DESTRUCTIVE_BTN);
    view.unmount();
  });

  test("shell renderer opens from confirmDestroy with the single-action chrome and closes on either button", () => {
    const onConfirm = mock();
    useCharacterStore.getState().setConfirmDestroy({
      title: "t-title",
      body: "t-body" as unknown as ReactNode,
      confirmLabel: "t-confirm",
      onConfirm: () => void onConfirm(),
    });
    const view = render(<ShellDestructiveConfirmModal />);
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    expect(panel.getAttribute("class")).toBe(PANEL_SINGLE);
    const row = buttonsOf(panel)[0]?.parentElement;
    expect(row?.getAttribute("class")).toBe(ROW_SHELL_SINGLE);
    const buttons = buttonsOf(panel);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("class")).toBe(CANCEL_BTN);
    expect(buttons[1]?.getAttribute("class")).toBe(PRIMARY_DESTRUCTIVE_BTN);

    fireEvent.click(buttons[1] as HTMLElement);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(useCharacterStore.getState().confirmDestroy).toBeNull();
    view.unmount();
  });

  test("shell cancel closes without firing onConfirm", () => {
    const onConfirm = mock();
    useCharacterStore.getState().setConfirmDestroy({
      title: "t-title",
      body: "t-body" as unknown as ReactNode,
      confirmLabel: "t-confirm",
      onConfirm: () => void onConfirm(),
    });
    const view = render(<ShellDestructiveConfirmModal />);
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    fireEvent.click(buttonsOf(panel)[0] as HTMLElement);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(useCharacterStore.getState().confirmDestroy).toBeNull();
    view.unmount();
  });
});

describe("DestructiveConfirmModal calm tone (SC-21 fork confirm)", () => {
  test("explicit triple: accent primary, neutral secondary (Cancel chrome verbatim), 440px panel", () => {
    const view = render(
      <DestructiveConfirmModal
        title="t-title"
        body="t-body"
        confirmLabel="t-with"
        secondaryLabel="t-plain"
        onSecondary={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        tone="calm"
      />,
    );
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    expect(panel.getAttribute("class")).toBe(PANEL_DUAL);
    const buttons = buttonsOf(panel);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => b.textContent)).toEqual(["cancel", "t-plain", "t-with"]);
    expect(buttons[0]?.getAttribute("class")).toBe(CANCEL_BTN);
    expect(buttons[1]?.getAttribute("class")).toBe(CANCEL_BTN);
    expect(buttons[2]?.getAttribute("class")).toBe(PRIMARY_CALM_BTN);
    view.unmount();
  });

  test("shell triple: same chrome, wrapped row, secondary closes + fires onSecondary only", () => {
    const onConfirm = mock();
    const onSecondary = mock();
    useCharacterStore.getState().setConfirmDestroy({
      title: "t-title",
      body: "t-body" as unknown as ReactNode,
      confirmLabel: "t-with",
      secondaryLabel: "t-plain",
      onSecondary: () => void onSecondary(),
      onConfirm: () => void onConfirm(),
      tone: "calm",
    });
    const view = render(<ShellDestructiveConfirmModal />);
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    expect(panel.getAttribute("class")).toBe(PANEL_DUAL);
    const row = buttonsOf(panel)[0]?.parentElement;
    expect(row?.getAttribute("class")).toBe(ROW_EXPLICIT);
    const buttons = buttonsOf(panel);
    expect(buttons[2]?.getAttribute("class")).toBe(PRIMARY_CALM_BTN);
    expect(buttons[1]?.getAttribute("class")).toBe(CANCEL_BTN);

    fireEvent.click(buttons[1] as HTMLElement);
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(useCharacterStore.getState().confirmDestroy).toBeNull();
    view.unmount();
  });

  test("calm buttons never truncate: no truncate/line-clamp on the row or buttons", () => {
    const view = render(
      <DestructiveConfirmModal
        title="t-title"
        body="t-body"
        confirmLabel="t-with-sidechat-label"
        secondaryLabel="t-plain-label"
        onSecondary={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        tone="calm"
      />,
    );
    const panel = panelOf(view.baseElement as HTMLElement, "t-title");
    const row = buttonsOf(panel)[0]?.parentElement;
    for (const el of [row, ...buttonsOf(panel)]) {
      const cls = el?.getAttribute("class") ?? "";
      expect(cls).not.toContain("truncate");
      expect(cls).not.toContain("line-clamp");
    }
    view.unmount();
  });
});
