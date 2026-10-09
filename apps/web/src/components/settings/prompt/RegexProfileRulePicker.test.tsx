import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { RegexPresetRecord } from "../../../api/types.js";
import { brandId, type RegexPresetId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render } = await import("@testing-library/react");
const realI18nContext = await import("../../../i18n/context.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");

let isMobile = false;

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => isMobile,
}));

let RegexProfileRulePicker: typeof import("./RegexProfileRulePicker.js").RegexProfileRulePicker;
beforeAll(async () => {
  ({ RegexProfileRulePicker } = await import("./RegexProfileRulePicker.js"));
});

function rule(id: string, name: string, profileId: string | null = null): RegexPresetRecord {
  return {
    id: brandId<RegexPresetId>(id),
    name,
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
    isGlobal: true,
    sortOrder: 0,
    profileId: profileId === null ? null : brandId(profileId),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const rules = [
  rule("standalone-one", "Alpha Rule"),
  rule("member", "Member Rule", "profile-one"),
  rule("standalone-two", "Beta Rule"),
];

function renderPicker(overrides: Partial<Parameters<typeof RegexProfileRulePicker>[0]> = {}) {
  const onAttach = mock();
  const onCancel = mock();
  const view = render(
    <RegexProfileRulePicker
      rules={rules}
      onAttach={onAttach}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...view, onAttach, onCancel };
}

describe("RegexProfileRulePicker", () => {
  beforeEach(() => {
    isMobile = false;
    mock.clearAllMocks();
  });

  it("lists only standalone Rules", () => {
    const view = renderPicker();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));

    expect(view.getByText("Alpha Rule")).toBeTruthy();
    expect(view.getByText("Beta Rule")).toBeTruthy();
    expect(view.queryByText("Member Rule")).toBeNull();
  });

  it("filters by Rule name and shows an actionable empty state when nothing matches", () => {
    const view = renderPicker();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));
    fireEvent.change(view.getByPlaceholderText("promptManager.regex.pickerSearchPlaceholder"), { target: { value: "missing" } });

    expect(view.queryByText("Alpha Rule")).toBeNull();
    expect(view.getByText("promptManager.regex.pickerNoMatchesTitle")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerClearSearch" }));
    expect(view.getByText("Alpha Rule")).toBeTruthy();
  });

  it("attaches selected standalone Rule ids in selection order", () => {
    const view = renderPicker();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));

    fireEvent.click(view.getByRole("checkbox", { name: "Beta Rule" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Alpha Rule" }));
    expect(view.getByRole("checkbox", { name: "Beta Rule" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerAttach" }));
    expect(view.onAttach).toHaveBeenCalledWith(["standalone-two", "standalone-one"]);
    expect(view.onCancel).not.toHaveBeenCalled();
  });

  it("toggles a selection with the keyboard", () => {
    const view = renderPicker();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));

    const alpha = view.getByRole("checkbox", { name: "Alpha Rule" });
    fireEvent.keyDown(alpha, { key: " " });
    expect(alpha.getAttribute("aria-checked")).toBe("true");
  });

  it("renders a long Rule name in full without truncation", () => {
    const longName = "A standalone Rule name that must remain fully readable in the picker";
    const view = renderPicker({ rules: [rule("long", longName)] });
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));

    const name = view.getByText(longName);
    expect(name.getAttribute("title")).toBe(longName);
    expect(name.className).not.toContain("truncate");
  });

  it("cancelling discards a previous selection", () => {
    const view = renderPicker();
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Alpha Rule" }));
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerCancel" }));

    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));
    expect(view.getByRole("checkbox", { name: "Alpha Rule" }).getAttribute("aria-checked")).toBe("false");
  });

  it("shows the empty standalone state immediately", () => {
    const view = renderPicker({ rules: [rule("member", "Member Rule", "profile-one")] });
    fireEvent.click(view.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));

    expect(view.getByText("promptManager.regex.pickerEmptyTitle")).toBeTruthy();
    expect(view.queryByPlaceholderText("promptManager.regex.pickerSearchPlaceholder")).toBeNull();
  });

  it("mounts the shared picker body in both desktop popover and mobile sheet layouts", () => {
    const desktop = renderPicker();
    fireEvent.click(desktop.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));
    expect(desktop.getByRole("checkbox", { name: "Alpha Rule" })).toBeTruthy();
    desktop.unmount();

    isMobile = true;
    const mobile = renderPicker();
    const mobileTrigger = mobile.getByRole("button", { name: "promptManager.regex.pickerTrigger" });
    fireEvent.click(mobileTrigger);
    expect(mobile.getByText("promptManager.regex.pickerTitle")).toBeTruthy();
    expect(mobile.getByRole("checkbox", { name: "Alpha Rule" })).toBeTruthy();
    expect(mobile.getByRole("button", { name: "promptManager.regex.pickerCancel" })).toBeTruthy();
    expect(mobile.getByRole("button", { name: "promptManager.regex.pickerAttach" })).toBeTruthy();
    expect(mobileTrigger.className).toContain("h-11");
    expect(mobile.getByRole("checkbox", { name: "Alpha Rule" }).className).toContain("min-h-11");
    expect(mobile.getByRole("button", { name: "promptManager.regex.pickerAttach" }).className).toContain("h-11");
  });
});
