/**
 * ActivationTestPanel — the lore-entry activation tester: type a sample text,
 * run `testLoreActivation`, show whether this entry fires and how many entries
 * in the lorebook activate. Extracted from LoreEntryEditor.tsx (behavior-
 * preserving decomposition — see reports/lorebook-editor-form-state-gap.md
 * Step 1).
 *
 * Fully self-contained: owns its test-text / result state and the `runTest`
 * handler. Reads NO `entry` field — it needs only `lorebookId` (to scope the
 * activation test), `isMobile` (layout), and `t` (strings).
 */
import { useState } from "react";
import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import type { TFunc } from "../../../i18n/context.js";
import { testLoreActivation } from "../../../app-client.js";

export function ActivationTestPanel({
  lorebookId,
  isMobile,
  t,
}: {
  lorebookId: string;
  isMobile: boolean;
  t: TFunc;
}) {
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [testMutData, setTestMutData] = useState<{
    activatedIds: string[];
    totalEntries: number;
  } | null>(null);
  const [testingActivation, setTestingActivation] = useState(false);

  const runTest = async () => {
    if (!testText.trim()) return;
    setTestingActivation(true);
    try {
      const result = await testLoreActivation(lorebookId, testText);
      setTestMutData(result);
      setTestResult({ ok: result.activatedIds.length > 0, msg: "" });
    } catch {
      setTestResult({ ok: false, msg: "Error" });
    } finally {
      setTestingActivation(false);
    }
  };

  return (
    <>
      <div className={cn("flex gap-2", isMobile && "flex-col")}>
        <input
          className={cn(
            "h-8 flex-1 rounded-md border border-border bg-s2 px-3 text-[13px] text-t1 outline-none focus:border-accent",
            isMobile && "min-h-[44px]"
          )}
          type="text"
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runTest()}
          placeholder={t("lore_test_placeholder")}
        />
        <button type="button"
          className={cn(
            "h-8 cursor-pointer rounded-md bg-accent px-4 text-[12px] font-medium text-on-accent transition-all hover:opacity-90",
            isMobile && "min-h-[44px]"
          )}
          onClick={runTest}
          disabled={testingActivation}
        >
          {testingActivation ? "..." : t("lore_test_run")}
        </button>
      </div>
      {testResult && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md text-[12px] font-medium px-3 py-2",
            testResult.ok
              ? "border border-success bg-success-dim text-success-text"
              : "border border-danger bg-danger-dim text-danger-text"
          )}
        >
          {testResult.ok ? <Ic.check /> : <Ic.close />} {testResult.msg}
        </div>
      )}
      {testMutData && (
        <div className="flex items-center gap-2 rounded-md border border-success bg-success-dim px-3 py-2 text-[12px] font-medium text-success-text">
          <Ic.check /> {t("activated_label")} {testMutData.activatedIds.length} /{" "}
          {testMutData.totalEntries} {t("entries_label")}
        </div>
      )}
    </>
  );
}
