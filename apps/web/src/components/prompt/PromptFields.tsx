import React, { useCallback } from "react";
import { cn } from "../../lib/cn.js";
import { TokenCounter } from "../shared/TokenCounter.js";
import { PrefillField } from "./PrefillField.js";
import { useT } from "../../i18n/context.js";

type DraftData = {
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  summary: string;
  tools: string;
};

interface PromptFieldsProps {
  draft: DraftData | null;
  onUpdateField: (key: keyof DraftData, value: string | number) => void;
  prefillSupported?: boolean;
}

const textareaCls = "w-full rounded-md border border-border bg-s2 font-ui text-[calc(var(--ui-fs)-1px)] text-t1 outline-none transition-colors focus:border-accent resize-none overflow-hidden disabled:opacity-60";
const labelCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3";
const labelAccentCls = "mb-[7px] block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-accent";

const autoResize = (e: React.FormEvent<HTMLTextAreaElement>) => {
  const ta = e.currentTarget;
  ta.style.height = "inherit";
  ta.style.height = `${ta.scrollHeight}px`;
};

const triggerResize = (el: HTMLTextAreaElement | null) => {
  if (el && el.value) {
    el.style.height = "inherit";
    el.style.height = `${el.scrollHeight}px`;
  }
};

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

export function PromptFields({ draft, onUpdateField, prefillSupported }: PromptFieldsProps) {
  const { t } = useT();
  const disabled = !draft;

  const ta = useCallback((key: keyof DraftData, placeholder: string, minH = 100) => (
    <textarea
      ref={triggerResize}
      className={textareaCls}
      style={{ padding: "9px 13px", minHeight: minH }}
      value={String(draft?.[key] ?? "")}
      onChange={(e) => { onUpdateField(key, e.target.value); autoResize(e); }}
      onInput={autoResize}
      placeholder={placeholder}
      disabled={disabled}
    />
  ), [draft, disabled, onUpdateField]);

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto scroll-smooth" style={{ padding: 20 }}>
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
        <div className="mb-[7px] flex items-center justify-between">
          <label className={labelCls} style={{ marginBottom: 0 }}>{t("authors_note_label")}</label>
          <div className="flex items-center gap-2">
            <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.06em] text-t3">{t("insert_depth_label")}</label>
            <input
              className="h-[30px] w-16 rounded-md border border-border bg-s2 px-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t1 outline-none transition-colors focus:border-accent disabled:opacity-60"
              type="number"
              min={0}
              title={t("insert_depth_hint")}
              value={draft?.authorsNoteDepth ?? 4}
              onChange={(e) => onUpdateField("authorsNoteDepth", Number(e.target.value))}
              disabled={disabled}
            />
          </div>
        </div>
        {ta("authorsNote", t("authors_note_placeholder"), 100)}
        <TokenCounter text={draft?.authorsNote ?? ""} />
      </div>

      <FieldSection label={t("summary")} token={draft?.summary ?? ""}>
        {ta("summary", t("summary_placeholder"), 100)}
      </FieldSection>

      <FieldSection label={t("tools")} token={draft?.tools ?? ""}>
        {ta("tools", t("tools_placeholder"), 100)}
      </FieldSection>
    </div>
  );
}
