import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { RegexPresetRecord, RegexProfileRecord } from "../../../api/types.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");
const realRegexApi = await import("../../../api/regex-api.js");
const realPresetApi = await import("../../../api/preset-api.js");
const getRegexProfileLinksMock = mock(async () => [] as Awaited<ReturnType<typeof realRegexApi.getRegexProfileLinks>>);
const setRegexProfileLinksMock = mock(async () => [] as Awaited<ReturnType<typeof realRegexApi.setRegexProfileLinks>>);
const listPromptPresetsMock = mock(async () => [] as Awaited<ReturnType<typeof realPresetApi.listPromptPresets>>);

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));
mock.module("../../../api/regex-api.js", () => ({
  ...realRegexApi,
  getRegexProfileLinks: getRegexProfileLinksMock,
  setRegexProfileLinks: setRegexProfileLinksMock,
}));
mock.module("../../../api/preset-api.js", () => ({ ...realPresetApi, listPromptPresets: listPromptPresetsMock }));

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
let RegexProfileEditor: typeof import("./RegexProfileEditor.js").RegexProfileEditor;

beforeAll(async () => {
  ({ RegexProfileEditor } = await import("./RegexProfileEditor.js"));
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mock.clearAllMocks();
  getRegexProfileLinksMock.mockResolvedValue([]);
  setRegexProfileLinksMock.mockResolvedValue([]);
  listPromptPresetsMock.mockResolvedValue([]);
});

function profile(): RegexProfileRecord {
  return {
    id: brandId<RegexProfileId>("profile-1"), name: "My Profile", disabled: false, isGlobal: true,
    sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
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
  const view = render(
    <RegexProfileEditor
      profile={profile()}
      memberCount={memberCount}
      rules={rules}
      onCreateRule={onCreateRule}
      onAttachRules={onAttachRules}
      onNameCommit={mock()}
      onActiveToggle={mock()}
      onScopeChange={mock()}
      onExport={mock()}
      onDeleteClick={mock()}
    />,
  );
  await act(async () => {});
  return { ...view, onCreateRule, onAttachRules };
}

describe("RegexProfileEditor — member workflows (RXU-42)", () => {
  test("shows prominent Create Rule and Add existing actions for a Profile with members", async () => {
    const view = await renderEditor(1, [rule("member-1", "Member", "profile-1"), rule("standalone-1", "Standalone", null)]);
    const create = view.getByRole("button", { name: "promptManager.regex.createRule" });
    const addExisting = view.getByRole("button", { name: "promptManager.regex.pickerTrigger" });

    expect(create.className).toContain("h-11");
    expect(addExisting.className).toContain("h-11");
    fireEvent.click(create);
    expect(view.onCreateRule).toHaveBeenCalledTimes(1);
  });

  test("replaces the count-only hint with an empty state containing both prominent actions", async () => {
    const view = await renderEditor(0, [rule("standalone-1", "Standalone", null)]);
    const emptyState = view.getByTestId("regex-profile-members-empty-state");

    expect(within(emptyState).getByText("promptManager.regex.profileMembersEmptyTitle")).toBeTruthy();
    expect(within(emptyState).queryByText("promptManager.regex.profileMemberCount")).toBeNull();
    expect(within(emptyState).getByRole("button", { name: "promptManager.regex.createRule" }).className).toContain("h-11");
    expect(within(emptyState).getByRole("button", { name: "promptManager.regex.pickerTrigger" }).className).toContain("h-11");
  });

  test("opens the shared picker and forwards selected standalone Rule ids", async () => {
    const view = await renderEditor(1, [rule("member-1", "Member", "profile-1"), rule("standalone-1", "Standalone", null)]);
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Standalone" }));
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerAttach" }));

    expect(view.onAttachRules).toHaveBeenCalledWith(["standalone-1"]);
  });
});
