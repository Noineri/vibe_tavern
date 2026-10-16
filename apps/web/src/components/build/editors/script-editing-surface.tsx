import type { Extension } from "@codemirror/state";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { lblCls } from "../../../lib/field-tokens.js";
import { Ic } from "../../shared/icons.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { Toggle } from "../../shared/Toggle.js";
import { TextInput } from "../../shared/text-input.js";
import {
  LinkBindingPopover,
  type LinkBindingRecord,
  type LinkTarget,
} from "../../shared/LinkBindingPopover.js";
import type { ScriptLinkRecord, ScriptRecord } from "../../../api/types.js";
import type {
  ScriptDraftSaveState,
  ScriptDraftValues,
} from "../../../stores/script-draft-store.js";
import { SCRIPT_TEMPLATES, templateScriptKind } from "./script-templates/index.js";
import { ScriptSafetyBanner } from "./script-safety/ScriptSafetyBanner.js";
import { ScriptApiReference } from "./script-api-reference.js";
import { ScriptTester } from "./ScriptTester.js";
import { DiceScriptTester } from "./DiceScriptTester.js";

// The whole script editing surface (save bar → name/kind → links → «Справка
// API» toggle + reference → code editor → templates → tester) as ONE
// presentational component. useScriptPanel (ScriptEditor.tsx) owns every bit
// of state/effects/store wiring and renders this where the panel JSX used to
// be — DOM, classes, testids and order are byte-identical. Every value the
// JSX consumes arrives via explicit props (no store reads, no new context),
// so AS-8b can render the same surface inside the agent shell's editor pane:
// the live-code seams are scriptSafetyExtensions (hunk-review decorations
// join here) and onUpdateDraft/onRevealLine.

export interface ScriptEditingSurfaceProps {
  isMobile: boolean;
  activeScript: ScriptRecord | null;
  activeScriptId: string | null;
  draftDirty: boolean;
  draftSaveState: ScriptDraftSaveState;
  draftError: string | null | undefined;
  scriptLinks: ScriptLinkRecord[];
  linkCharacters: LinkTarget[];
  linkPersonas: LinkTarget[];
  apiRefOpen: boolean;
  scriptSafetyExtensions: Extension[];
  characterName: string | undefined;
  onSave: () => void;
  onUpdateDraft: (patch: Partial<ScriptDraftValues>) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDeleteRequest: (id: string) => void;
  onSetScriptLinks: (
    next: Array<{ targetType: "character" | "persona"; targetId: string }>,
  ) => void;
  onToggleApiRef: () => void;
  onOpenAiHelper: () => void;
  onAddFromTemplate: (key: string) => void;
  onRevealLine: (line: number) => void;
}

export function ScriptEditingSurface({
  isMobile,
  activeScript,
  activeScriptId,
  draftDirty,
  draftSaveState,
  draftError,
  scriptLinks,
  linkCharacters,
  linkPersonas,
  apiRefOpen,
  scriptSafetyExtensions,
  characterName,
  onSave,
  onUpdateDraft,
  onToggleEnabled,
  onDeleteRequest,
  onSetScriptLinks,
  onToggleApiRef,
  onOpenAiHelper,
  onAddFromTemplate,
  onRevealLine,
}: ScriptEditingSurfaceProps) {
  const { t, tDynamic } = useT();

  // ── Script editor panel (for LorebookEditor editor view) ──
  return activeScript ? (
    <div className={cn("mx-auto max-w-[860px]",
      // D3 (v1.2.1): same exclusion as LorebookEditor — the blanket min-h
      // stretched Toggle tracks (role=switch) into oversized blobs.
      isMobile && "pb-[calc(4rem+env(safe-area-inset-bottom,0px))] [&_button:not([role=switch])]:min-h-[40px] [&_input]:text-base")}>
      {/* Explicit-save status + action. Ctrl/Cmd+S calls the same handler. */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border bg-s2 px-3 py-2">
        <span
          className={cn("min-w-0 truncate font-ui text-[12px]", draftSaveState === "error" ? "text-danger" : "text-t3")}
          title={draftError ?? undefined}
        >
          {draftSaveState === "error" ? t("retry") : draftDirty ? t("unsaved_changes") : t("saved_state")}
        </span>
        <SaveButton
          dirty={draftDirty}
          saveState={draftSaveState}
          resetKey={activeScriptId}
          onClick={onSave}
          label={draftSaveState === "error" ? t("retry") : t("save")}
        />
      </div>

      {/* Header: name + toggle + delete */}
      <div className="flex flex-col gap-3" style={{ marginBottom: 16 }}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1"><TextInput value={activeScript.name} onChange={(e) => onUpdateDraft({ name: e.target.value })} placeholder={t("script_name")} /></div>
          <Toggle checked={activeScript.enabled} onChange={onToggleEnabled} />
          <CustomTooltip content={t("delete_script_confirm")}>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2" onClick={() => onDeleteRequest(activeScript.id)}><Ic.del /></div>
          </CustomTooltip>
        </div>
        <div className="flex items-center">
          {/* Script kind is immutable after creation — set via the New Script /
              New Dice Script buttons. Shown as a read-only badge so the user
              always sees which runtime a script targets. The previous kind
              toggle was removed: it could never persist (updateScriptSchema
              excludes scriptKind), so it silently reverted on save. */}
          <div className="rounded px-2 py-1 font-ui text-[11px] uppercase tracking-wide bg-s3 text-t2">
            {activeScript.scriptKind === "dice" ? t("script_kind_dice") : t("script_kind_prompt")}
          </div>
        </div>
      </div>

      {/* Imported-script banner (SS-6): near the enable toggle, above the
          code. Renders only for untrusted imports — no layout shift for
          trusted/in-app scripts. */}
      <ScriptSafetyBanner script={activeScript} />

      {/* Description */}
      <div style={{ marginBottom: 16 }}>
        <label className={lblCls}>{t("script_desc_label")}</label>
        <TextInput value={activeScript.description ?? ""} onChange={(e) => onUpdateDraft({ description: e.target.value })} placeholder={t("script_desc_placeholder")} />
      </div>

      {/* Entity scripts bind to characters/personas; global scripts run unconditionally and chat scripts are chat-bound. */}
      {activeScript.scopeType === "entity" && (
        <div style={{ marginBottom: 16 }}>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_links_label")}</span>
            <CustomTooltip content={t("script_links_hint")}>
              <span className="cursor-help text-t4 text-[11px]">ⓘ</span>
            </CustomTooltip>
          </div>
          <LinkBindingPopover
            links={scriptLinks}
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

      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")} onClick={onToggleApiRef}><Ic.book /> {t("script_api_reference")}</button>
        <button type="button" className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={onOpenAiHelper}><Ic.brain /> {t("script_ai_helper")}</button>
      </div>

      {/* API Reference */}
      {apiRefOpen && (
        <ScriptApiReference kind={activeScript.scriptKind || "prompt"} />
      )}

      {/* Code editor */}
      <div style={{ marginBottom: 20 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_code_label")}</label>
        <div className="relative rounded-md border border-border bg-bg">
          <CodeEditor
            value={activeScript.code}
            onChange={(code) => onUpdateDraft({ code })}
            minHeight={isMobile ? "220px" : "300px"}
            scrollMode={isMobile ? "page" : "inner"}
            extensions={scriptSafetyExtensions}
          />
        </div>
      </div>

      {/* Templates — only the active script's kind (SCRIPT_EDITOR_CLEANUP step 3) */}
      <div className="mb-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_templates")}</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SCRIPT_TEMPLATES).filter(([, tpl]) => templateScriptKind(tpl) === (activeScript.scriptKind || "prompt")).map(([key, tpl]) => (
            <button type="button" key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => onAddFromTemplate(key)}>{tDynamic("script_template_" + key) || tpl.name}</button>
          ))}
        </div>
      </div>

      {activeScript.scriptKind === "dice" ? (
        <DiceScriptTester scriptId={activeScriptId} code={activeScript.code} script={activeScript} onRevealLine={(line) => onRevealLine(line)} isMobile={isMobile} characterName={characterName} />
      ) : (
        <ScriptTester scriptId={activeScriptId} code={activeScript.code} script={activeScript} onRevealLine={(line) => onRevealLine(line)} isMobile={isMobile} characterName={characterName} />
      )}
    </div>
  ) : (
    <div className="flex h-full items-center justify-center text-t3 font-ui text-[13px] italic">
      {t("script_test_no_result")}
    </div>
  );
}
