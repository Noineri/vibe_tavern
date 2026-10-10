import type { ReactNode } from "react";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { lblCls } from "../../../lib/field-tokens.js";

export function PromptField({
  label,
  hint,
  defaultValue,
  onSave,
  action,
}: {
  label: string;
  hint: string;
  defaultValue: string;
  onSave: (value: string) => void;
  action?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <label className={lblCls + " !mb-0"}>{label}</label>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <div className="mt-1.5">
        {/* Uncontrolled field (defaultValue + commit-on-blur). Its value can change
            outside the textarea through an AI replacement, chat switch, or
            background sync, but React never re-seeds an uncontrolled input from a
            changed defaultValue. Without the key the DOM keeps stale text (making
            an AI replacement invisible) and a later blur writes it back over the
            fresh draft. The key remount re-seeds after every external change while
            preserving blur-commit semantics: user typing never changes defaultValue
            mid-edit, so it never remounts under the caret. */}
        <AutoTextarea
          key={defaultValue}
          mono
          defaultValue={defaultValue}
          placeholder={hint}
          minRows={2}
          onBlur={(event) => {
            if (event.target.value !== defaultValue) onSave(event.target.value);
          }}
        />
      </div>
    </div>
  );
}
