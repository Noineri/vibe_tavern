import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import { brandId, type RegexProfileId } from "@vibe-tavern/domain";
import { parseStandaloneRegexJson } from "@vibe-tavern/import-export";
import type { CreateRegexProfileBundleBody, RegexProfileBundleRecord } from "../../api/regex-api.js";

const realI18nContext = await import("../../i18n/context.js");
const realUseMobile = await import("../../hooks/use-mobile.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
let RegexImportModal: typeof import("./RegexImportModal.js").RegexImportModal;
let buildStandaloneRegexImportBundle: typeof import("./RegexImportModal.js").buildStandaloneRegexImportBundle;

beforeAll(async () => {
  ({ RegexImportModal, buildStandaloneRegexImportBundle } = await import("./RegexImportModal.js"));
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

function regexFile(contents: string, name = "imported-rules.json") {
  return new File([contents], name, { type: "application/json" });
}

function bundleResult(): RegexProfileBundleRecord {
  return {
    profile: { id: brandId<RegexProfileId>("profile-1"), name: "Imported", disabled: true, isGlobal: false, sortOrder: 0, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
    rules: [],
  };
}

function renderModal(options: {
  contents: string;
  name?: string;
  currentPresetId?: string | null;
  currentCharacterId?: string | null;
  onImport?: (body: CreateRegexProfileBundleBody) => Promise<RegexProfileBundleRecord>;
}) {
  const onImport = mock(options.onImport ?? (async () => bundleResult()));
  const onImported = mock();
  const view = render(
    <RegexImportModal
      file={regexFile(options.contents, options.name)}
      currentPresetId={"currentPresetId" in options ? options.currentPresetId ?? null : "preset-1"}
      currentCharacterId={"currentCharacterId" in options ? options.currentCharacterId ?? null : "character-1"}
      onClose={() => {}}
      onImport={onImport}
      onImported={onImported}
    />,
  );
  return Object.assign(view, { onImport, onImported });
}

const oneRule = { scriptName: "One", findRegex: "/one/g", replaceString: "one", disabled: false };

describe("RegexImportModal", () => {
  test.each([
    ["single object", JSON.stringify(oneRule)],
    ["array", JSON.stringify([oneRule])],
    ["scripts wrapper", JSON.stringify({ scripts: [oneRule] })],
    ["single Rule", JSON.stringify({ ...oneRule, scriptName: "Only Rule" })],
  ])("parses %s into the Profile preview", async (_shape, contents) => {
    const view = renderModal({ contents });
    await view.findByText("regexImport.profileSummary");
    expect(view.getByDisplayValue("imported-rules")).toBeTruthy();
  });

  test("single Rule creates exactly one unbound Profile bundle with source state intact", async () => {
    const view = renderModal({ contents: JSON.stringify(oneRule) });
    await view.findByText("regexImport.profileSummary");
    expect(view.getByRole("switch", { name: "regexImport.enableAfterImport" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(view.getByRole("radio", { name: "regexImport.scopeUnbound" }));
    fireEvent.click(view.getByRole("button", { name: "regexImport.importButton" }));
    await waitFor(() => expect(view.onImport).toHaveBeenCalledTimes(1));
    expect(view.onImport.mock.calls[0][0]).toMatchObject({
      name: "imported-rules",
      disabled: true,
      isGlobal: false,
      rules: [{ name: "One", disabled: false }],
    });
    expect(view.onImported).toHaveBeenCalledTimes(1);
  });

  test("all scopes produce their exact Profile links and global flag", () => {
    const rules = parseStandaloneRegexJson(JSON.stringify(oneRule));
    const base = { name: "Bundle", rules, enableProfile: false, currentPresetId: "preset-1", currentCharacterId: "character-1" };
    expect(buildStandaloneRegexImportBundle({ ...base, scope: "preset" })).toMatchObject({ isGlobal: false, links: [{ targetType: "preset", targetId: "preset-1" }] });
    expect(buildStandaloneRegexImportBundle({ ...base, scope: "character" })).toMatchObject({ isGlobal: false, links: [{ targetType: "character", targetId: "character-1" }] });
    const global = buildStandaloneRegexImportBundle({ ...base, scope: "global" });
    expect(global).toEqual(expect.objectContaining({ isGlobal: true, rules: expect.any(Array) }));
    expect(global.links).toBeUndefined();
    const unbound = buildStandaloneRegexImportBundle({ ...base, scope: "unbound" });
    expect(unbound).toEqual(expect.objectContaining({ isGlobal: false, rules: expect.any(Array) }));
    expect(unbound.links).toBeUndefined();
  });

  test("unavailable current targets stay disabled and a valid scope is required", async () => {
    const view = renderModal({ contents: JSON.stringify(oneRule), currentPresetId: null, currentCharacterId: null });
    await view.findByText("regexImport.scopePresetUnavailable");
    expect(view.getByRole("radio", { name: "regexImport.scopeCurrentPreset" }).getAttribute("disabled")).not.toBeNull();
    expect(view.getByRole("radio", { name: "regexImport.scopeCurrentCharacter" }).getAttribute("disabled")).not.toBeNull();
    expect((view.getByRole("button", { name: "regexImport.importButton" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("radio", { name: "regexImport.scopeAllChats" }));
    expect((view.getByRole("button", { name: "regexImport.importButton" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("toggle positions invert the Profile disabled payload", () => {
    const base = {
      name: "Bundle",
      rules: parseStandaloneRegexJson(JSON.stringify(oneRule)),
      scope: "global" as const,
      currentPresetId: null,
      currentCharacterId: null,
    };
    expect(buildStandaloneRegexImportBundle({ ...base, enableProfile: false }).disabled).toBe(true);
    expect(buildStandaloneRegexImportBundle({ ...base, enableProfile: true }).disabled).toBe(false);
  });

  test("malformed input has no bundle call", async () => {
    const view = renderModal({ contents: "{ malformed" });
    await view.findByText("regexImport.emptyFile");
    expect(view.onImport).not.toHaveBeenCalled();
  });

  test("bundle failure surfaces an error and does not select a Profile", async () => {
    const view = renderModal({ contents: JSON.stringify(oneRule), onImport: async () => { throw new Error("bundle failed"); } });
    await view.findByText("regexImport.profileSummary");
    fireEvent.click(view.getByRole("radio", { name: "regexImport.scopeAllChats" }));
    fireEvent.click(view.getByRole("button", { name: "regexImport.importButton" }));
    await view.findByRole("alert");
    expect(view.onImport).toHaveBeenCalledTimes(1);
    expect(view.onImported).not.toHaveBeenCalled();
  });
});
