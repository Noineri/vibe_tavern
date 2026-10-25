import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../../test/i18n-context-seam.js";
import { wireScript } from "../../../../../test/wire-fixtures.js";
import type { ScriptRecord } from "../../../../api/types.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";

useDomEnv();

// The banner reads `useT` and the settings store (which calls the settings
// API). Mock both seams; the real Zustand store stays — the test drives its
// state directly, matching the editor suites' "real store, mocked API" split.
const realSettingsApi = await import("../../../../api/settings-api.js");
const getScriptSafetySettings = mock(async () => ({ suppressImportWarnings: false, updatedAt: "" }));
const updateScriptSafetySettings = mock(async (input: { suppressImportWarnings: boolean }) => ({
  suppressImportWarnings: input.suppressImportWarnings,
  updatedAt: "",
}));

installI18nContextSeam();
mock.module("../../../../api/settings-api.js", () => ({
  ...realSettingsApi,
  getScriptSafetySettings,
  updateScriptSafetySettings,
}));

const { cleanup, render, waitFor } = await import("@testing-library/react");
const { ScriptSafetyBanner, isUntrustedImport } = await import("./ScriptSafetyBanner.js");

function script(overrides: Partial<ScriptRecord> = {}): ScriptRecord {
  return { ...wireScript(), ...overrides } as ScriptRecord;
}

beforeEach(() => {
  // Seed a loaded (non-null) suppress value so the banner's `load()` effect is
  // a no-op — the visibility matrix drives the value explicitly, keeping the
  // async GET out of the render path (no act warnings).
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  getScriptSafetySettings.mockClear();
  updateScriptSafetySettings.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("isUntrustedImport", () => {
  it("is false for in-app scripts (never-enabled included)", () => {
    expect(isUntrustedImport(script({ origin: "in_app", firstEnabledAt: null }))).toBe(false);
  });

  it("is false for imported scripts that have been enabled (trusted)", () => {
    expect(isUntrustedImport(script({ origin: "imported", firstEnabledAt: "2026-01-01T00:00:00.000Z" }))).toBe(false);
  });

  it("is true for imported scripts that have never been enabled", () => {
    expect(isUntrustedImport(script({ origin: "imported", firstEnabledAt: null }))).toBe(true);
  });

  it("is false for null (no active script)", () => {
    expect(isUntrustedImport(null)).toBe(false);
  });
});

describe("ScriptSafetyBanner visibility matrix", () => {
  it("renders nothing for an in-app script", () => {
    const view = render(<ScriptSafetyBanner script={script({ origin: "in_app", firstEnabledAt: null })} />);
    expect(view.queryByTestId("script-safety-banner")).toBeNull();
  });

  it("renders nothing for an imported trusted script", () => {
    const view = render(
      <ScriptSafetyBanner script={script({ origin: "imported", firstEnabledAt: "2026-01-01T00:00:00.000Z" })} />,
    );
    expect(view.queryByTestId("script-safety-banner")).toBeNull();
  });

  it("shows the warning for an untrusted import when not suppressed", () => {
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
    const view = render(<ScriptSafetyBanner script={script({ origin: "imported", firstEnabledAt: null })} />);
    expect(view.getByTestId("script-safety-banner")).toBeTruthy();
    expect(view.getByText("script_safety_banner_imported")).toBeTruthy();
    expect(view.getByText("script_safety_banner_full_access")).toBeTruthy();
  });

  // Behavior change (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 10, owner
  // ruling 4b): the suppressed state used to collapse the banner to a lone
  // «Show warnings again» link inside the warning box; it now renders
  // nothing — the switch lives in settings (use-script-warnings-toggle
  // tests in settings/popovers/script-warnings-setting.test.tsx).
  it("renders nothing for an untrusted import when suppressed", () => {
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
    const view = render(<ScriptSafetyBanner script={script({ origin: "imported", firstEnabledAt: null })} />);
    expect(view.queryByTestId("script-safety-banner")).toBeNull();
    expect(view.queryByText("script_safety_banner_imported")).toBeNull();
  });

  it("fails open: shows the warning while the flag is not loaded yet", async () => {
    // A GET that never settles keeps the sentinel null for the whole test.
    getScriptSafetySettings.mockImplementationOnce(() => new Promise(() => {}));
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: null });
    const view = render(<ScriptSafetyBanner script={script({ origin: "imported", firstEnabledAt: null })} />);
    await waitFor(() => {
      expect(getScriptSafetySettings).toHaveBeenCalledTimes(1);
    });
    expect(view.getByTestId("script-safety-banner")).toBeTruthy();
    expect(view.getByText("script_safety_banner_imported")).toBeTruthy();
  });
});
