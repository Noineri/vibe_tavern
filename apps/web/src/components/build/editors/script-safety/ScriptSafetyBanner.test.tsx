import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { wireScript } from "../../../../../test/wire-fixtures.js";
import type { ScriptRecord } from "../../../../api/types.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";

useDomEnv();

// The banner reads `useT` and the settings store (which calls the settings
// API). Mock both seams; the real Zustand store stays — the test drives its
// state directly, matching the editor suites' "real store, mocked API" split.
const realI18n = await import("../../../../i18n/context.js");
const realSettingsApi = await import("../../../../api/settings-api.js");
const getScriptSafetySettings = mock(async () => ({ suppressImportWarnings: false, updatedAt: "" }));
const updateScriptSafetySettings = mock(async (input: { suppressImportWarnings: boolean }) => ({
  suppressImportWarnings: input.suppressImportWarnings,
  updatedAt: "",
}));

mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../../../../api/settings-api.js", () => ({
  ...realSettingsApi,
  getScriptSafetySettings,
  updateScriptSafetySettings,
}));

const { cleanup, render, fireEvent, waitFor } = await import("@testing-library/react");
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
    expect(view.queryByText("script_safety_banner_show_warnings")).toBeNull();
  });

  it("shows the «show warnings again» control for an untrusted import when suppressed", () => {
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
    const view = render(<ScriptSafetyBanner script={script({ origin: "imported", firstEnabledAt: null })} />);
    expect(view.getByTestId("script-safety-banner")).toBeTruthy();
    expect(view.getByText("script_safety_banner_show_warnings")).toBeTruthy();
    expect(view.queryByText("script_safety_banner_imported")).toBeNull();
  });
});

describe("ScriptSafetyBanner «show warnings again» control", () => {
  it("PUTs suppressImportWarnings=false when clicked", async () => {
    useScriptSafetySettingsStore.setState({ suppressImportWarnings: true });
    const view = render(<ScriptSafetyBanner script={script({ origin: "imported", firstEnabledAt: null })} />);
    fireEvent.click(view.getByText("script_safety_banner_show_warnings"));
    await waitFor(() => {
      expect(updateScriptSafetySettings).toHaveBeenCalledWith({ suppressImportWarnings: false });
    });
  });
});
