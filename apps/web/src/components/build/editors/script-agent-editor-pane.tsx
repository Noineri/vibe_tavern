import { useState, type ReactNode } from "react";
import type { Extension } from "@codemirror/state";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { MobileExpandCodeEditor } from "../../shared/MobileExpandCodeEditor.js";
import { GeneratingScrim } from "../../shared/generation-feedback.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import type { ScriptRecord } from "../../../api/types.js";
import type { ScriptDraftValues } from "../../../stores/script-draft-store.js";
import { SCRIPT_TEMPLATES, templateScriptKind } from "./script-templates/index.js";
import { ScriptApiReference } from "./script-api-reference.js";
import { ScriptTester } from "./ScriptTester.js";
import { DiceScriptTester } from "./DiceScriptTester.js";

/**
 * The script assistant's tabbed editor pane (AS-8c2) — a presentational clone
 * of the mini-app assistant's right pane (`experience-agent-host.tsx`): the
 * outer tab strip (`[Code | Test]`, default Code) sits in the model's strip
 * classes, the Code tab stacks the toolbar strip (templates + API reference),
 * the host's review-bar slot, and the model's code area, while the Test tab
 * holds the kind-picked tester in the model's Try-body classes.
 *
 * Named deviations from the model (the only ones): two tabs, not three
 * (scripts have no visual preview); no Rules/Visual sub-toggle and no
 * review-revert button (one code buffer; the script review bar keeps its own
 * accept/dismiss/cancel buttons); no description field in the toolbar strip
 * (it moves to the AS-8c1 management bar, wired by AS-8c3) and no validate
 * button (the tester tab covers it); templates always shown, as in the plain
 * script editor rather than only in a creation mode.
 *
 * Presentational only: every value arrives via explicit props (no store reads,
 * no review logic) — the host (`script-agent-host.tsx`) owns the review hook,
 * the extensions seam, the reviewed script, and the review-bar JSX.
 */

export interface ScriptAgentEditorTabsProps {
  isMobile: boolean;
  /** The reviewed script — the proposed text while a round is open. */
  script: ScriptRecord;
  scriptId: string | null;
  apiRefOpen: boolean;
  /** Lint + reveal + hunk-review decorations (the AS-8a seam, joined by the host). */
  extensions: Extension[];
  /** Freeze the code editor (the host passes `review !== null`). */
  codeReadOnly: boolean;
  isSending: boolean;
  /** A review round is open — lights the Code tab's pending dot. */
  reviewOpen: boolean;
  /** The host's review-bar JSX (or null) — rendered as is below the toolbar. */
  reviewBar: ReactNode;
  characterName: string | undefined;
  onUpdateDraft: (patch: Partial<ScriptDraftValues>) => void;
  onToggleApiRef: () => void;
  onAddFromTemplate: (key: string) => void;
  onRevealLine: (line: number) => void;
}

/** The outer editor tab — Code (templates + API reference + editor) or Test
 *  (the kind-picked script tester). */
type ScriptEditorTab = "code" | "check";

export function ScriptAgentEditorTabs({
  isMobile,
  script,
  scriptId,
  apiRefOpen,
  extensions,
  codeReadOnly,
  isSending,
  reviewOpen,
  reviewBar,
  characterName,
  onUpdateDraft,
  onToggleApiRef,
  onAddFromTemplate,
  onRevealLine,
}: ScriptAgentEditorTabsProps) {
  const { t, tDynamic } = useT();
  const [tab, setTab] = useState<ScriptEditorTab>("code");
  const scriptKind = script.scriptKind === "dice" ? "dice" : "prompt";
  const readOnly = isSending || codeReadOnly;

  // The Code tab carries a dot while a review round is open (CD-6) — the same
  // pending-changes signal the mini-app pane shows on ITS Code tab.
  const codeTabLabel = reviewOpen
    ? (
      <span className="inline-flex items-center gap-1.5">
        {t("agent_code")}
        <span
          data-testid="copilot-outer-dot-code"
          title={t("copilot_review_pending_badge")}
          className="h-1.5 w-1.5 rounded-full bg-accent"
        />
      </span>
    )
    : t("agent_code");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg max-md:overflow-y-auto">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <SegmentedControl
          value={tab}
          options={[
            { value: "code", label: codeTabLabel },
            { value: "check", label: t("script_tab_check") },
          ]}
          onChange={(value) => setTab(value === "check" ? "check" : "code")}
          compact
        />
      </div>

      {tab === "check" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {scriptKind === "dice" ? (
            <DiceScriptTester scriptId={scriptId} code={script.code} script={script} onRevealLine={(line) => onRevealLine(line)} isMobile={isMobile} characterName={characterName} />
          ) : (
            <ScriptTester scriptId={scriptId} code={script.code} script={script} onRevealLine={(line) => onRevealLine(line)} isMobile={isMobile} characterName={characterName} />
          )}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2">
            {/* Templates — only the active script's kind (SCRIPT_EDITOR_CLEANUP step 3) */}
            <div className="flex flex-col gap-1.5">
              <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_templates")}</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(SCRIPT_TEMPLATES).filter(([, tpl]) => templateScriptKind(tpl) === (script.scriptKind || "prompt")).map(([key, tpl]) => (
                  <button type="button" key={key} className="flex h-7 max-md:h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => onAddFromTemplate(key)}>{tDynamic("script_template_" + key) || tpl.name}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={cn("flex h-7 max-md:h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")}
                onClick={onToggleApiRef}
              >
                <Ic.book /> {t("script_api_reference")}
              </button>
            </div>
            {apiRefOpen && (
              <ScriptApiReference kind={scriptKind} />
            )}
          </div>
          {reviewBar}
          {/* 4a follow-up round 2: on mobile this container takes its NATURAL
              height (flex-none, no inner scroll) so the shell's pane root becomes
              the single scroll document — see the editorPane root comment in
              ExperienceCopilotShell.tsx. Desktop keeps the inner-scroll flex
              remainder exactly as before. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3 max-md:flex-none max-md:overflow-y-visible">
            {/* CD-3: frozen (read-only + shared GeneratingScrim dim) while the model
                works — the scrim alone dims the surface (same as the coauthor
                editor); no extra frame opacity, which would double-darken. */}
            {/* Mobile (4a follow-up): the frame grows to the document (h-auto)
                instead of filling the squeezed flex remainder — with the toolbar
                stack above (the visual buffer's five rows) the remainder collapsed
                to ~2px, making the editor unreachable. The scroll container above
                scrolls the grown frame. */}
            <div
              data-testid="copilot-editor-frame"
              className={cn(
                "relative h-full min-h-0 rounded-md border border-border bg-bg",
                "max-md:h-auto",
              )}
            >
              <MobileExpandCodeEditor
                value={script.code}
                onChange={(code) => onUpdateDraft({ code })}
                readOnly={readOnly}
                extensions={extensions}
                label={t("script_code_label")}
              >
                <CodeEditor
                  className="h-full max-md:h-auto"
                  value={script.code}
                  onChange={(code) => onUpdateDraft({ code })}
                  minHeight="300px"
                  scrollMode={isMobile ? "page" : "inner"}
                  readOnly={readOnly}
                  extensions={extensions}
                />
              </MobileExpandCodeEditor>
              {isSending && (
                <GeneratingScrim
                  variant="dim"
                  label={t("copilot_review_model_editing")}
                  pointerEvents="auto"
                  testId="copilot-editor-frozen"
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
