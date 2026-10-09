import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState, type ReactNode } from "react";
import type { RegexPresetDraft } from "./regex-rule-draft.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render, screen } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realDropdownSelect = await import("../../shared/DropdownSelect.js");
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
  CustomTooltip: ({ content, children }: { content?: string; children: ReactNode }) => <>{children}</>,
}));

mock.module("../../shared/DropdownSelect.js", () => ({
  ...realDropdownSelect,
  DropdownSelect: ({
    value, options, defaultOption, onChange, triggerTestId,
  }: {
    value: string;
    options: Array<{ id: string; label: ReactNode }>;
    defaultOption?: string;
    onChange: (value: string) => void;
    triggerTestId?: string;
  }) => (
    <select data-testid={triggerTestId} value={value} onChange={(event) => onChange(event.target.value)}>
      {defaultOption && <option value="">{defaultOption}</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  ),
}));

let RegexPresetEditor: typeof import("./RegexPresetEditor.js").RegexPresetEditor;
let emptyRegexDraft: typeof import("./regex-rule-draft.js").emptyRegexDraft;
let regexDraftFromRecord: typeof import("./regex-rule-draft.js").regexDraftFromRecord;
let regexDraftSaveIssue: typeof import("./regex-rule-draft.js").regexDraftSaveIssue;
beforeAll(async () => {
  const mod = await import("./RegexPresetEditor.js");
  RegexPresetEditor = mod.RegexPresetEditor;
  const draftMod = await import("./regex-rule-draft.js");
  emptyRegexDraft = draftMod.emptyRegexDraft;
  regexDraftFromRecord = draftMod.regexDraftFromRecord;
  regexDraftSaveIssue = draftMod.regexDraftSaveIssue;
});

import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";

function baseRecord(overrides: Partial<RegexPresetRecord> = {}): RegexPresetRecord {
  return {
    id: brandId<RegexPresetId>("r1"),
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function profileRecord(id: string, name: string, overrides: Partial<RegexProfileRecord> = {}): RegexProfileRecord {
  return {
    id: brandId<RegexProfileId>(id),
    name,
    disabled: false,
    isGlobal: true,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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

  it("lists Standalone and every Profile with the current membership selected", () => {
    const profile = baseRecord({ profileId: brandId("p1") });
    const view = render(
      <RegexPresetEditor
        preset={profile}
        draft={regexDraftFromRecord(profile)}
        onDraftChange={mock()}
        profiles={[profileRecord("p1", "Current Profile"), profileRecord("p2", "Other Profile")]}
      />,
    );
    const assignment = view.getByTestId("regex-profile-assignment") as HTMLSelectElement;
    expect(assignment.value).toBe("p1");
    expect([...assignment.options].map((option) => option.text)).toEqual([
      "promptManager.regex.profileStandalone", "Current Profile", "Other Profile",
    ]);
  });

  it("delegates Profile and Standalone assignments without diverging from the confirmed record", async () => {
    const onProfileAssignment = mock(async () => {});
    const profile = baseRecord({ profileId: brandId("p1") });
    const user = userEvent.setup();
    const view = render(
      <RegexPresetEditor
        preset={profile}
        draft={regexDraftFromRecord(profile)}
        onDraftChange={mock()}
        profiles={[profileRecord("p1", "Current Profile"), profileRecord("p2", "Other Profile")]}
        onProfileAssignment={onProfileAssignment}
      />,
    );
    const assignment = view.getByTestId("regex-profile-assignment") as HTMLSelectElement;
    await user.selectOptions(assignment, "p2");
    expect(onProfileAssignment).toHaveBeenLastCalledWith("p2");
    expect(assignment.value).toBe("p1");
    await user.selectOptions(assignment, "");
    expect(onProfileAssignment).toHaveBeenLastCalledWith(null);
    expect(assignment.value).toBe("p1");
  });

  it("renders translated group headings for Rule editing", () => {
    const view = render(<RegexPresetEditor preset={baseRecord()} draft={regexDraftFromRecord(baseRecord())} onDraftChange={mock()} />);
    expect(view.getByText("promptManager.regex.sectionIdentityReplacement")).toBeTruthy();
    expect(view.getByText("promptManager.regex.sectionExecutionConditions")).toBeTruthy();
    expect(view.getByText("promptManager.regex.sectionAvailabilityScope")).toBeTruthy();
    expect(view.getByText("promptManager.regex.sectionLiveTest")).toBeTruthy();
    expect(view.queryByText("Regex Preset")).toBeNull();
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
      <RegexPresetEditor preset={baseRecord({ id: brandId<RegexPresetId>("r1") })} draft={regexDraftFromRecord(baseRecord())} onDraftChange={mock()} />,
    );
    expect(await second.findByText("Deep RP")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50)); // let the links state settle
    expect(second.queryByText("promptManager.regex.bindingsDeadZone")).toBeNull();
  });
});

// ── RXU-14: new-rule draft gate, feedback, and member chip ───────────────
describe("RegexPresetEditor — new-rule draft (RXU-14)", () => {
  beforeEach(() => {
    getRegexLinksMock.mockReset();
    getRegexLinksMock.mockResolvedValue([]);
    listPromptPresetsMock.mockReset();
    listPromptPresetsMock.mockResolvedValue([]);
    setRegexLinksMock.mockReset();
  });

  it("pure gate: a non-empty name AND a compilable find pattern are required", () => {
    // Empty draft → name blocks first.
    expect(regexDraftSaveIssue(emptyRegexDraft())?.field).toBe("name");
    // Name present, find missing → find blocks ("" compiles but is not a Rule).
    expect(regexDraftSaveIssue({ ...emptyRegexDraft(), name: "A" })?.field).toBe("findRegex");
    // Broken /pattern/flags → find blocks.
    expect(regexDraftSaveIssue({ ...emptyRegexDraft(), name: "A", findRegex: "/[unclosed/g" })?.field).toBe("findRegex");
    // Delimited and bare (whole-string) patterns both pass.
    expect(regexDraftSaveIssue({ ...emptyRegexDraft(), name: "A", findRegex: "/x/g" })).toBeNull();
    expect(regexDraftSaveIssue({ ...emptyRegexDraft(), name: "A", findRegex: "abc" })).toBeNull();
  });

  it("draft mode shows field-level feedback for the blocking field only", () => {
    // Both invalid → the name issue is the visible blocker.
    const first = render(<RegexPresetEditor preset={null} draft={emptyRegexDraft()} onDraftChange={mock()} />);
    expect(first.getByText("promptManager.regex.draftNameRequired")).toBeTruthy();
    expect(first.queryByText("promptManager.regex.draftFindRequired")).toBeNull();
    first.unmount();

    // Name present, find broken → find feedback only.
    const second = render(
      <RegexPresetEditor preset={null} draft={{ ...emptyRegexDraft(), name: "A", findRegex: "/[unclosed/g" }} onDraftChange={mock()} />,
    );
    expect(second.queryByText("promptManager.regex.draftNameRequired")).toBeNull();
    expect(second.getByText("promptManager.regex.draftFindRequired")).toBeTruthy();
    second.unmount();

    // Fully valid draft → no feedback at all.
    const third = render(
      <RegexPresetEditor preset={null} draft={{ ...emptyRegexDraft(), name: "A", findRegex: "/x/g" }} onDraftChange={mock()} />,
    );
    expect(third.queryByText("promptManager.regex.draftNameRequired")).toBeNull();
    expect(third.queryByText("promptManager.regex.draftFindRequired")).toBeNull();
  });

  it("renders an invalid name alert outside the input/control alignment row", () => {
    const valid = render(
      <RegexPresetEditor
        preset={null}
        draft={{ ...emptyRegexDraft(), name: "Valid", findRegex: "/x/g" }}
        onDraftChange={mock()}
      />,
    );
    const validControls = (valid.getByText("regexAssistant.open").parentElement as HTMLElement).className;
    valid.unmount();

    const invalid = render(<RegexPresetEditor preset={null} draft={emptyRegexDraft()} onDraftChange={mock()} />);
    const row = invalid.getByTestId("regex-name-controls-row");
    const alert = invalid.getByRole("alert");
    const controls = invalid.getByText("regexAssistant.open").parentElement as HTMLElement;

    expect(row.className).toContain("items-end");
    expect(row.contains(alert)).toBe(false);
    expect(row.contains(controls)).toBe(true);
    expect(controls.className).toBe(validControls);
    expect(controls.className).toContain("pb-[7px]");
  });

  it("saved-record editing never shows the draft gate feedback", () => {
    // A saved record with a broken pattern keeps its existing update flow —
    // the gate exists only for a draft's FIRST persistence.
    const record = baseRecord({ findRegex: "/[unclosed/g" });
    const view = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    expect(view.queryByText("promptManager.regex.draftNameRequired")).toBeNull();
    expect(view.queryByText("promptManager.regex.draftFindRequired")).toBeNull();
  });

  it("a profile-scoped draft shows the member chip instead of own scope controls", () => {
    const view = render(
      <RegexPresetEditor
        preset={null}
        draft={{ ...emptyRegexDraft(), name: "A" }}
        onDraftChange={mock()}
        draftProfileId="p1"
        profiles={[profileRecord("p1", "Bundle")]}
      />,
    );
    expect(view.getByText("promptManager.regex.memberViaProfile")).toBeTruthy();
    expect(view.queryByText("promptManager.regex.scopeAll")).toBeNull();
  });

  it("a standalone draft keeps the own scope controls", () => {
    const view = render(
      <RegexPresetEditor preset={null} draft={{ ...emptyRegexDraft(), name: "A" }} onDraftChange={mock()} />,
    );
    expect(view.queryByText("promptManager.regex.memberViaProfile")).toBeNull();
    expect(view.getByText("promptManager.regex.scopeLabel")).toBeTruthy();
  });
});

// ── RXU-31 availability reason marker in the editor ─────────────────────
describe("RegexPresetEditor — unbound reason marker", () => {
  beforeEach(() => {
    getRegexLinksMock.mockReset();
    getRegexLinksMock.mockResolvedValue([]);
    listPromptPresetsMock.mockReset();
    listPromptPresetsMock.mockResolvedValue([]);
    setRegexLinksMock.mockReset();
  });

  it("shows the unbound reason for an enabled standalone Rule with confirmed zero resolvable links", async () => {
    const record = baseRecord({ isGlobal: false });
    render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    expect(await screen.findByText("promptManager.regex.availabilityUnbound")).toBeTruthy();
  });

  it("does not show an unbound reason for an active member whose Profile is reachable", () => {
    const member = baseRecord({ profileId: brandId<RegexProfileId>("p1"), isGlobal: false });
    const view = render(
      <RegexPresetEditor
        preset={member}
        draft={regexDraftFromRecord(member)}
        onDraftChange={mock()}
        profiles={[profileRecord("p1", "Bundle", { isGlobal: false })]}
        profileLinkCounts={{ p1: 1 }}
      />,
    );
    expect(view.queryByText("promptManager.regex.availabilityUnbound")).toBeNull();
  });

  it("withholds the member reason while its Profile link count is unknown", () => {
    const member = baseRecord({ profileId: brandId<RegexProfileId>("p1"), isGlobal: false });
    const view = render(
      <RegexPresetEditor
        preset={member}
        draft={regexDraftFromRecord(member)}
        onDraftChange={mock()}
        profiles={[profileRecord("p1", "Bundle", { isGlobal: false })]}
      />,
    );
    expect(view.queryByText("promptManager.regex.availabilityUnbound")).toBeNull();
  });

  it("shows an unbound reason for an active member only after its Profile confirms zero links", () => {
    const member = baseRecord({ profileId: brandId<RegexProfileId>("p1"), isGlobal: false });
    const view = render(
      <RegexPresetEditor
        preset={member}
        draft={regexDraftFromRecord(member)}
        onDraftChange={mock()}
        profiles={[profileRecord("p1", "Bundle", { isGlobal: false })]}
        profileLinkCounts={{ p1: 0 }}
      />,
    );
    expect(view.getByText("promptManager.regex.availabilityUnbound")).toBeTruthy();
  });

  it("hides the unbound reason when disabled, global, or reachable", async () => {
    // Disabled (instant toggle state) → the Toggle itself carries the state.
    let record = baseRecord({ isGlobal: false, disabled: true });
    const first = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    await first.findByText("promptManager.regex.fieldActive");
    expect(first.queryByText("promptManager.regex.availabilityUnbound")).toBeNull();
    first.unmount();

    // Global («Все чаты») → applies everywhere, never "not applied".
    record = baseRecord({ isGlobal: true });
    const second = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    await second.findByText("promptManager.regex.scopeAll");
    expect(second.queryByText("promptManager.regex.availabilityUnbound")).toBeNull();
    second.unmount();

    // Bind mode with one resolvable link → applies.
    getRegexLinksMock.mockResolvedValue([{ regexPresetId: "r1", targetType: "preset", targetId: "pp1" }]);
    listPromptPresetsMock.mockResolvedValue([{ id: "pp1", name: "Deep RP" }]);
    record = baseRecord({ id: brandId<RegexPresetId>("r1"), isGlobal: false });
    const third = render(<RegexPresetEditor preset={record} draft={regexDraftFromRecord(record)} onDraftChange={mock()} />);
    expect(await third.findByText("Deep RP")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(third.queryByText("promptManager.regex.availabilityUnbound")).toBeNull();
  });
});
