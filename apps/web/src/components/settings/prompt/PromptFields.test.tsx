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
 * Runner: bun:test + happy-dom.
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import { render, fireEvent, within } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

// Identity i18n — assertion strings match keys verbatim. Covers useT in every
// component in the module graph (PromptFields + TokenCounter + AutoTextarea +
// MobileExpandTextarea + PrefillField + Tooltip + DropdownSelect + NumberInput).
const realI18nContext = await import("../../../i18n/context.js");
const realTokenizer = await import("../../../utils/tokenizer.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
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
mock.module("../../../utils/tokenizer.js", () => ({ ...realTokenizer, countTokens: () => 0 }));

// CustomTooltip (Radix) needs a TooltipProvider context irrelevant to field
// behavior; passthrough so toggle/delete buttons render unwrapped.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
}));

// useIsMobile reads window.matchMedia, which happy-dom does not reliably
// implement. Force desktop; the mobile fork is not the test target.
mock.module("../../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));

let PromptFields: typeof import("./PromptFields.js").PromptFields;
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
	({ PromptFields } = await import("./PromptFields.js"));
	({ default: userEvent } = await import("@testing-library/user-event"));
});

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
    onUpdateField: mock(),
    ...overrides,
  };
}

function ControlledPromptFields(props: ReturnType<typeof baseProps>) {
  const [draft, setDraft] = useState<NonNullable<DraftData>>(props.draft ?? baseDraft());
  return (
    <PromptFields
      {...props}
      draft={draft}
      onUpdateField={(field, value) => {
        props.onUpdateField(field, value);
        if (field === "aiAssistantPrompts" && typeof value === "object") {
          setDraft((current) => ({ ...current, aiAssistantPrompts: value }));
        } else if (field === "summary" && typeof value === "string") {
          setDraft((current) => ({ ...current, summary: value }));
        }
      }}
    />
  );
}

let renderedBase: HTMLElement;

function queries() {
  return within(renderedBase);
}

/** Open the collapsible "Service Prompts" section and return the container. */
function openServiceSection() {
  const header = queries().getByText("prompt_section_service");
  fireEvent.click(header);
}

/** Find the textarea whose current value matches `value`. */
function findTextareaByValue(value: string): HTMLTextAreaElement {
  const textareas = queries().getAllByRole("textbox") as HTMLTextAreaElement[];
  const match = textareas.find((t) => t.value === value);
  if (!match) throw new Error(`No textarea found with value "${value}"`);
  return match;
}

async function replaceTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const user = userEvent.setup();
  textarea.focus();
  textarea.setSelectionRange(0, textarea.value.length);
  if (value) await user.type(textarea, value, { skipClick: true });
  else await user.keyboard("{Backspace}");
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("PromptFields — message_edit and message_merge service prompts", () => {
  it("renders both new mode labels in the service section", () => {
		const view = render(<PromptFields {...baseProps()} />);
		renderedBase = view.baseElement;
		openServiceSection();
		expect(queries().getByText("ai_assistant_mode_message_edit")).toBeTruthy();
		expect(queries().getByText("ai_assistant_mode_message_merge")).toBeTruthy();
  });

  it("loads preset overrides for message_edit and message_merge from aiAssistantPrompts", () => {
    const draft = baseDraft({
      aiAssistantPrompts: {
        message_edit: "custom edit prompt",
        message_merge: "custom merge prompt",
      },
    });
		const view = render(<PromptFields {...baseProps({ draft })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const editTextarea = findTextareaByValue("custom edit prompt");
    const mergeTextarea = findTextareaByValue("custom merge prompt");
    expect(editTextarea).toBeTruthy();
    expect(mergeTextarea).toBeTruthy();
  });

	it("edits message_edit override via onUpdateField with updated aiAssistantPrompts", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({
      aiAssistantPrompts: { message_edit: "old edit prompt" },
    });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const textarea = findTextareaByValue("old edit prompt");
		await replaceTextareaValue(textarea, "new edit prompt");
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_edit: "new edit prompt",
    });
  });

	it("edits message_merge override via onUpdateField with updated aiAssistantPrompts", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({
      aiAssistantPrompts: { message_merge: "old merge prompt" },
    });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const textarea = findTextareaByValue("old merge prompt");
		await replaceTextareaValue(textarea, "new merge prompt");
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_merge: "new merge prompt",
    });
  });

	it("removes the message_edit key from aiAssistantPrompts when cleared to whitespace", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({
      aiAssistantPrompts: { message_edit: "to be cleared", message_merge: "keep" },
    });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const textarea = findTextareaByValue("to be cleared");
		await replaceTextareaValue(textarea, "   ");
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_merge: "keep",
    });
  });

	it("removes the message_merge key from aiAssistantPrompts when cleared to empty", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({
      aiAssistantPrompts: { message_edit: "keep", message_merge: "to be cleared" },
    });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const textarea = findTextareaByValue("to be cleared");
		await replaceTextareaValue(textarea, "");
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_edit: "keep",
    });
  });

	it("preserves other aiAssistantPrompts keys when editing one mode", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({
      aiAssistantPrompts: {
        message_edit: "edit prompt",
        message_merge: "merge prompt",
        lore_entry: "lore prompt",
      },
    });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const textarea = findTextareaByValue("edit prompt");
		await replaceTextareaValue(textarea, "updated edit");
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      message_edit: "updated edit",
      message_merge: "merge prompt",
      lore_entry: "lore prompt",
    });
  });
});

describe("PromptFields — existing service prompts regression", () => {
	it("still renders and edits the script mode (legacy fallback to scriptAiSystemPrompt)", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({
      scriptAiSystemPrompt: "legacy script prompt",
      aiAssistantPrompts: {},
    });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
		openServiceSection();
		expect(queries().getByText("ai_assistant_mode_script")).toBeTruthy();
    const textarea = findTextareaByValue("legacy script prompt");
		await replaceTextareaValue(textarea, "new script");
    expect(onUpdateField).toHaveBeenCalledWith("aiAssistantPrompts", {
      script: "new script",
    });
  });

	it("still renders and edits the summary field", async () => {
		const onUpdateField = mock();
    const draft = baseDraft({ summary: "old summary" });
		const view = render(<ControlledPromptFields {...baseProps({ draft, onUpdateField })} />);
		renderedBase = view.baseElement;
    openServiceSection();
    const textarea = findTextareaByValue("old summary");
		await replaceTextareaValue(textarea, "new summary");
    expect(onUpdateField).toHaveBeenCalledWith("summary", "new summary");
  });
});
