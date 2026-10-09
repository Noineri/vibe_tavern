import { afterEach, describe, expect, it, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { Text } from "@codemirror/state";
import type { ScriptSafetyFinding } from "@vibe-tavern/domain/script-safety";

useDomEnv();

// Identity i18n — assertion strings match the i18n keys verbatim (the findings
// modal is display-only: no settings API seam, so no settings mock is needed).
const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

const { cleanup, render, fireEvent } = await import("@testing-library/react");
const {
  FindingsWarningModal,
  blockingFindings,
  scriptSafetyRevealPosition,
} = await import("./FindingsWarningModal.js");

function finding(overrides: Partial<ScriptSafetyFinding> = {}): ScriptSafetyFinding {
  return { ruleId: "unsafe-eval", severity: "critical", line: 1, ...overrides };
}

const FINDINGS: readonly ScriptSafetyFinding[] = [
  finding({ ruleId: "out-of-surface-global", severity: "warning", line: 3 }),
  finding({ ruleId: "unsafe-eval", severity: "critical", line: 7 }),
];

afterEach(() => {
  cleanup();
});

describe("blockingFindings — the modal threshold (warning+, single source)", () => {
  it("keeps warning and critical findings", () => {
    expect(blockingFindings(FINDINGS)).toHaveLength(2);
  });

  it("drops info findings (they highlight in the editor only)", () => {
    const info = finding({ ruleId: "masking-encoded-literal", severity: "info", line: 2 });
    expect(blockingFindings([info, ...FINDINGS])).toHaveLength(2);
    expect(blockingFindings([info])).toEqual([]);
  });
});

describe("scriptSafetyRevealPosition — the «Show in code» jump target (pure)", () => {
  const doc = Text.of(["first line", "second line", "third line"]);

  it("maps a 1-based finding line to the line-start offset", () => {
    expect(scriptSafetyRevealPosition(doc, 2)).toBe(doc.line(2).from);
    expect(scriptSafetyRevealPosition(doc, 2)).toBe(11);
  });

  it("clamps out-of-range lines onto the document (1..lines)", () => {
    expect(scriptSafetyRevealPosition(doc, 99)).toBe(doc.line(3).from);
    expect(scriptSafetyRevealPosition(doc, 0)).toBe(doc.line(1).from);
  });
});

describe("FindingsWarningModal", () => {
  it("lists every finding: severity badge, localized rule message, line label", () => {
    const view = render(
      <FindingsWarningModal
        findings={FINDINGS}
        showHonestWarning={false}
        intent="enable"
        onShowInCode={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    // Severity badges (localized labels).
    expect(view.getByText("script_safety_severity_warning")).toBeTruthy();
    expect(view.getByText("script_safety_severity_critical")).toBeTruthy();
    // Rule messages reuse the SS-5 lint i18n keys (script_safety_rule_*).
    expect(view.getByText("script_safety_rule_out_of_surface_global")).toBeTruthy();
    expect(view.getByText("script_safety_rule_unsafe_eval")).toBeTruthy();
    // Title/intro render twice by design (visible panel copy + the Modal's
    // sr-only Dialog.Title/Description pair).
    expect(view.getAllByText("script_safety_findings_title").length).toBe(2);
    expect(view.getAllByText("script_safety_findings_intro").length).toBe(2);
    // The three-button footer (plan decision 4).
    expect(view.getByText("script_safety_findings_show_in_code")).toBeTruthy();
    expect(view.getByText("cancel")).toBeTruthy();
    expect(view.getByText("script_safety_warning_confirm_enable")).toBeTruthy();
  });

  it("carries the honest warning text only when the plain warning would also fire (decision 11)", () => {
    const withHonest = render(
      <FindingsWarningModal
        findings={FINDINGS}
        showHonestWarning
        intent="enable"
        onShowInCode={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(withHonest.getByText("script_safety_warning_body")).toBeTruthy();
    withHonest.unmount();

    const withoutHonest = render(
      <FindingsWarningModal
        findings={FINDINGS}
        showHonestWarning={false}
        intent="enable"
        onShowInCode={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(withoutHonest.queryByText("script_safety_warning_body")).toBeNull();
  });

  it("never offers a suppress checkbox (unsilenceable by design)", () => {
    const view = render(
      <FindingsWarningModal
        findings={FINDINGS}
        showHonestWarning
        intent="enable"
        onShowInCode={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(view.queryByRole("switch")).toBeNull();
    expect(view.queryByText("script_safety_warning_suppress")).toBeNull();
  });

  it("«Show in code» closes via onShowInCode with the FIRST finding's line", () => {
    const onShowInCode = mock((_line: number) => {});
    const view = render(
      <FindingsWarningModal
        findings={FINDINGS}
        showHonestWarning={false}
        intent="enable"
        onShowInCode={onShowInCode}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(view.getByText("script_safety_findings_show_in_code"));
    expect(onShowInCode).toHaveBeenCalledWith(3);
  });

  it("confirm and cancel route through their handlers (run intent labels the button)", () => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    const view = render(
      <FindingsWarningModal
        findings={FINDINGS}
        showHonestWarning={false}
        intent="test"
        onShowInCode={() => {}}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(view.getByText("script_safety_warning_confirm_run"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByText("cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
