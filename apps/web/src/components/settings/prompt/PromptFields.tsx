import React, { useCallback } from "react";
import { cn } from "../../../lib/cn.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { PrefillField } from "./PrefillField.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t4">{title}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Chat-level prompt fields of a preset (system / jailbreak / prefill /
 * author's note). The former "Service Prompts" section (summary + AI-assistant
 * mode overrides) moved to the dedicated «Служебные» tab (ServicePromptsPane,
 * SP-8/SP-9); the service-related draft fields stay in the preset DTO only as
 * migration source data (SP-7).
 */
type DraftData = {
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: string;
  authorsNoteRole: string;
};

interface PromptFieldsProps {
  draft: DraftData | null;
  onUpdateField: (key: keyof DraftData, value: string | number) => void;
  prefillSupported?: boolean;
  resetKey?: string | null;
  hideChatPrompts?: boolean;
}

const textareaCls = "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none overflow-hidden disabled:opacity-60";
const labelCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";
const labelAccentCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-accent";

type TextDraftKey = Exclude<keyof DraftData, "authorsNoteDepth" | "authorsNotePosition" | "authorsNoteRole">;

function FieldSection({ label, labelClassName, token, children }: {
  label: string;
  labelClassName?: string;
  token: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={labelClassName || labelCls}>{label}</label>
      {children}
      <TokenCounter text={token} />
    </div>
  );
}

export function PromptFields({ draft, onUpdateField, prefillSupported, hideChatPrompts = false }: PromptFieldsProps) {
  const { t, tDynamic } = useT();
  const disabled = !draft;

  const ta = useCallback((key: TextDraftKey, placeholder: string, minRows = 5, labelKey?: string) => (
    <MobileExpandTextarea value={String(draft?.[key] ?? "")} onChange={(v) => onUpdateField(key, v)} label={labelKey ? tDynamic(labelKey) : undefined}>
    <AutoTextarea
      className={cn(textareaCls, "px-[13px] py-[9px]")}
      minRows={minRows}
      value={String(draft?.[key] ?? "")}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onUpdateField(key, e.target.value)}
    />
    </MobileExpandTextarea>
  ), [draft, disabled, onUpdateField, tDynamic]);

  return (
    <div className="flex min-w-0 flex-col gap-6 scroll-smooth">
      {!hideChatPrompts && (
        <>
          <SectionHeader title={t("prompt_section_chat")} />

          <FieldSection label={t("system_prompt")} labelClassName={labelAccentCls} token={draft?.system ?? ""}>
            {ta("system", t("system_prompt_placeholder"), 12)}
          </FieldSection>

          <FieldSection label={t("post_history_instructions")} token={draft?.jailbreak ?? ""}>
            {ta("jailbreak", t("jailbreak_placeholder"))}
          </FieldSection>

          <PrefillField
            prefill={draft?.prefill ?? ""}
            onUpdate={(value) => onUpdateField("prefill", value)}
            disabled={disabled}
            prefillSupported={prefillSupported}
          />

          <div>
            <div className="mb-[7px] flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <label className={labelCls + " mb-0"}>{t("authors_note_label")}</label>

              <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-4">
                <div className="flex items-center gap-2">
                  <span className="font-ui text-[11px] font-medium uppercase tracking-wider text-t3">{t("role")}</span>
                  <DropdownSelect
                    className="w-[120px]"
                    searchable={false}
                    value={draft?.authorsNoteRole ?? "system"}
                    options={[
                      { id: "system", label: "system" },
                      { id: "user", label: "user" },
                      { id: "assistant", label: "assistant" },
                    ]}
                    onChange={(v) => onUpdateField("authorsNoteRole", v)}
                    disabled={disabled}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <span className="font-ui text-[11px] font-medium uppercase tracking-wider text-t3">{t("position_label")}</span>
                  <DropdownSelect
                    className="w-[180px]"
                    searchable={false}
                    value={draft?.authorsNotePosition ?? "in_chat"}
                    options={[
                      { id: "in_prompt", label: t("an_position_in_prompt") },
                      { id: "in_chat", label: t("an_position_in_chat") },
                      { id: "after_chat", label: t("an_position_after_chat") },
                    ]}
                    onChange={(v) => onUpdateField("authorsNotePosition", v)}
                    disabled={disabled}
                  />
                  {(draft?.authorsNotePosition ?? "in_chat") === "in_chat" && (
                    <CustomTooltip content={`${t("insert_depth_label")}: ${t("insert_depth_hint")}`}>
                      <div className="flex items-center gap-2">
                        <span aria-hidden="true" className="font-mono text-[12px] text-t3">←</span>
                        <span className="sr-only">{t("insert_depth_label")}</span>
                        <input
                          type="number"
                          className="h-[33px] w-[46px] rounded-[6px] border border-border bg-s2 px-1 text-center font-ui text-[13px] text-t1 outline-none transition-[border-color] hover:border-accent focus:border-accent disabled:opacity-50"
                          min={0}
                          value={draft?.authorsNoteDepth ?? 4}
                          onChange={(e) => onUpdateField("authorsNoteDepth", parseInt(e.target.value) || 0)}
                          disabled={disabled}
                        />
                      </div>
                    </CustomTooltip>
                  )}
                </div>
              </div>
            </div>
            {ta("authorsNote", t("authors_note_placeholder"))}
            <TokenCounter text={draft?.authorsNote ?? ""} />
          </div>

          <div className="h-2" />
        </>
      )}
    </div>
  );
}
