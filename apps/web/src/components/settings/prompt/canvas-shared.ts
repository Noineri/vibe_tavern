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

/** The three canvas roles (mirrors the DB-backed string columns, narrowed). */
export type CanvasRole = (typeof roleOptions)[number];

const CANVAS_ROLE_SET = new Set<string>(roleOptions);

/** Narrow a DB/entity-backed role string to `CanvasRole` with a safe fallback.
 *  Used at the boundary where preset/character draft fields (typed `string`
 *  because they originate from SQLite text columns) meet the strictly-typed
 *  `CanvasCard.role` prop. Runtime-checked — not a blind cast. */
export function coerceRole(value: string | null | undefined, fallback: CanvasRole = "system"): CanvasRole {
  return value && CANVAS_ROLE_SET.has(value) ? (value as CanvasRole) : fallback;
}

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
  mergeConsecutiveRoles: boolean;
};

/** Editable active-character fields the advanced canvas binds to. Canvas-key
 *  names keep `build-fixed-items` and the modal save dispatcher aligned. */
export type CharacterCanvasDraft = {
  charSystemPrompt: string;
  charPostHistory: string;
  charDepthPrompt: string;
  charDepthPromptDepth: number;
  charDepthPromptRole: string;
  charDescription: string;
  charPersonality: string;
  scenario: string;
  dialogueExamples: string;
};

/** A single row in the prompt-order canvas. `custom` rows carry their injection
 *  index; `slot`/`field` rows are the fixed built-in entries. The `render`
 *  closure defers JSX creation until the row is actually placed in a zone. */
export type CanvasItem =
  | { key: string; identifier: string; kind: "slot"; defaultOrder: number; render: () => ReactNode }
  | { key: string; identifier: string; kind: "field"; defaultOrder: number; render: () => ReactNode }
  | { key: string; identifier: string; kind: "custom"; defaultOrder: number; injectionIndex: number; render: () => ReactNode };
