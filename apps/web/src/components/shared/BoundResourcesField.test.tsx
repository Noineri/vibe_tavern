import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

/**
 * BoundResourcesField — regex preset group (RX-12).
 *
 * Pins the reverse-direction regex binding: a character editor renders a
 * "bound regex presets" pill group (linked presets as pills, unlinked absent),
 * while the persona editor renders NO regex group at all (regex links are
 * character|preset only — persona is excluded by design).
 *
 * Toggle-ON via the popover chip can't mount in happy-dom (Radix Popper needs
 * a real anchor box — see LinkBindingPopover.test.tsx's skipped test for the
 * full explanation); the RMW write path is covered by RegexPresetEditor's
 * setRegexLinks test for the forward direction.
 */
useDomEnv();
const { render, screen } = await import("@testing-library/react");

const realI18nContext = await import("../../i18n/context.js");
const realTooltip = await import("./Tooltip.js");
const realAppClient = await import("../../app-client.js");

const listAllRegexPresetsMock = mock(() => Promise.resolve([] as unknown[]));
const getRegexLinksMock = mock((_id: string) => Promise.resolve([] as Array<{ regexPresetId: string; targetType: "character" | "preset"; targetId: string }>));

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("./Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { content?: string; children: React.ReactNode }) => <>{children}</>,
}));

mock.module("../../app-client.js", () => ({
  ...realAppClient,
  listAllLorebooks: () => Promise.resolve([]),
  listCharacterLorebooks: () => Promise.resolve([]),
  listPersonaLorebooks: () => Promise.resolve([]),
  listAllScripts: () => Promise.resolve([]),
  listCharacterScripts: () => Promise.resolve([]),
  listPersonaScripts: () => Promise.resolve([]),
  listAllRegexPresets: listAllRegexPresetsMock,
  getRegexLinks: getRegexLinksMock,
}));

let BoundResourcesField: typeof import("./BoundResourcesField.js").BoundResourcesField;
beforeAll(async () => {
  ({ BoundResourcesField } = await import("./BoundResourcesField.js"));
});

function regexPreset(id: string, name: string) {
  return {
    id,
    name,
    findRegex: "/x/g",
    replaceString: "y",
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
    createdAt: "",
    updatedAt: "",
  };
}

describe("BoundResourcesField — regex group", () => {
  it("renders the regex group for a character and lists linked presets as pills", async () => {
    listAllRegexPresetsMock.mockResolvedValue([regexPreset("rx1", "No Italics"), regexPreset("rx2", "Trim Think")]);
    getRegexLinksMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "rx1" ? [{ regexPresetId: "rx1", targetType: "character" as const, targetId: "c1" }] : [],
      ),
    );
    render(<BoundResourcesField entityKind="character" entityId="c1" isMobile={false} />);
    expect(await screen.findByText("bound_regex_label")).toBeTruthy();
    // Linked preset renders as a pill; the unlinked one does not appear in the row.
    expect(await screen.findByText("No Italics")).toBeTruthy();
    expect(screen.queryByText("Trim Think")).toBeNull();
  });

  it("renders no regex group for a persona (regex links are character-only)", async () => {
    listAllRegexPresetsMock.mockClear();
    render(<BoundResourcesField entityKind="persona" entityId="p1" isMobile={false} />);
    // The script group marks the field as loaded; the regex label must never appear.
    expect(await screen.findByText("bound_scripts_label")).toBeTruthy();
    expect(screen.queryByText("bound_regex_label")).toBeNull();
    // And the regex API is never even queried for a persona.
    expect(listAllRegexPresetsMock).not.toHaveBeenCalled();
  });
});
