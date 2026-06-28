import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/context.js";
import { Modal } from "./Modal.js";
import { inputCls, inputPad, lblCls } from "../build/fields/field-styles.js";
import { useIsMobile } from "../../hooks/use-mobile.js";

interface PromptModalProps {
  /** Modal heading. */
  title: string;
  /** Visible label above the input (also the accessible name). */
  label: string;
  /** Pre-filled value (selected on open so typing replaces it). */
  defaultValue?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Confirm button text. Defaults to t("confirm"). */
  confirmLabel?: string;
  /** Called with the trimmed value on confirm. Never called with an empty string. */
  onConfirm: (value: string) => void;
  /** Called on dismiss (Escape, overlay click, Cancel). */
  onCancel: () => void;
}

/**
 * Generic single-line text-input modal — the in-app replacement for
 * `window.prompt()`. Mirrors {@link DestructiveConfirmModal} in layout and
 * styling; uses the shared Build Mode input styles so it matches the design
 * system. Enter confirms, Escape cancels (via Radix Dialog), and the confirm
 * button is disabled while the value is empty/whitespace.
 */
export function PromptModal(input: PromptModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [value, setValue] = useState(input.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus + select-on-open so the caller's defaultValue can be replaced
  // by simply typing (matches window.prompt's select-all behavior).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const trimmed = value.trim();
  const submit = () => {
    if (!trimmed) return;
    input.onConfirm(trimmed);
  };

  return (
    <Modal open={true} onClose={input.onCancel} overlayClassName="z-[700]" hideOverlay title={input.title}>
      <div className="w-[380px] rounded-lg border border-border bg-surface p-7 shadow-xl">
        <div className="mb-4 text-base font-medium text-t1">
          {input.title}
        </div>
        <label className={lblCls + " mb-1.5 block"}>{input.label}</label>
        <input
          ref={inputRef}
          type="text"
          className={inputCls + (isMobile ? " text-base" : "")}
          style={inputPad}
          value={value}
          placeholder={input.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-6 flex justify-end gap-2.5">
          <button type="button"
            className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
            onClick={input.onCancel}
          >
            {t("cancel")}
          </button>
          <button type="button"
            className="h-8 cursor-pointer rounded-md border-0 bg-accent px-[18px] font-ui text-[12.5px] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
            disabled={!trimmed}
          >
            {input.confirmLabel || t("confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
