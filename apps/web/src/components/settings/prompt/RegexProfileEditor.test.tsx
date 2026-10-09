import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");
const realRegexApi = await import("../../../api/regex-api.js");
const realPresetApi = await import("../../../api/preset-api.js");
const realTooltip = await import("../../shared/Tooltip.js");
let isMobile = false;
const getRegexProfileLinksMock = mock(async () => [] as Awaited<ReturnType<typeof realRegexApi.getRegexProfileLinks>>);
const setRegexProfileLinksMock = mock(async () => [] as Awaited<ReturnType<typeof realRegexApi.setRegexProfileLinks>>);
const listPromptPresetsMock = mock(async () => [] as Awaited<ReturnType<typeof realPresetApi.listPromptPresets>>);

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => isMobile }));
mock.module("../../../api/regex-api.js", () => ({
  ...realRegexApi,
  getRegexProfileLinks: getRegexProfileLinksMock,
  setRegexProfileLinks: setRegexProfileLinksMock,
}));
mock.module("../../../api/preset-api.js", () => ({ ...realPresetApi, listPromptPresets: listPromptPresetsMock }));
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
let RegexProfileEditor: typeof import("./RegexProfileEditor.js").RegexProfileEditor;

beforeAll(async () => {
  ({ RegexProfileEditor } = await import("./RegexProfileEditor.js"));
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  isMobile = false;
  mock.clearAllMocks();
  getRegexProfileLinksMock.mockResolvedValue([]);
  setRegexProfileLinksMock.mockResolvedValue([]);
  listPromptPresetsMock.mockResolvedValue([]);
});

function profile(overrides: Partial<RegexProfileRecord> = {}): RegexProfileRecord {
  return {
    id: brandId<RegexProfileId>("profile-1"), name: "My Profile", disabled: false, isGlobal: true,
    sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function rule(id: string, name: string, profileId: string | null): RegexPresetRecord {
  return {
    id: brandId<RegexPresetId>(id), name, findRegex: "/x/g", replaceString: "", trimStrings: [],
    substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false,
    minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0,
    profileId: profileId === null ? null : brandId<RegexProfileId>(profileId),
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function renderEditor(memberCount: number, rules: RegexPresetRecord[]) {
  const onCreateRule = mock();
  const onAttachRules = mock();
  const onDetachRules = mock();
  const view = render(
    <RegexProfileEditor
      profile={profile()}
      memberCount={memberCount}
      rules={rules}
      onCreateRule={onCreateRule}
      onAttachRules={onAttachRules}
      onDetachRules={onDetachRules}
      onNameChange={mock()}
      onActiveToggle={mock()}
      onScopeChange={mock()}
    />,
  );
  await act(async () => {});
  return { ...view, onCreateRule, onAttachRules, onDetachRules };
}

describe("RegexProfileEditor — availability reason marker", () => {
  test("withholds Unbound while profile links load, then shows it for confirmed zero reachable links", async () => {
    let resolveLinks!: (rows: Awaited<ReturnType<typeof realRegexApi.getRegexProfileLinks>>) => void;
    getRegexProfileLinksMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLinks = resolve; }));
    const view = render(
      <RegexProfileEditor
        profile={profile({ isGlobal: false })}
        memberCount={0}
        rules={[]}
        onCreateRule={mock()}
        onAttachRules={mock()}
        onDetachRules={mock()}
        onNameChange={mock()}
        onActiveToggle={mock()}
        onScopeChange={mock()}
      />,
    );

    expect(view.queryByText("promptManager.regex.availabilityUnbound")).toBeNull();
    await act(async () => { resolveLinks([]); });
    expect(view.getByText("promptManager.regex.availabilityUnbound")).toBeTruthy();
  });
});

describe("RegexProfileEditor — member workflows (RXU-42; picker rides the shared LinkBindingPopover per owner ruling 2026-10-09)", () => {
  test("shows prominent Create Rule and the shared Add existing trigger for a Profile with members", async () => {
    const view = await renderEditor(1, [rule("member-1", "Member", "profile-1"), rule("standalone-1", "Standalone", null)]);
    const create = view.getByRole("button", { name: "promptManager.regex.createRule" });
    // The popover's labeled dashed trigger (canon shape — accessible name
    // is the aria-label, i.e. pickerTitle, not the visible pickerTrigger text).
    const addExisting = view.getByRole("button", { name: "promptManager.regex.pickerTitle" });

    expect(create.className).toContain("h-11");
    expect(addExisting.textContent).toContain("promptManager.regex.pickerTrigger");
    fireEvent.click(create);
    expect(view.onCreateRule).toHaveBeenCalledTimes(1);
  });

  test("replaces the count-only hint with an empty state containing both actions", async () => {
    const view = await renderEditor(0, [rule("standalone-1", "Standalone", null)]);
    const emptyState = view.getByTestId("regex-profile-members-empty-state");

    expect(within(emptyState).getByText("promptManager.regex.profileMembersEmptyTitle")).toBeTruthy();
    expect(within(emptyState).queryByText("promptManager.regex.profileMemberCount")).toBeNull();
    expect(within(emptyState).getByRole("button", { name: "promptManager.regex.createRule" }).className).toContain("h-11");
    expect(within(emptyState).getByRole("button", { name: "promptManager.regex.pickerTitle" }).textContent).toContain("promptManager.regex.pickerTrigger");
  });

  test("opens the shared picker and attaches standalone Rules with immediate toggles", async () => {
    const view = await renderEditor(1, [
      rule("member-1", "Member", "profile-1"),
      rule("standalone-1", "Standalone", null),
      rule("standalone-2", "Second standalone", null),
    ]);
    // Closed popover: no member/standalone names in the pane.
    expect(view.queryByText("Standalone")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTitle" }));

    // Chips: own member (active) + both standalone candidates; the member
    // chip carries the accent (bound) styling.
    const memberChip = view.getByText("Member").closest("div");
    expect(memberChip?.className).toContain("border-accent");
    fireEvent.click(view.getByText("Standalone"));
    await act(async () => {});
    expect(view.onAttachRules).toHaveBeenCalledWith(["standalone-1"]);
    fireEvent.click(view.getByText("Second standalone"));
    await act(async () => {});
    expect(view.onAttachRules).toHaveBeenCalledWith(["standalone-2"]);
    expect(view.onDetachRules).not.toHaveBeenCalled();
  });

  test("toggling the active member chip detaches it back to Standalone", async () => {
    const view = await renderEditor(1, [rule("member-1", "Member", "profile-1")]);
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTitle" }));

    fireEvent.click(view.getByText("Member"));
    await act(async () => {});
    expect(view.onDetachRules).toHaveBeenCalledWith(["member-1"]);
    expect(view.onAttachRules).not.toHaveBeenCalled();
  });

  test("shows the popover empty label when no attach candidates and no members exist", async () => {
    const view = await renderEditor(0, []);
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTitle" }));

    expect(view.getByText("promptManager.regex.pickerEmptySub")).toBeTruthy();
  });

  test("opens the shared picker in its mobile sheet", async () => {
    isMobile = true;
    const view = await renderEditor(1, [rule("standalone-1", "Standalone", null)]);
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTitle" }));

    expect(view.getByText("promptManager.regex.pickerTitle")).toBeTruthy();
    expect(view.getByText("Standalone")).toBeTruthy();
  });
});
