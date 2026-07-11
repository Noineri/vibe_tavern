/**
 * Small shared primitives for the prompt-order canvas: the `roleOptions` literal
 * (used by the author-note / character / injection row SegmentedControls), the
 * `PromptCanvasDraft` + `CharacterCanvasDraft` shapes (the editable fields the
 * canvas binds to), and the internal `CanvasItem` union (the canvas's per-slot
 * row model).
 *
 * Centralised here (rather than living in `InjectionTable.tsx`) so the row
 * components under `rows/` and `build-fixed-items.ts` can import them without a
 * circular value-dependency back into `InjectionTable.tsx`. `InjectionTable.tsx`
 * imports them back for its props + re-exports `CharacterCanvasDraft` for
 * `PromptManagerModal` / the characterization test.
 */
import type { ReactNode } from "react";

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

/** Character-V3 override fields the canvas binds to (only shown when present). */
export type CharacterCanvasDraft = {
  charSystemPrompt: string;
  charPostHistory: string;
  charDepthPrompt: string;
  charDepthPromptDepth: number;
  charDepthPromptRole: string;
};

/** A single row in the prompt-order canvas. `custom` rows carry their injection
 *  index; `slot`/`field` rows are the fixed built-in entries. The `render`
 *  closure defers JSX creation until the row is actually placed in a zone. */
export type CanvasItem =
  | { key: string; identifier: string; kind: "slot"; defaultOrder: number; render: () => ReactNode }
  | { key: string; identifier: string; kind: "field"; defaultOrder: number; render: () => ReactNode }
  | { key: string; identifier: string; kind: "custom"; defaultOrder: number; injectionIndex: number; render: () => ReactNode };
