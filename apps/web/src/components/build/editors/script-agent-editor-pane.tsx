// fork #1 of the experience host editor pane (copilot/experience-agent-host.tsx)
// and fork #1 of the AgentBufferReviewEditor code area
// (shared/agent-shell/AgentBufferReviewEditor.tsx) — see the doc comment below.
import { type ReactNode } from "react";
import type { Extension } from "@codemirror/state";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { MobileExpandCodeEditor } from "../../shared/MobileExpandCodeEditor.js";
import { ScrollArea } from "../../shared/scroll-area.js";
import { GeneratingScrim } from "../../shared/generation-feedback.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { TextInput } from "../../shared/text-input.js";
import {
  LinkBindingPopover,
  type LinkBindingRecord,
  type LinkTarget,
} from "../../shared/LinkBindingPopover.js";
import type { ScriptLinkRecord, ScriptRecord } from "../../../api/types.js";
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
 * accept/dismiss/cancel buttons); no validate button (the tester tab covers
 * it) while the toolbar strip OPENS with the description field plus the
 * entity-only links block (owner decision 2026-10-17, AS-8c4e, layout Б —
 * moved from the AS-8c1 management bar above the templates row); templates
 * always shown, as in the plain script editor, not only in creation mode.
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
  /** The host pane's selected tab (controlled since AP-15). */
  tab: ScriptEditorTab;
  /** Switch the tab (the host pane owns the state). */
  onTabChange: (tab: ScriptEditorTab) => void;
  /** The host's review-bar JSX (or null) — rendered as is below the toolbar. */
  reviewBar: ReactNode;
  characterName: string | undefined;
  /** Bound characters/personas (entity scripts only) — the toolbar strip's links block. */
  links: ScriptLinkRecord[];
  linkCharacters: LinkTarget[];
  linkPersonas: LinkTarget[];
  onSetScriptLinks: (
    next: Array<{ targetType: "character" | "persona"; targetId: string }>,
  ) => void;
  onUpdateDraft: (patch: Partial<ScriptDraftValues>) => void;
  onToggleApiRef: () => void;
  onAddFromTemplate: (key: string) => void;
  onRevealLine: (line: number) => void;
}

/** The outer editor tab — Code (templates + API reference + editor) or Test
 *  (the kind-picked script tester). Owned by the host pane (AP-15 lifted it
 *  out of this presentational component so the pending-review seam can
 *  switch back to the review surface). */
export type ScriptEditorTab = "code" | "check";

export function ScriptAgentEditorTabs({
  isMobile,
  script,
  scriptId,
  apiRefOpen,
  extensions,
  codeReadOnly,
  isSending,
  reviewOpen,
  tab,
  onTabChange,
  reviewBar,
  characterName,
  links,
  linkCharacters,
  linkPersonas,
  onSetScriptLinks,
  onUpdateDraft,
  onToggleApiRef,
  onAddFromTemplate,
  onRevealLine,
}: ScriptAgentEditorTabsProps) {
  const { t, tDynamic } = useT();
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

  // CNR-8o: the pane root rides the thin ScrollArea lane — on mobile
  // (Code tab) it stays the single scroll DOCUMENT (max-md overflow was
  // the pane's own job before; the lane's viewport owns it now); on
  // desktop the content column is h-full so children keep their own
  // inner scrollers and the lane never overflows (no chrome mounts).
  return (
    <ScrollArea
      scrollbarSize="thin"
      className="min-h-0 min-w-0 flex-1 bg-bg"
      contentClassName="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <SegmentedControl
          value={tab}
          options={[
            { value: "code", label: codeTabLabel },
            { value: "check", label: t("script_tab_check") },
          ]}
          onChange={(value) => onTabChange(value === "check" ? "check" : "code")}
          compact
        />
      </div>

      {/* CNR-8o: the Test tab body rides the thin vertical lane (both
          viewports — it scrolled internally before too); the p-3 padding
          scrolls with the content (ScriptEditor 8j idiom). */}
      {tab === "check" ? (
        <ScrollArea scrollbarSize="thin" className="min-h-0 flex-1" contentClassName="p-3">
          {scriptKind === "dice" ? (
            <DiceScriptTester scriptId={scriptId} code={script.code} script={script} onRevealLine={(line) => onRevealLine(line)} isMobile={isMobile} characterName={characterName} />
          ) : (
            <ScriptTester scriptId={scriptId} code={script.code} script={script} onRevealLine={(line) => onRevealLine(line)} isMobile={isMobile} characterName={characterName} />
          )}
        </ScrollArea>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2">
            {/* Description first, then the entity-only links as a separate
                block (owner 2026-10-17, AS-8c4g): label-above-chips is the
                project's binding pattern (character editor, regex profile) —
                the side-by-side layout squeezed the chips beside the input. */}
            <div>
              <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_desc_label")}</label>
              <TextInput
                value={script.description ?? ""}
                onChange={(e) => onUpdateDraft({ description: e.target.value })}
                placeholder={t("script_desc_placeholder")}
              />
            </div>

            {/* Entity scripts bind to characters/personas; global scripts run
                unconditionally and chat scripts are chat-bound. */}
            {script.scopeType === "entity" && (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_links_label")}</span>
                  <CustomTooltip content={t("script_links_hint")}>
                    <span className="cursor-help text-t4 text-[calc(var(--ui-fs)-3px)]">ⓘ</span>
                  </CustomTooltip>
                </div>
                <LinkBindingPopover
                  links={links}
                  characters={linkCharacters}
                  personas={linkPersonas}
                  onSetLinks={(next: LinkBindingRecord[]) => {
                    onSetScriptLinks(next
                      .filter((link): link is { targetType: "character" | "persona"; targetId: string } =>
                        link.targetType === "character" || link.targetType === "persona",
                      )
                      .map(({ targetType, targetId }) => ({ targetType, targetId })));
                  }}
                  t={t}
                  isMobile={isMobile}
                  tooltipLabel={t("script_links_add")}
                  emptyLabel={t("script_links_empty")}
                />
              </div>
            )}
            {/* Templates — only the active script's kind (SCRIPT_EDITOR_CLEANUP step 3) */}
            <div className="flex flex-col gap-1.5">
              <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_templates")}</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(SCRIPT_TEMPLATES).filter(([, tpl]) => templateScriptKind(tpl) === (script.scriptKind || "prompt")).map(([key, tpl]) => (
                  <button type="button" key={key} className="flex h-7 max-md:h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => onAddFromTemplate(key)}>{tDynamic("script_template_" + key) || tpl.name}</button>
                ))}
                <button
                  type="button"
                  className={cn("flex h-7 max-md:h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")}
                  onClick={onToggleApiRef}
                >
                  <Ic.book /> {t("script_api_reference")}
                </button>
              </div>
            </div>
            {apiRefOpen && (
              <ScriptApiReference kind={scriptKind} />
            )}
          </div>
          {reviewBar}
          {/* CNR-8o delegation (fork of the AgentBufferReviewEditor code area):
              the editor area rides the outer biaxial thin ScrollArea — ONE
              scroller per surface. CodeMirror runs in page mode on BOTH
              viewports (`.cm-scroller` overflow neutralized — probe C), so
              the desktop viewport owns the scroll the `.cm-scroller` owned.
              Mobile keeps the 4a follow-up contract: the root takes its
              NATURAL height (max-md:flex-none) so the pane-root lane above
              stays the single scroll document. The frame fills the lane
              while the document is short (flex-1 + min-h-full) and grows
              past it when long. */}
          <ScrollArea
            scrollbarSize="thin"
            orientation="both"
            className="min-h-0 flex-1 max-md:flex-none"
            contentClassName="flex min-h-full flex-col p-3"
          >
            {/* CD-3: frozen (read-only + shared GeneratingScrim dim) while the model
                works — the scrim alone dims the surface (same as the coauthor
                editor); no extra frame opacity, which would double-darken. */}
            <div
              data-testid="copilot-editor-frame"
              className="relative flex-1 rounded-md border border-border bg-bg"
            >
              <MobileExpandCodeEditor
                value={script.code}
                onChange={(code) => onUpdateDraft({ code })}
                readOnly={readOnly}
                extensions={extensions}
                label={t("script_code_label")}
              >
                <CodeEditor
                  value={script.code}
                  onChange={(code) => onUpdateDraft({ code })}
                  minHeight="300px"
                  scrollMode="page"
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
          </ScrollArea>
        </>
      )}
    </ScrollArea>
  );
}
