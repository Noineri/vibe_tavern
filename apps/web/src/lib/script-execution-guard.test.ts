import { describe, expect, it } from "bun:test";
import type { ScriptRecord } from "../api/types.js";
import {
  SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY,
  scriptExecutionGuard,
} from "./script-execution-guard.js";

const IN_APP: Pick<ScriptRecord, "origin" | "firstEnabledAt"> = {
  origin: "in_app",
  firstEnabledAt: null,
};
const TRUSTED_IMPORT: Pick<ScriptRecord, "origin" | "firstEnabledAt"> = {
  origin: "imported",
  firstEnabledAt: "2026-01-01T00:00:00.000Z",
};
const UNTRUSTED_IMPORT: Pick<ScriptRecord, "origin" | "firstEnabledAt"> = {
  origin: "imported",
  firstEnabledAt: null,
};

function guard(input: {
  script: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null;
  intent: "automatic" | "explicit";
  code?: string;
  suppressImportWarnings?: boolean | null;
}) {
  return scriptExecutionGuard({
    script: input.script,
    intent: input.intent,
    code: input.code ?? "context.state.set('x', 1);",
    kind: "interactive",
    suppressImportWarnings: input.suppressImportWarnings ?? false,
  });
}

describe("scriptExecutionGuard — trust × execution-intent matrix", () => {
  it("allows in-app scripts for automatic and explicit execution without an acknowledgement", () => {
    expect(guard({ script: IN_APP, intent: "automatic" })).toEqual({ kind: "ok", warningAcknowledged: false });
    expect(guard({ script: IN_APP, intent: "explicit" })).toEqual({ kind: "ok", warningAcknowledged: false });
  });

  it("allows trusted imports for automatic and explicit execution without an acknowledgement", () => {
    expect(guard({ script: TRUSTED_IMPORT, intent: "automatic" })).toEqual({ kind: "ok", warningAcknowledged: false });
    expect(guard({ script: TRUSTED_IMPORT, intent: "explicit" })).toEqual({ kind: "ok", warningAcknowledged: false });
  });

  it("skips automatic execution for an untrusted import regardless of warning suppression", () => {
    expect(guard({ script: UNTRUSTED_IMPORT, intent: "automatic", suppressImportWarnings: false })).toEqual({
      kind: "skip-auto",
      messageKey: SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY,
    });
    expect(guard({ script: UNTRUSTED_IMPORT, intent: "automatic", suppressImportWarnings: true })).toEqual({
      kind: "skip-auto",
      messageKey: SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY,
    });
  });

  it("warns before explicit execution of a clean untrusted import", () => {
    expect(guard({ script: UNTRUSTED_IMPORT, intent: "explicit" })).toEqual({
      kind: "warn",
      flow: { kind: "plain" },
    });
  });

  it("uses suppressed warnings as the acknowledgement for explicit clean runs", () => {
    expect(guard({ script: UNTRUSTED_IMPORT, intent: "explicit", suppressImportWarnings: true })).toEqual({
      kind: "ok",
      warningAcknowledged: true,
    });
  });

  it("keeps findings ahead of suppression and carries honest-warning visibility", () => {
    expect(guard({ script: IN_APP, intent: "explicit", code: "eval('x');" })).toEqual({
      kind: "ok",
      warningAcknowledged: false,
    });
    expect(guard({ script: TRUSTED_IMPORT, intent: "explicit", code: "eval('x');" })).toEqual({
      kind: "warn",
      flow: {
        kind: "findings",
        findings: [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }],
        showHonestWarning: false,
      },
    });
    expect(guard({ script: UNTRUSTED_IMPORT, intent: "explicit", code: "eval('x');" })).toEqual({
      kind: "warn",
      flow: {
        kind: "findings",
        findings: [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }],
        showHonestWarning: true,
      },
    });
    expect(guard({ script: UNTRUSTED_IMPORT, intent: "explicit", code: "eval('x');", suppressImportWarnings: true })).toEqual({
      kind: "warn",
      flow: {
        kind: "findings",
        findings: [{ ruleId: "unsafe-eval", severity: "critical", line: 1, col: 1 }],
        showHonestWarning: false,
      },
    });
  });
});

describe("SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY", () => {
  it("names the shared localized unavailable-until-enable state", () => {
    expect(SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY).toBe("script_safety_checks_after_enabling");
  });
});
