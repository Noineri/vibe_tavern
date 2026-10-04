/**
 * The message AI editor's instruction field
 * (AI_EDITOR_INSTRUCTION_TEMPLATES step 3) — extracted from
 * MessageAiEditorModal.tsx for size discipline: the field owns its label
 * row, which now carries the «Шаблоны ▾» menu button on the right
 * (ai-instruction-templates-button.tsx), plus the textarea and hint. The
 * insert semantics live here with the field: an empty field takes the
 * template text verbatim; a non-empty one gets it appended after a newline.
 */
import { useCallback } from "react";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { lblCls } from "../../lib/field-tokens.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { AiInstructionTemplatesButton } from "./ai-instruction-templates-button.js";

export function AiInstructionField({
  instruction,
  onChange,
}: {
  instruction: string;
  onChange: (next: string) => void;
}) {
  const { tDynamic } = useT();

  const insertTemplate = useCallback(
    (text: string) => {
      onChange(instruction.trim().length > 0 ? `${instruction}\n${text}` : text);
    },
    [instruction, onChange],
  );

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className={cn(lblCls, "!mb-0")}>
          {tDynamic("message_ai_editor_instruction_label")}
        </label>
        <AiInstructionTemplatesButton instruction={instruction} onInsert={insertTemplate} />
      </div>
      <MobileExpandTextarea
        value={instruction}
        onChange={onChange}
        label={tDynamic("message_ai_editor_instruction_label")}
      >
        <AutoTextarea
          maxRows={12}
          minRows={4}
          placeholder={tDynamic("message_ai_editor_instruction_placeholder")}
          value={instruction}
          onChange={(e) => onChange(e.target.value)}
        />
      </MobileExpandTextarea>
      <div className="mt-1 font-ui text-[calc(var(--ui-fs)-4px)] text-t4">
        {tDynamic("message_ai_editor_instruction_hint")}
      </div>
    </div>
  );
}
