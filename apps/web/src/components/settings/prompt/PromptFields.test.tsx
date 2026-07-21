/**
 * PromptFields — service-prompt override tests.
 *
 * Pins the load/edit/remove-empty behavior of the AI-assistant mode prompt
 * fields, with focus on the two new message-editor modes (message_edit,
 * message_merge) added in MAE-61. The existing service prompts (script,
 * lore_entry, etc.) are smoke-checked to guard against regression.
 *
 * What is pinned:
 *  - LOAD: a preset override in `aiAssistantPrompts[mode]` renders as the
 *    textarea value for that mode's field.
 *  - EDIT: typing into a mode textarea calls `onUpdateField("aiAssistantPrompts",
 *    {...prev, [mode]: newValue})`.
 *  - REMOVE-EMPTY: clearing the textarea (whitespace-only) deletes the mode
 *    key from the `aiAssistantPrompts` object passed to `onUpdateField`.
 *  - REGRESSION: existing service-prompt fields (script, summary) still render
 *    and edit through the same boundary.
 *
 * Runner: vitest (apps/web uses vitest, NOT bun:test). DOM via happy-dom.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { PromptFields } from "./PromptFields.js";

// Identity i18n — assertion strings match keys verbatim. Covers useT in every
// component in the module graph (PromptFields + TokenCounter + AutoTextarea +
// MobileExpandTextarea + PrefillField + Tooltip + DropdownSelect + NumberInput).
vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// countTokens loads a real tiktoken encoding (cl100k_base) — heavy and
// irrelevant to service-prompt field behavior. Stub it to keep the test fast.
vi.mock("../../../utils/tokenizer.js", () => ({ countTokens: () => 0 }));

// CustomTooltip (Radix) needs a TooltipProvider context irrelevant to field
// behavior; passthrough so toggle/delete buttons render unwrapped.
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
}));

// useIsMobile reads window.matchMedia, which happy-dom does not reliably
// implement. Force desktop; the mobile fork is not the test target.
vi.mock("../../../hooks/use-mobile.js", () => ({ useIsMobile: () => false }));

// ── Fixture ────────────────────────────────────────────────────────────

type DraftData = Parameters<typeof PromptFields>[0]["draft"];

function baseDraft(overrides: Partial<NonNullable<DraftData>> = {}): NonNullable<DraftData> {
  return {
    system: "sys",
    jailbreak: "jb",
    prefill: "pre",
    authorsNote: "an",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
    summary: "sum",
    tools: "tools",
    scriptAiSystemPrompt: "legacy-script-prompt",
    aiAssistantPrompts: {},
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof PromptFields>[0]> = {}) {
  return {
    draft: baseDraft(),
    onUpdateField: vi.fn(),
    ...overrides,
  };
}

/** Open the collapsible "Service Prompts" section and return the container. */
function openServiceSection() {
  const header = screen.getByText("prompt_section_service");
  fireEvent.click(header);
}

/** Find the textarea whose current value matches `value`. */
function findTextareaByValue(value: string): HTMLTextAreaElement {
  const textareas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
  const match = textareas.find((t) => t.value === value);
  if (!match) throw new Error(`No textarea found with value "${value}"`);
  return match;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("PromptFields — message_edit and message_merge service prompts", () => {
  it("renders both new mode labels in the service section", () => {
    render(<PromptFields {...baseProps()} />);
    openServiceSection();
    expect(screen.getByText("ai_assistant_mode_message_edit")).toBeTruthy();
    expect(screen.getByText("ai_assistant_mode_message_merge")).toBeTruthy();
  });

  it("loads preset overrides for message_edit and message_merge from aiAssistantPrompts", () => {
    const draft = baseDraft({
      aiAssistantPrompts: {
        message_edit: "custom edit prompt",
        message_merge: "custom merge prompt",
      },
    });
    render(<PromptFields {...baseProps({ draft })} />);
    openServiceSection();
    const editTextarea = findTextareaByValue("custom edit prompt");
    const mergeTextarea = findTextareaByValue("custom merge prompt");
    expect(editTextarea).toBeTruthy();
    expect(mergeTextarea).toBeTruthy();
  });

  it("edits message_edit override via onUpdateField with updated aiAssistantPrompts", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({
      aiAssistantPrompts: { message_edit: "old edit prompt" },
    });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    const textarea = findTextareaByValue("old edit prompt");
    fireEvent.change(textarea, { target: { value: "new edit prompt" } });
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_edit: "new edit prompt",
    });
  });

  it("edits message_merge override via onUpdateField with updated aiAssistantPrompts", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({
      aiAssistantPrompts: { message_merge: "old merge prompt" },
    });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    const textarea = findTextareaByValue("old merge prompt");
    fireEvent.change(textarea, { target: { value: "new merge prompt" } });
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_merge: "new merge prompt",
    });
  });

  it("removes the message_edit key from aiAssistantPrompts when cleared to whitespace", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({
      aiAssistantPrompts: { message_edit: "to be cleared", message_merge: "keep" },
    });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    const textarea = findTextareaByValue("to be cleared");
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_merge: "keep",
    });
  });

  it("removes the message_merge key from aiAssistantPrompts when cleared to empty", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({
      aiAssistantPrompts: { message_edit: "keep", message_merge: "to be cleared" },
    });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    const textarea = findTextareaByValue("to be cleared");
    fireEvent.change(textarea, { target: { value: "" } });
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_edit: "keep",
    });
  });

  it("preserves other aiAssistantPrompts keys when editing one mode", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({
      aiAssistantPrompts: {
        message_edit: "edit prompt",
        message_merge: "merge prompt",
        lore_entry: "lore prompt",
      },
    });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    const textarea = findTextareaByValue("edit prompt");
    fireEvent.change(textarea, { target: { value: "updated edit" } });
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_edit: "updated edit",
      message_merge: "merge prompt",
      lore_entry: "lore prompt",
    });
  });
});

describe("PromptFields — existing service prompts regression", () => {
  it("still renders and edits the script mode (legacy fallback to scriptAiSystemPrompt)", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({
      scriptAiSystemPrompt: "legacy script prompt",
      aiAssistantPrompts: {},
    });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    expect(screen.getByText("ai_assistant_mode_script")).toBeTruthy();
    const textarea = findTextareaByValue("legacy script prompt");
    fireEvent.change(textarea, { target: { value: "new script" } });
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      script: "new script",
    });
  });

  it("still renders and edits the summary field", () => {
    const onUpdateField = vi.fn();
    const draft = baseDraft({ summary: "old summary" });
    render(<PromptFields {...baseProps({ draft, onUpdateField })} />);
    openServiceSection();
    const textarea = findTextareaByValue("old summary");
    fireEvent.change(textarea, { target: { value: "new summary" } });
    expect(onUpdateField).toHaveBeenCalledWith("summary", "new summary");
  });
});