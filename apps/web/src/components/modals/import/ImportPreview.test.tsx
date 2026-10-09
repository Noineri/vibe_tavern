import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { RegexScriptImportDraft } from "@vibe-tavern/import-export";

import { useDomEnv } from "../../../../test/dom-env.js";
import type { CharacterPreview } from "./parse-import-file.js";

useDomEnv();

const { render, fireEvent, waitFor } = await import("@testing-library/react");

let useRussian = false;
const realI18nContext = await import("../../../i18n/context.js");
const realParseImportFile = await import("./parse-import-file.js");
const parseCharacterFile = mock(realParseImportFile.parseCharacterFile);

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, values?: Record<string, number>) => {
      if (key === "regexImport.profileSummary") {
        return `${values?.n} Rules · ${values?.enabled} enabled · ${values?.disabled} disabled`;
      }
      if (useRussian && key === "regexImport.enableAfterImport") return "Включить профиль сразу после импорта";
      if (useRussian && key === "regexImport.scopeCharacter") return "Импортированный персонаж";
      return key;
    },
    tDynamic: (key: string) => key,
    locale: useRussian ? "ru" : "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("./parse-import-file.js", () => ({
  ...realParseImportFile,
  parseCharacterFile,
}));

let CharacterImportPreview: typeof import("./ImportPreview.js").CharacterImportPreview;
let CharacterImportModal: typeof import("../ImportModals.js").CharacterImportModal;
beforeAll(async () => {
  ({ CharacterImportPreview } = await import("./ImportPreview.js"));
  ({ CharacterImportModal } = await import("../ImportModals.js"));
});

const onImportFiles = mock();
const CARD_FILE = new File(["card"], "card.json", { type: "application/json" });

function regexDraft(name: string, disabled: boolean): RegexScriptImportDraft {
  return {
    name,
    findRegex: "/x/g",
    replaceString: "",
    trimStrings: [],
    substituteRegex: 0,
    disabled,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: false,
    sortOrder: 0,
    profileId: null,
    sourceScript: { scriptName: name },
  };
}

function preview(regexScripts?: RegexScriptImportDraft[]): CharacterPreview {
  return {
    file: CARD_FILE,
    name: "Imported character",
    description: "Description",
    tags: [],
    hasEmbeddedLorebook: false,
    avatarUrl: null,
    ...(regexScripts?.length ? { regexScripts } : {}),
  };
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

async function openDesktopPreview(rules?: RegexScriptImportDraft[]) {
  parseCharacterFile.mockResolvedValue(preview(rules));
  const view = render(
    <CharacterImportModal
      isImporting={false}
      onClose={() => {}}
      onImportFiles={onImportFiles}
      showEmbeddedBookImport
    />,
  );
  const input = view.baseElement.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("Character import input did not render");
  setFiles(input, [CARD_FILE]);
  fireEvent.change(input);
  await waitFor(() => expect(view.baseElement.textContent).toContain("add_to_library"));
  return view;
}

beforeEach(() => {
  onImportFiles.mockClear();
  parseCharacterFile.mockReset();
  useRussian = false;
});

describe("CharacterImportPreview — Regex Profile card (RXU-25)", () => {
  it("renders zero Regex card DOM for a card without embedded Rules", () => {
    const view = render(<CharacterImportPreview preview={preview()} />);

    expect(view.queryByTestId("regex-import-profile-card")).toBeNull();
    expect(view.queryByRole("switch", { name: "regexImport.enableAfterImport" })).toBeNull();
  });

  it("renders one-Rule and mixed source-state summaries in the default-off character scope card", () => {
    const oneRuleView = render(
      <CharacterImportPreview
        preview={preview([regexDraft("Enabled", false)])}
        enableImportedRegexProfile={false}
        onEnableImportedRegexProfileChange={() => {}}
      />,
    );
    expect(oneRuleView.getByTestId("regex-import-profile-card").textContent).toContain("1 Rules · 1 enabled · 0 disabled");
    oneRuleView.unmount();

    const mixedView = render(
      <CharacterImportPreview
        preview={preview([regexDraft("Enabled", false), regexDraft("Disabled", true), regexDraft("Also enabled", false)])}
        enableImportedRegexProfile={false}
        onEnableImportedRegexProfileChange={() => {}}
      />,
    );

    expect(mixedView.getByTestId("regex-import-profile-card").textContent).toContain("regexImport.scopeCharacter");
    expect(mixedView.getByTestId("regex-import-profile-card").textContent).toContain("3 Rules · 2 enabled · 1 disabled");
    expect(mixedView.getByRole("switch", { name: "regexImport.enableAfterImport" }).getAttribute("aria-checked")).toBe("false");
  });

  it("preserves wrapping room for long Russian scope and activation copy on mobile", () => {
    useRussian = true;
    const view = render(
      <CharacterImportPreview
        preview={preview([regexDraft("Enabled", false)])}
        enableImportedRegexProfile={false}
        onEnableImportedRegexProfileChange={() => {}}
      />,
    );

    const card = view.getByTestId("regex-import-profile-card");
    expect(card.textContent).toContain("Импортированный персонаж");
    expect(card.textContent).toContain("Включить профиль сразу после импорта");
    expect(card.querySelector(".truncate")).toBeNull();
    expect(view.getByRole("switch", { name: "Включить профиль сразу после импорта" }).parentElement?.className).toContain("min-h-11");
  });

  it("passes the default-off choice without a transport field and sends true after activation", async () => {
    const defaultView = await openDesktopPreview([regexDraft("Enabled", false)]);
    fireEvent.click(defaultView.getByText("add_to_library"));
    expect(onImportFiles).toHaveBeenCalledWith([CARD_FILE], { importEmbeddedBook: false });
    defaultView.unmount();

    onImportFiles.mockClear();
    const enabledView = await openDesktopPreview([regexDraft("Enabled", false)]);
    fireEvent.click(enabledView.getByRole("switch", { name: "regexImport.enableAfterImport" }));
    fireEvent.click(enabledView.getByText("add_to_library"));
    expect(onImportFiles).toHaveBeenCalledWith([CARD_FILE], {
      importEmbeddedBook: false,
      enableImportedRegexProfile: true,
    });
  });
});
