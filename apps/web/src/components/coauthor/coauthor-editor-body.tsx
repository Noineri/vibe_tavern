/**
 * CoauthorCharacterForm editor body (extracted, CNR-8r arch-gate extraction).
 *
 * The label + CodeMirror host + hint row that rides the form's thin scroll
 * lane. Extracted as its own module so the parent stays under the file-size
 * budget; the CM host ref stays owned by the parent (it wires EditorView).
 */
import type { RefObject } from "react";
import { lblCls } from "../../lib/field-tokens.js";

export function CoauthorEditorBody(props: {
  /** Host element the parent attaches the CodeMirror EditorView to. */
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly label: string;
  readonly hint: string;
}) {
  return (
    <>
      <label className={lblCls}>{props.label}</label>
      <div
        ref={props.hostRef}
        className="vibe-md-editor min-h-[360px] max-md:min-h-[calc(100dvh-140px)] rounded-lg border border-border"
      />
      <p className="mt-1.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t4">{props.hint}</p>
    </>
  );
}
