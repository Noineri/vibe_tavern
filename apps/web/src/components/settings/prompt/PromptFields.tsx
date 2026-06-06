import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn.js";
import { TokenCounter } from "../../shared/TokenCounter.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { PrefillField } from "./PrefillField.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { useT } from "../../../i18n/context.js";
import { SegmentedControl } from "../../shared/SegmentedControl.js";

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t4">{title}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ServiceField({ label, description, token, children }: {
  label: string;
  description: string;
  token: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-[7px] flex items-center justify-between">
        <label className="mb-0 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{label}</label>
        <TokenCounter text={token} />
      </div>
      <div className="mb-1.5 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{description}</div>
      {children}
    </div>
  );
}

type DraftData = {
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: string;
  summary: string;
  tools: string;
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: Record<string, string>;
};

interface PromptFieldsProps {
  draft: DraftData | null;
  onUpdateField: (key: keyof DraftData, value: string | number | Record<string, string>) => void;
  prefillSupported?: boolean;
  resetKey?: string | null;
  hideChatPrompts?: boolean;
}

const textareaCls = "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none overflow-hidden disabled:opacity-60";
const labelCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";
const labelAccentCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-accent";

type TextDraftKey = Exclude<keyof DraftData, "authorsNoteDepth" | "authorsNotePosition" | "aiAssistantPrompts">;

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function resizeTextarea(el: HTMLTextAreaElement, allowShrink: boolean): void {
  const scrollParent = findScrollParent(el);
  const scrollTop = scrollParent?.scrollTop ?? 0;

  if (allowShrink) el.style.height = "auto";

  const minHeight = Number.parseFloat(window.getComputedStyle(el).minHeight) || 0;
  const nextHeight = Math.max(el.scrollHeight, minHeight);
  const currentHeight = el.getBoundingClientRect().height;

  if (allowShrink || nextHeight > currentHeight) {
    el.style.height = `${nextHeight}px`;
  }

  // While typing in a long field, avoid browser scroll anchoring reacting to
  // textarea shrink-grow recalculation and making the modal jump.
  if (!allowShrink && scrollParent) scrollParent.scrollTop = scrollTop;
}

function AutoResizeTextarea({
  fieldKey,
  value,
  placeholder,
  minHeight,
  disabled,
  resetKey,
  onChange,
}: {
  fieldKey: TextDraftKey;
  value: string;
  placeholder: string;
  minHeight: number;
  disabled: boolean;
  resetKey?: string | null;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const prevResetKeyRef = useRef(resetKey);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const resetChanged = prevResetKeyRef.current !== resetKey;
    prevResetKeyRef.current = resetKey;
    const isActive = document.activeElement === el;

    resizeTextarea(el, resetChanged || !isActive);
    if (resetChanged) el.scrollTop = 0;
  }, [value, resetKey, minHeight]);

  return (
    <textarea
      key={`${resetKey ?? "none"}:${fieldKey}`}
      ref={ref}
      className={cn(textareaCls, "px-[13px] py-[9px]")}
      style={{ minHeight }}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        resizeTextarea(e.currentTarget, false);
      }}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

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

export function PromptFields({ draft, onUpdateField, prefillSupported, resetKey, hideChatPrompts = false }: PromptFieldsProps) {
  const { t } = useT();
  const disabled = !draft;
  const [serviceOpen, setServiceOpen] = useState(false);

  const aiAssistantModes = [
    { key: "script", labelKey: "ai_assistant_mode_script" },
    { key: "lore_entry", labelKey: "ai_assistant_mode_lore_entry" },
    { key: "lore_keys", labelKey: "ai_assistant_mode_lore_keys" },
    { key: "chat_impersonate", labelKey: "ai_assistant_mode_chat_impersonate" },
  ] as const;

  const ta = useCallback((key: TextDraftKey, placeholder: string, minH = 100, labelKey?: string) => (
    <MobileExpandTextarea value={String(draft?.[key] ?? "")} onChange={(v) => onUpdateField(key, v)} label={labelKey ? t(labelKey) : undefined}>
    <AutoResizeTextarea
      fieldKey={key}
      value={String(draft?.[key] ?? "")}
      placeholder={placeholder}
      minHeight={minH}
      disabled={disabled}
      resetKey={resetKey}
      onChange={(value) => onUpdateField(key, value)}
    />
    </MobileExpandTextarea>
  ), [draft, disabled, onUpdateField, resetKey]);

  return (
    <div className="flex min-w-0 flex-col gap-6 scroll-smooth p-3 sm:p-5">
      {!hideChatPrompts && (
        <>
          <SectionHeader title={t("prompt_section_chat")} />

          <FieldSection label={t("system_prompt")} labelClassName={labelAccentCls} token={draft?.system ?? ""}>
            {ta("system", t("system_prompt_placeholder"), 240)}
          </FieldSection>

          <FieldSection label={t("post_history_instructions")} token={draft?.jailbreak ?? ""}>
            {ta("jailbreak", t("jailbreak_placeholder"), 100)}
          </FieldSection>

          <PrefillField
            prefill={draft?.prefill ?? ""}
            onUpdate={(value) => onUpdateField("prefill", value)}
            disabled={disabled}
            prefillSupported={prefillSupported}
          />

          <div>
            <div className="mb-[7px] flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label className={labelCls + " mb-0"}>{t("authors_note_label")}</label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <SegmentedControl
                  value={draft?.authorsNotePosition ?? "in_chat"}
                  options={[
                    { value: "in_prompt", label: t("an_position_in_prompt") },
                    { value: "in_chat", label: t("an_position_in_chat") },
                    { value: "after_chat", label: t("an_position_after_chat") },
                  ]}
                  onChange={(v) => onUpdateField("authorsNotePosition", v)}
                  disabled={disabled}
                  compact
                  mobileFill
                />
                {(draft?.authorsNotePosition ?? "in_chat") === "in_chat" && (
                  <div className="flex items-center justify-between gap-2 sm:justify-start">
                    <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{t("insert_depth_label")}</label>
                    <CustomTooltip content={t("insert_depth_hint")}>
                    <input
                      className="h-9 w-20 rounded-md border border-border bg-s2 px-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none transition-colors focus:border-accent disabled:opacity-60 sm:h-[30px] sm:w-16"
                      type="number"
                      min={0}
                      value={draft?.authorsNoteDepth ?? 4}
                      onChange={(e) => onUpdateField("authorsNoteDepth", Number(e.target.value))}
                      disabled={disabled}
                    />
                    </CustomTooltip>
                  </div>
                )}
              </div>
            </div>
            {ta("authorsNote", t("authors_note_placeholder"), 100)}
            <TokenCounter text={draft?.authorsNote ?? ""} />
          </div>

          <div className="h-2" />
        </>
      )}

      <div className="rounded-md border border-border2 bg-s1/40">
        <button type="button"
          className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-s2/70"
          onClick={() => setServiceOpen((v) => !v)}
        >
          <span className={cn("font-ui text-[13px] text-t4 transition-transform", serviceOpen && "rotate-180")}>▾</span>
          <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.08em] text-t4">{t("prompt_section_service")}</span>
          <div className="h-px flex-1 bg-border" />
        </button>
        {serviceOpen && (
          <div className="flex flex-col gap-6 border-t border-border2 p-3 pt-4">
            <div className="font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t("prompt_section_service_desc")}</div>

            <ServiceField label={t("summary")} description={t("summary_desc")} token={draft?.summary ?? ""}>
              {ta("summary", t("summary_placeholder"), 100)}
            </ServiceField>

            <SectionHeader title={t("ai_assistant_section")} />
            <div className="font-ui text-[calc(var(--ui-fs)-4px)] text-t4">{t("ai_assistant_section_desc")}</div>

            {aiAssistantModes.map(({ key, labelKey }) => {
              const value = key === "script"
                ? (draft?.aiAssistantPrompts?.[key] || draft?.scriptAiSystemPrompt || "")
                : (draft?.aiAssistantPrompts?.[key] ?? "");
              return (
                <div key={key}>
                  <div className="mb-[7px] flex items-center justify-between">
                    <label className="mb-0 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{t(labelKey)}</label>
                    <TokenCounter text={value} />
                  </div>
                  <AutoResizeTextarea
                    fieldKey={key as TextDraftKey}
                    value={value}
                    placeholder={t("ai_assistant_mode_default_placeholder")}
                    minHeight={80}
                    disabled={disabled}
                    resetKey={resetKey}
                    onChange={(v) => {
                      const updated = { ...(draft?.aiAssistantPrompts ?? {}), [key]: v };
                      if (!v.trim()) delete updated[key];
                      onUpdateField("aiAssistantPrompts", updated);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
