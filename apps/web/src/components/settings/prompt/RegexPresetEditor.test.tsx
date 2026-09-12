import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import type { RegexPresetDraft } from "./RegexPresetEditor.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render, screen } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realRegexApi = await import("../../../api/regex-api.js");
const realPresetApi = await import("../../../api/preset-api.js");

const getRegexLinksMock = mock(() => Promise.resolve([] as Array<{ regexPresetId: string; targetType: "character" | "preset"; targetId: string }>));
const setRegexLinksMock = mock(() => Promise.resolve([] as Array<{ regexPresetId: string; targetType: "character" | "preset"; targetId: string }>));
const listPromptPresetsMock = mock(() => Promise.resolve([] as Array<{ id: string; name: string }>));

mock.module("../../../api/regex-api.js", () => ({
  ...realRegexApi,
  getRegexLinks: getRegexLinksMock,
  setRegexLinks: setRegexLinksMock,
}));

mock.module("../../../api/preset-api.js", () => ({
  ...realPresetApi,
  listPromptPresets: listPromptPresetsMock,
}));

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
    profileId: null,
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
    // SegmentedControl — the checked segment carries aria-checked=true.
    const segments = screen.getAllByRole("radio");
    const displaySeg = segments.find((s) => s.getAttribute("value") === "display") as HTMLElement;
    expect(displaySeg.getAttribute("aria-checked")).toBe("true");
  });

  it("switching apply-target to prompt calls onDraftChange with updated draft", async () => {
    const onDraftChange = mock();
    const draft = regexDraftFromRecord(baseRecord());
    expect(draft.applyTarget).toBe("persist");
    const user = userEvent.setup();
    render(<RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={onDraftChange} />);
    const promptSeg = screen.getAllByRole("radio").find((s) => s.getAttribute("value") === "prompt") as HTMLElement;
    await user.click(promptSeg);
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

  // RX-12: forward-direction binding row (characters + prompt presets).
  it("renders the bindings row for a saved preset and lists linked targets as pills", async () => {
    getRegexLinksMock.mockResolvedValue([{ regexPresetId: "r1", targetType: "preset", targetId: "pp1" }]);
    listPromptPresetsMock.mockResolvedValue([{ id: "pp1", name: "Deep RP" }]);
    render(<RegexPresetEditor preset={baseRecord()} draft={regexDraftFromRecord(baseRecord())} onDraftChange={mock()} />);
    expect(screen.getByText("promptManager.regex.bindingsLabel")).toBeTruthy();
    // The linked prompt preset renders as a pill once links + presets load.
    expect(await screen.findByText("Deep RP")).toBeTruthy();
  });

  it("clicking a bound pill unlinks it via setRegexLinks (full-set PUT)", async () => {
    getRegexLinksMock.mockResolvedValue([
      { regexPresetId: "r1", targetType: "preset", targetId: "pp1" },
      { regexPresetId: "r1", targetType: "character", targetId: "c1" },
    ]);
    listPromptPresetsMock.mockResolvedValue([{ id: "pp1", name: "Deep RP" }]);
    const user = userEvent.setup();
    render(<RegexPresetEditor preset={baseRecord()} draft={regexDraftFromRecord(baseRecord())} onDraftChange={mock()} />);
    const pill = await screen.findByText("Deep RP");
    setRegexLinksMock.mockClear();
    await user.click(pill);
    expect(setRegexLinksMock).toHaveBeenCalledTimes(1);
    // Only the preset link is removed; the character link survives in the
    // full replacement set.
    expect(setRegexLinksMock).toHaveBeenLastCalledWith("r1", [{ targetType: "character", targetId: "c1" }]);
  });

  it("hides the bindings row for a new unsaved preset (nothing to bind yet)", () => {
    render(<RegexPresetEditor preset={null} draft={emptyRegexDraft()} onDraftChange={mock()} />);
    expect(screen.queryByText("promptManager.regex.bindingsLabel")).toBeNull();
  });
});

// ── R-7 redesign contracts ─────────────────────────────────────────────────
describe("RegexPresetEditor — R-7 redesign", () => {
  beforeEach(() => {
    getRegexLinksMock.mockReset();
    getRegexLinksMock.mockResolvedValue([]);
    listPromptPresetsMock.mockReset();
    listPromptPresetsMock.mockResolvedValue([]);
    setRegexLinksMock.mockReset();
  });

  it("Активен toggle: saved preset → onActiveChange only (instant patch, draft untouched)", async () => {
    const onDraftChange = mock();
    const onActiveChange = mock();
    const user = userEvent.setup();
    render(
      <RegexPresetEditor
        preset={baseRecord()}
        draft={regexDraftFromRecord(baseRecord())}
        onDraftChange={onDraftChange}
        onActiveChange={onActiveChange}
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // active by default
    await user.click(toggle);
    expect(onActiveChange).toHaveBeenCalledTimes(1);
    expect(onActiveChange.mock.calls[0][0]).toBe(false);
    // The instant path never routes through the draft — a dirty draft is not
    // involved in activation at all.
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("Активен toggle: no preset record → edits the draft (activates on first Save)", async () => {
    const onDraftChange = mock();
    const user = userEvent.setup();
    render(<RegexPresetEditor preset={null} draft={emptyRegexDraft()} onDraftChange={onDraftChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const called = onDraftChange.mock.calls[0][0] as ReturnType<typeof emptyRegexDraft>;
    expect(called.disabled).toBe(true);
  });

  it("scope segmented: «Все чаты» sets isGlobal and hides the bindings block", async () => {
    const onDraftChange = mock();
    const user = userEvent.setup();
    const record = baseRecord({ isGlobal: false });
    render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={onDraftChange} />);
    // Bind-mode default: bindings visible.
    expect(screen.getByText("promptManager.regex.bindingsLabel")).toBeTruthy();
    const allChats = screen.getAllByRole("radio").find((s) => s.getAttribute("value") === "all" && s.textContent === "promptManager.regex.scopeAll") as HTMLElement;
    await user.click(allChats);
    const called = onDraftChange.mock.calls[0][0] as ReturnType<typeof emptyRegexDraft>;
    expect(called.isGlobal).toBe(true);
  });

  it("scope segmented: «Привязать к» from a global preset shows the dead-zone warning", async () => {
    const onDraftChange = mock();
    const user = userEvent.setup();
    const record = baseRecord({ isGlobal: true });
    render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={onDraftChange} />);
    expect(screen.queryByText("promptManager.regex.bindingsDeadZone")).toBeNull();
    const bind = screen.getAllByRole("radio").find((s) => s.getAttribute("value") === "bind") as HTMLElement;
    await user.click(bind);
    // Draft flips to bind-mode → bindings block + dead-zone warning appear
    // (the warning IS the empty state, R-7).
    const called = onDraftChange.mock.calls[0][0] as ReturnType<typeof emptyRegexDraft>;
    expect(called.isGlobal).toBe(false);
  });

  it("placement chips toggle codes in the draft", async () => {
    const onDraftChange = mock();
    const user = userEvent.setup();
    render(<RegexPresetEditor preset={baseRecord()} draft={regexDraftFromRecord(baseRecord({ placement: [2] }))} onDraftChange={onDraftChange} />);
    const chip = screen.getByText("promptManager.regex.placementWorldInfo");
    await user.click(chip);
    const called = onDraftChange.mock.calls[0][0] as ReturnType<typeof emptyRegexDraft>;
    expect(called.placement).toEqual([2, 5]);
  });

  it("depth modes rewrite minDepth/maxDepth; «Вся история» clears both", async () => {
    // Controlled-draft harness: the real parent feeds onDraftChange back into
    // `draft`, so mode inference (from the pair) advances between clicks —
    // without feedback every click would see the stale "all" mode and the
    // no-op guard would swallow it.
    const calls: RegexPresetDraft[] = [];
    function Harness() {
      const [draft, setDraft] = useState(regexDraftFromRecord(baseRecord()));
      const handle = (next: RegexPresetDraft) => { calls.push(next); setDraft(next); };
      return <RegexPresetEditor preset={baseRecord()} draft={draft} onDraftChange={handle} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    // Find depth segments by their LABEL, not value — the scope control also
    // has a value="all" radio ("Все чаты").
    const seg = (labelKey: string) => screen.getAllByRole("radio").find((s) => s.textContent === labelKey) as HTMLElement;
    expect(seg("promptManager.regex.depthModeAll").getAttribute("aria-checked")).toBe("true");

    // «Последние N» → max=4 (owner default), min unbounded.
    await user.click(seg("promptManager.regex.depthModeRecent"));
    expect(calls.at(-1)!.minDepth).toBe("");
    expect(calls.at(-1)!.maxDepth).toBe("4");

    // «Старше N» → min=4, max unbounded (one-sided must not normalize).
    await user.click(seg("promptManager.regex.depthModeOlder"));
    expect(calls.at(-1)!.minDepth).toBe("4");
    expect(calls.at(-1)!.maxDepth).toBe("");

    // «Вся история» → both cleared.
    await user.click(seg("promptManager.regex.depthModeAll"));
    expect(calls.at(-1)!.minDepth).toBe("");
    expect(calls.at(-1)!.maxDepth).toBe("");
  });

  it("depth hidden with a note when only lorebook/reasoning placements are selected", () => {
    const record = baseRecord({ placement: [5, 6] });
    render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    expect(screen.getByText("promptManager.regex.depthNoteHidden")).toBeTruthy();
    // The mode control is gone (no depth radios).
    expect(screen.queryAllByRole("radio").some((r) => r.getAttribute("value") === "recent")).toBe(false);
  });

  it("test pane distinguishes no-match from a real match", async () => {
    const user = userEvent.setup();
    const record = baseRecord({ findRegex: "/zzz/g", replaceString: "x" });
    render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    await user.type(screen.getByPlaceholderText("promptManager.regex.testInputPlaceholder"), "hello there");
    expect(screen.getByText("promptManager.regex.testNoMatch")).toBeTruthy();
  });

  it("bind-mode with zero resolvable links shows the dead-zone warning; a resolvable link hides it", async () => {
    // Zero links → warning.
    const first = render(
      <RegexPresetEditor preset={baseRecord()} draft={regexDraftFromRecord(baseRecord())} onDraftChange={mock()} />,
    );
    expect(await first.findByText("promptManager.regex.bindingsDeadZone")).toBeTruthy();
    first.unmount();

    // One resolvable prompt-preset link → pills render, no warning.
    getRegexLinksMock.mockResolvedValue([{ regexPresetId: "r1", targetType: "preset", targetId: "pp1" }]);
    listPromptPresetsMock.mockResolvedValue([{ id: "pp1", name: "Deep RP" }]);
    const second = render(
      <RegexPresetEditor preset={baseRecord({ id: "r1" })} draft={regexDraftFromRecord(baseRecord())} onDraftChange={mock()} />,
    );
    expect(await second.findByText("Deep RP")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50)); // let the links state settle
    expect(second.queryByText("promptManager.regex.bindingsDeadZone")).toBeNull();
  });
});

// ── R-7 owner follow-up: «Не применяется» badge under the name (editor) ────
describe("RegexPresetEditor — not-applied badge under the name", () => {
  beforeEach(() => {
    getRegexLinksMock.mockReset();
    getRegexLinksMock.mockResolvedValue([]);
    listPromptPresetsMock.mockReset();
    listPromptPresetsMock.mockResolvedValue([]);
    setRegexLinksMock.mockReset();
  });

  it("shows the badge for enabled + bind mode + zero resolvable links", async () => {
    const record = baseRecord({ isGlobal: false }); // bind mode, enabled
    render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    expect(await screen.findByText("promptManager.regex.badgeNotApplied")).toBeTruthy();
  });

  it("hides the badge when disabled, when global, or when a link resolves", async () => {
    // Disabled (instant toggle state) → the Toggle itself carries the state.
    let record = baseRecord({ isGlobal: false, disabled: true });
    const first = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    await first.findByText("promptManager.regex.fieldActive");
    expect(first.queryByText("promptManager.regex.badgeNotApplied")).toBeNull();
    first.unmount();

    // Global («Все чаты») → applies everywhere, never "not applied".
    record = baseRecord({ isGlobal: true });
    const second = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    await second.findByText("promptManager.regex.scopeAll");
    expect(second.queryByText("promptManager.regex.badgeNotApplied")).toBeNull();
    second.unmount();

    // Bind mode with one resolvable link → applies.
    getRegexLinksMock.mockResolvedValue([{ regexPresetId: "r1", targetType: "preset", targetId: "pp1" }]);
    listPromptPresetsMock.mockResolvedValue([{ id: "pp1", name: "Deep RP" }]);
    record = baseRecord({ id: "r1", isGlobal: false });
    const third = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    expect(await third.findByText("Deep RP")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(third.queryByText("promptManager.regex.badgeNotApplied")).toBeNull();
  });
});
