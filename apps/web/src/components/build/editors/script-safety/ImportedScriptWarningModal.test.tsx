import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { wireScript } from "../../../../../test/wire-fixtures.js";
import type { ScriptRecord } from "../../../../api/types.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";

useDomEnv();

// Identity i18n + mocked settings API (the suppression PUT) — the same seam
// split as ScriptSafetyBanner.test.tsx: the real Zustand store stays and the
// tests drive its state directly.
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
const { ImportedScriptWarningModal, scriptSafetyWarningFlow } = await import("./ImportedScriptWarningModal.js");

/** Deterministic detector fixtures (verified against SS-1's rule table). */
const CLEAN_CODE = "context.state.set('x', 1);";
const CRITICAL_CODE = "eval('x');";
const WARNING_CODE = "process.env;";
const INFO_ONLY_CODE = 'const s = "SGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyBmb3IgdGVzdGluZw==";';

function script(overrides: Partial<ScriptRecord> = {}): ScriptRecord {
  return { ...wireScript(), ...overrides };
}

function untrustedImport(): ScriptRecord {
  return script({ origin: "imported", firstEnabledAt: null });
}

function trustedImport(): ScriptRecord {
  return script({ origin: "imported", firstEnabledAt: "2026-01-01T00:00:00.000Z" });
}

beforeEach(() => {
  // Seed a loaded (non-null) suppress value so `load()` is a no-op — the
  // matrix drives the value explicitly (deterministic, no async GET races).
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  getScriptSafetySettings.mockClear();
  updateScriptSafetySettings.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("scriptSafetyWarningFlow — the SS-7 state matrix (single source)", () => {
  it("in_app scripts never get a modal, findings included (decision 6)", () => {
    expect(scriptSafetyWarningFlow({ script: script({ origin: "in_app" }), code: CRITICAL_CODE, kind: "prompt", suppressImportWarnings: false }))
      .toEqual({ kind: "none", warningAcknowledged: false });
  });

  it("null script (no record) never warns", () => {
    expect(scriptSafetyWarningFlow({ script: null, code: CRITICAL_CODE, kind: "prompt", suppressImportWarnings: false }))
      .toEqual({ kind: "none", warningAcknowledged: false });
  });

  it("untrusted import, clean code, not suppressed → the plain warning", () => {
    expect(scriptSafetyWarningFlow({ script: untrustedImport(), code: CLEAN_CODE, kind: "prompt", suppressImportWarnings: false }))
      .toEqual({ kind: "plain" });
  });

  it("untrusted import, clean code, suppressed → no modal, but acknowledged (decision 14)", () => {
    expect(scriptSafetyWarningFlow({ script: untrustedImport(), code: CLEAN_CODE, kind: "prompt", suppressImportWarnings: true }))
      .toEqual({ kind: "none", warningAcknowledged: true });
  });

  it("untrusted import, suppress not yet loaded → fails OPEN (plain warning shows)", () => {
    expect(scriptSafetyWarningFlow({ script: untrustedImport(), code: CLEAN_CODE, kind: "prompt", suppressImportWarnings: null }))
      .toEqual({ kind: "plain" });
  });

  it("untrusted import with info-only findings → still the plain warning (threshold = warning+)", () => {
    expect(scriptSafetyWarningFlow({ script: untrustedImport(), code: INFO_ONLY_CODE, kind: "prompt", suppressImportWarnings: false }))
      .toEqual({ kind: "plain" });
  });

  it("untrusted import with warning+ findings → the findings modal ALONE, honest text inside (decision 11)", () => {
    expect(scriptSafetyWarningFlow({ script: untrustedImport(), code: CRITICAL_CODE, kind: "prompt", suppressImportWarnings: false }))
      .toEqual({ kind: "findings", findings: [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }], showHonestWarning: true });
  });

  it("untrusted import with findings, suppressed → findings modal (unsilenceable), NO honest text", () => {
    expect(scriptSafetyWarningFlow({ script: untrustedImport(), code: CRITICAL_CODE, kind: "prompt", suppressImportWarnings: true }))
      .toEqual({ kind: "findings", findings: [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }], showHonestWarning: false });
  });

  it("TRUSTED import with findings → findings modal fires (origin-based), without honest text", () => {
    // Plan decision 4 / constraint / item 12: the findings modal is imported-
    // scripts-only — trust does not silence it; the plain first-enable text is
    // untrusted-only, so showHonestWarning is false here.
    expect(scriptSafetyWarningFlow({ script: trustedImport(), code: CRITICAL_CODE, kind: "interactive", suppressImportWarnings: false }))
      .toEqual({ kind: "findings", findings: [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }], showHonestWarning: false });
  });

  it("trusted import, clean code → no modal, unacknowledged", () => {
    expect(scriptSafetyWarningFlow({ script: trustedImport(), code: CLEAN_CODE, kind: "prompt", suppressImportWarnings: false }))
      .toEqual({ kind: "none", warningAcknowledged: false });
  });

  it("carries the detector's findings verbatim (warning + critical together)", () => {
    const flow = scriptSafetyWarningFlow({
      script: untrustedImport(),
      code: "process.env;\neval('x');",
      kind: "prompt",
      suppressImportWarnings: false,
    });
    expect(flow.kind).toBe("findings");
    if (flow.kind !== "findings") return;
    expect(flow.findings).toHaveLength(2);
    expect(flow.findings.map((f) => f.severity)).toEqual(["warning", "critical"]);
  });
});

describe("ImportedScriptWarningModal", () => {
  it("renders the honest text, the suppress toggle and the footer pair (enable intent)", () => {
    const view = render(<ImportedScriptWarningModal intent="enable" onConfirm={() => {}} onCancel={() => {}} />);
    // The title/body appear TWICE by design: the visible panel copy + the
    // Modal's sr-only Dialog.Title/Description (a11y name/description).
    expect(view.getAllByText("script_safety_warning_title").length).toBe(2);
    expect(view.getAllByText("script_safety_warning_body").length).toBe(2);
    expect(view.getByText("script_safety_warning_suppress")).toBeTruthy();
    expect(view.getByText("script_safety_warning_confirm_enable")).toBeTruthy();
    expect(view.getByText("cancel")).toBeTruthy();
  });

  it("labels the confirm button with the run verb for the test intent", () => {
    const view = render(<ImportedScriptWarningModal intent="test" onConfirm={() => {}} onCancel={() => {}} />);
    expect(view.getByText("script_safety_warning_confirm_run")).toBeTruthy();
  });

  it("confirm without the checkbox proceeds and never PUTs the setting", async () => {
    const onConfirm = mock(() => {});
    const view = render(<ImportedScriptWarningModal intent="enable" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(view.getByText("script_safety_warning_confirm_enable"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateScriptSafetySettings).not.toHaveBeenCalled();
  });

  it("checking «don't show again» + confirm PUTs suppressImportWarnings=true (decision 3)", async () => {
    const onConfirm = mock(() => {});
    const view = render(<ImportedScriptWarningModal intent="enable" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(view.getByRole("switch", { name: "script_safety_warning_suppress" }));
    fireEvent.click(view.getByText("script_safety_warning_confirm_enable"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(updateScriptSafetySettings).toHaveBeenCalledWith({ suppressImportWarnings: true });
    });
    // The checkbox only affects FUTURE visibility — the store flips after the
    // confirm, never retroactively for this decision.
    expect(useScriptSafetySettingsStore.getState().suppressImportWarnings).toBe(true);
  });

  it("a failed suppression PUT never blocks the confirmed action", async () => {
    updateScriptSafetySettings.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    const onConfirm = mock(() => {});
    const view = render(<ImportedScriptWarningModal intent="enable" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(view.getByRole("switch", { name: "script_safety_warning_suppress" }));
    fireEvent.click(view.getByText("script_safety_warning_confirm_enable"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancel aborts without a PUT — even when the checkbox was checked", async () => {
    const onCancel = mock(() => {});
    const view = render(<ImportedScriptWarningModal intent="enable" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(view.getByRole("switch", { name: "script_safety_warning_suppress" }));
    fireEvent.click(view.getByText("cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateScriptSafetySettings).not.toHaveBeenCalled();
  });
});
