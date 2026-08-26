/**
 * PromptFields — chat-prompt fields characterization + SP-10 removal pin.
 *
 * The former "Service Prompts" section (summary + AI-assistant mode overrides)
 * moved to the dedicated «Служебные» tab (ServicePromptsPane + PromptManager
 * wiring, SP-8/SP-9 — their tests own that boundary now). What remains here
 * is the chat section; this file pins:
 *
 *  - RENDER: the chat section renders system / post-history / author's-note
 *    fields from the draft.
 *  - EDIT: typing into the system textarea calls onUpdateField("system", v).
 *  - REMOVAL PIN (SP-10): the preset editor renders NO service-prompt UI —
 *    the collapsible header is gone entirely.
 *  - HIDE: hideChatPrompts renders nothing.
 *
 * Runner: bun:test + happy-dom.
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import { render, within } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

// Identity i18n — assertion strings match keys verbatim. Covers useT in every
// component in the module graph (PromptFields + TokenCounter + AutoTextarea +
// MobileExpandTextarea + PrefillField + Tooltip + DropdownSelect).
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
// irrelevant to chat-field behavior. Stub it to keep the test fast.
mock.module("../../../utils/tokenizer.js", () => ({ ...realTokenizer, countTokens: () => 0 }));

// CustomTooltip (Radix) needs a TooltipProvider context irrelevant to field
// behavior; passthrough so the depth input renders unwrapped.
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

type DraftData = NonNullable<Parameters<typeof PromptFields>[0]["draft"]>;

function baseDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    system: "sys",
    jailbreak: "jb",
    prefill: "pre",
    authorsNote: "an",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
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

/** Controlled wrapper: applies system-field updates back into the draft, the
 *  same pattern the old service-section tests used for edit flows. */
function ControlledPromptFields(props: ReturnType<typeof baseProps>) {
  const [draft, setDraft] = useState<NonNullable<DraftData>>(props.draft ?? baseDraft());
  return (
    <PromptFields
      {...props}
      draft={draft}
      onUpdateField={(field, value) => {
        props.onUpdateField(field, value);
        if (field === "system" && typeof value === "string") {
          setDraft((current) => ({ ...current, system: value }));
        }
      }}
    />
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("PromptFields — chat prompt fields", () => {
  it("renders the chat section fields from the draft", () => {
    const view = render(<PromptFields {...baseProps()} />);
    const q = within(view.baseElement);
    expect(q.getByText("prompt_section_chat")).toBeTruthy();
    expect((q.getAllByRole("textbox") as HTMLTextAreaElement[]).some((t) => t.value === "sys")).toBe(true);
    expect((q.getAllByRole("textbox") as HTMLTextAreaElement[]).some((t) => t.value === "jb")).toBe(true);
    expect(q.getByText("authors_note_label")).toBeTruthy();
  });

  it("edits the system prompt through onUpdateField", async () => {
    const onUpdateField = mock();
    const view = render(<ControlledPromptFields {...baseProps({ onUpdateField })} />);
    const textarea = (within(view.baseElement).getAllByRole("textbox") as HTMLTextAreaElement[]).find((t) => t.value === "sys")!;
    const user = userEvent.setup();
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
    await user.type(textarea, "new sys", { skipClick: true });
    expect(onUpdateField).toHaveBeenLastCalledWith("system", "new sys");
  });

  it("renders no service-prompt UI (SP-10 removal pin)", () => {
    const view = render(<PromptFields {...baseProps()} />);
    const q = within(view.baseElement);
    expect(q.queryByText("prompt_section_service")).toBeNull();
    expect(q.queryByText("ai_assistant_section")).toBeNull();
    // The section was the only collapsible — no toggle chevrons remain.
    expect(view.baseElement.textContent).not.toContain("▾");
  });

  it("renders nothing when hideChatPrompts is set", () => {
    const view = render(<PromptFields {...baseProps({ hideChatPrompts: true })} />);
    expect(within(view.baseElement).queryByText("prompt_section_chat")).toBeNull();
    expect(view.baseElement.querySelectorAll("textarea").length).toBe(0);
  });
});
