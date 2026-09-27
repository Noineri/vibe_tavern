import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import { flyTribunalSettingsSchema } from "@vibe-tavern/api-contracts";
import { useFlyTribunalStore } from "../../stores/fly-tribunal-store.js";
import { __setFlyBrainDepsForTests } from "./use-fly-brain.js";

/**
 * Fly Tribunal modal rendering (FT-9).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: hook DI resets after every test; no global patches.
 * 3. Determinism: resolved loader doubles and stable DOM assertions; no waits.
 * 4. Platform: DOM-only, no platform assumptions.
 * 5. Shared worker pool: i18n module fake spreads the real module.
 * 6. Stable state: assertions read rendered modal controls after React commits.
 */

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

const { fireEvent, render } = await import("@testing-library/react");
const { FlyTribunalModal } = await import("./FlyTribunalModal.js");

function resetStore(): void {
  useFlyTribunalStore.setState({
    courtState: "silent",
    transientState: null,
    precedentCount: 0,
    lastPrecedentAt: null,
    justFellSilent: false,
    verdicts: {},
    settings: flyTribunalSettingsSchema.parse({ hints: ["{detected}"] }),
    settingsLoadState: "ready",
    settingsError: null,
    workerClient: null,
  });
}

beforeEach(() => {
  resetStore();
  __setFlyBrainDepsForTests({
    loadCached: async () => ({ status: "idle" }),
    download: async () => ({ status: "idle" }),
    clearCache: async () => {},
  });
});

afterEach(() => {
  __setFlyBrainDepsForTests(null);
});

function renderModal() {
  return render(
    <FlyTribunalModal
      open={true}
      onClose={() => {}}
      onSaveSettings={async () => {}}
    />,
  );
}

describe("FlyTribunalModal", () => {
  test("renders all five settings blocks and locks reaction tiers below the shared gate", () => {
    const view = renderModal();

    for (const key of [
      "fly_tribunal_brain_title",
      "fly_tribunal_reaction_title",
      "fly_tribunal_training_title",
      "fly_tribunal_hint_title",
      "fly_tribunal_memory_title",
    ]) {
      expect(view.getByText(key).textContent).toBe(key);
    }
    expect(view.getByTestId("fly-tribunal-gate-counter").textContent).toBe("fly_tribunal_precedents_counter");
    const indication = view.getByRole("radio", { name: "fly_tribunal_reaction_indication" }) as HTMLButtonElement;
    expect(indication.disabled).toBe(true);
    expect(view.queryByTestId("fly-tribunal-auto-confidence")).toBeNull();
  });

  test("shows the auto-swipe confidence control only for the auto tier", () => {
    useFlyTribunalStore.getState().setPrecedentCount(25);
    useFlyTribunalStore.getState().applySettings({
      ...useFlyTribunalStore.getState().settings,
      reactionTier: "auto",
    });
    const view = renderModal();

    expect(view.getByTestId("fly-tribunal-auto-confidence").textContent).toContain("fly_tribunal_auto_confidence");
  });

  test("keeps an invalid hint draft local and surfaces the placeholder error inline", () => {
    const view = renderModal();
    const hint = view.getByLabelText("fly_tribunal_hint_template") as HTMLTextAreaElement;
    fireEvent.change(hint, { target: { value: "missing placeholder" } });

    expect(view.getByRole("alert").textContent).toBe("fly_tribunal_hint_placeholder_error");
    expect(useFlyTribunalStore.getState().settings.hints).toEqual(["{detected}"]);
  });
});
