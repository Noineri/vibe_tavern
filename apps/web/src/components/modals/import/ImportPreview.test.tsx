import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { RegexScriptImportDraft } from "@vibe-tavern/import-export";

import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { installToggleSeam } from "../../../../test/toggle-seam.js";
import type { CharacterPreview } from "./parse-import-file.js";

useDomEnv();

const { render, fireEvent, waitFor } = await import("@testing-library/react");

let useRussian = false;
const realParseImportFile = await import("./parse-import-file.js");
const parseCharacterFile = mock(realParseImportFile.parseCharacterFile);

// Hand port onto the shared seam (mutable-locale family): the suite's own `t`
// closes over the `useRussian` flag EXACTLY as the old inline mock did — the
// closure is read per render, so flipping the flag mid-suite keeps working.
// The old mock's `locale: useRussian ? "ru" : "en"` field is dropped as inert
// (ImportPreview destructures only `t`; verified — nothing in this graph
// reads `locale`). A mounted provider still delegates to real i18n.
installI18nContextSeam({
  custom: {
    t: (key, values?) => {
      if (key === "regexImport.profileSummary") {
        return `${values?.n} Rules · ${values?.enabled} enabled · ${values?.disabled} disabled`;
      }
      if (useRussian && key === "regexImport.enableAfterImport") return "Включить профиль сразу после импорта";
      if (useRussian && key === "regexImport.scopeCharacter") return "Импортированный персонаж";
      return key;
    },
    tDynamic: (key: string) => key,
  },
});

// CO-LOAD CONTRACT (toggle-seam family): this suite drives the REAL wrapped
// Radix Toggle (`getByRole("switch")` on the import rows) — register the
// real arm so a co-loaded stub suite's Toggle registration cannot poison it
// in a hand-bundled run (mock.module is last-write-wins).
installToggleSeam();

mock.module("./parse-import-file.js", () => ({
  ...realParseImportFile,
  parseCharacterFile,
}));

let CharacterImportPreview: typeof import("./ImportPreview.js").CharacterImportPreview;
let ChatImportPreview: typeof import("./ImportPreview.js").ChatImportPreview;
let CharacterImportModal: typeof import("../ImportModals.js").CharacterImportModal;
beforeAll(async () => {
  ({ CharacterImportPreview, ChatImportPreview } = await import("./ImportPreview.js"));
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
  // RXU-25 (CI_WEB_TIMING_FLAKES_REPORT): park on the PREVIEW-committed frame,
  // not the footer. `add_to_library` is ImportModalFooter's confirm label and
  // renders unconditionally from the FIRST commit (ImportModals.tsx:420,
  // disabled until parsed), so this await could resolve before
  // parseCharacterFile's async continuation committed — and the callers'
  // queries raced the CharacterImportPreview mount (the switch query found no
  // element; the ScrollAreaRoot act(...) warning was that same late commit).
  // `ready_to_import` renders only from the preview body, in the SAME commit
  // that mounts the Regex card's switch — parking here narrows the race to
  // zero for every caller.
  await waitFor(() => expect(view.baseElement.textContent).toContain("ready_to_import"));
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

// ─── CNR-8r: thin-lane chrome pins ─────────────────────────────────────────
// The host's global native fallback is gone; every desktop-visible scroller in
// this family rides the shared thin lane. Same boundary as the CNR-8g/8p
// per-surface structural pins: lane root + cap/content split + docked footer.
describe("import previews — thin scroll lanes (CNR-8r)", () => {
  it("ChatImportPreview's capped message list rides the thin lane with the cap on the root", () => {
    const chatFile = new File(["{}"], "chat.jsonl", { type: "application/json" });
    const view = render(
      <ChatImportPreview
        preview={{
          file: chatFile,
          fileName: "chat.jsonl",
          title: "Chat",
          messageCount: 2,
          characterName: "Zack",
          messages: [
            { role: "user", name: "User", text: "hi" },
            { role: "assistant", name: "Zack", text: "hello" },
          ],
        }}
      />,
    );
    const area = view.container.querySelector('[data-scroll-area="thin"]');
    if (!area) throw new Error("thin lane root not rendered");
    expect(area.classList.contains("max-h-[250px]")).toBe(true);
    expect(area.querySelector("[data-scroll-viewport]")).not.toBeNull();
    expect(area.querySelector("[data-scroll-content]")?.textContent).toContain("hello");
  });

  it("CharacterImportModal's body rides the thin lane; the docked footer stays outside it", async () => {
    const view = await openDesktopPreview();
    const body = view.baseElement.querySelectorAll('[data-scroll-area="thin"]');
    expect(body.length).toBeGreaterThan(0);
    const modalBody = [...body].find((el) => el.querySelector("[data-scroll-content]")?.textContent?.includes("ready_to_import"));
    if (!modalBody) throw new Error("modal body lane not rendered");
    expect(modalBody.classList.contains("flex-1")).toBe(true);
    // The confirm footer (add_to_library) is a SIBLING after the lane, never
    // inside the scroller — it stays docked while the body scrolls.
    const footerBtn = [...view.baseElement.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("add_to_library"));
    if (!footerBtn) throw new Error("footer confirm button not rendered");
    expect(footerBtn.closest("[data-scroll-area]")).toBeNull();
  });
});
