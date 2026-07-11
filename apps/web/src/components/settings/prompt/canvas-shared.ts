/**
 * Small shared primitives for the prompt-order canvas: the `roleOptions` literal
 * (used by the author-note / character / injection row SegmentedControls) and
 * the `PromptCanvasDraft` shape (the editable preset fields the canvas binds to).
 *
 * Centralised here (rather than living in `InjectionTable.tsx`) so the row
 * components under `rows/` can import `roleOptions` as a value without a circular
 * value-dependency back into `InjectionTable.tsx`. `PromptCanvasDraft` is a type,
 * but co-locating it with `roleOptions` keeps the canvas's shared surface in one
 * place; `InjectionTable.tsx` imports it back for `InjectionTableProps`.
 */

/** Message-role options offered by the editable row cards' role SegmentedControl. */
export const roleOptions = ["system", "user", "assistant"] as const;

/** The editable preset fields the prompt-order canvas binds to (the modal's draft). */
export type PromptCanvasDraft = {
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: string;
  authorsNoteRole: string;
  nsfw: string;
  enhanceDefinitions: string;
};
