import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render, screen } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

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

mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ content, children }: { content?: string; children: React.ReactNode }) => <>{children}</>,
}));

let RegexPresetEditor: typeof import("./RegexPresetEditor.js").RegexPresetEditor;
let emptyRegexDraft: typeof import("./RegexPresetEditor.js").emptyRegexDraft;
let regexDraftFromRecord: typeof import("./RegexPresetEditor.js").regexDraftFromRecord;
beforeAll(async () => {
  const mod = await import("./RegexPresetEditor.js");
  RegexPresetEditor = mod.RegexPresetEditor;
  emptyRegexDraft = mod.emptyRegexDraft;
  regexDraftFromRecord = mod.regexDraftFromRecord;
});

import type { RegexPresetRecord } from "../../../api/types.js";

function baseRecord(overrides: Partial<RegexPresetRecord> = {}): RegexPresetRecord {
  return {
    id: "r1",
    name: "Test regex",
    findRegex: "/foo/g",
    replaceString: "bar",
    trimStrings: [],
    substituteRegex: 0,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("RegexPresetEditor", () => {
  it("renders all fields from the preset record", () => {
    const draft = regexDraftFromRecord(baseRecord({ name: "My Script", findRegex: "/x+/g" }));
    render(<RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={mock()} />);
    expect((screen.getByLabelText("promptManager.regex.fieldName") as HTMLInputElement).value).toBe("My Script");
    expect((screen.getByLabelText("promptManager.regex.fieldFind") as HTMLTextAreaElement).value).toBe("/x+/g");
    expect((screen.getByLabelText("promptManager.regex.fieldReplace") as HTMLTextAreaElement).value).toBe("bar");
  });

  it("reflects the apply-target mode and switching updates the draft", () => {
    const onDraftChange = mock();
    const draft = regexDraftFromRecord(baseRecord({ markdownOnly: true, promptOnly: false }));
    expect(draft.applyTarget).toBe("display");
    render(<RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={onDraftChange} />);
    const displayRadio = screen.getByDisplayValue("display") as HTMLInputElement;
    expect(displayRadio.checked).toBe(true);
  });

  it("switching apply-target to prompt calls onDraftChange with updated draft", async () => {
    const onDraftChange = mock();
    const draft = regexDraftFromRecord(baseRecord());
    expect(draft.applyTarget).toBe("persist");
    const user = userEvent.setup();
    render(<RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={onDraftChange} />);
    await user.click(screen.getByDisplayValue("prompt"));
    expect(onDraftChange).toHaveBeenCalled();
    const calledDraft = onDraftChange.mock.calls[0][0] as ReturnType<typeof emptyRegexDraft>;
    expect(calledDraft.applyTarget).toBe("prompt");
  });

  it("live test pane transforms sample text via the engine", async () => {
    const draft = regexDraftFromRecord(baseRecord({ findRegex: "/hello/g", replaceString: "world" }));
    const user = userEvent.setup();
    render(<RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={mock()} />);
    const testInput = screen.getByPlaceholderText("promptManager.regex.testInputPlaceholder");
    await user.type(testInput, "hello there hello");
    // The transformed output should appear in the test output area.
    const output = screen.getByText("world there world");
    expect(output).toBeTruthy();
  });

  it("shows invalid-pattern state when the find regex is broken", () => {
    const draft = regexDraftFromRecord(baseRecord({ findRegex: "/[unclosed/g" }));
    render(<RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={mock()} />);
    expect(screen.getByText(/Invalid regular expression|Unterminated/)).toBeTruthy();
  });
});
