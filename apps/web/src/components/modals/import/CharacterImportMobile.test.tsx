/**
 * Behavior pin for `<CharacterImportMobile>` (plan unit IF-5).
 *
 * The orchestrator wires IF-3 `useMobileFilePicker`, IF-1 `parseCharacterFile`,
 * IF-2 `CharacterImportPreview`, and IF-4 `<ImportPreviewModal>` behind a
 * `forwardRef` imperative handle. These tests lock the contract IF-6 will rely
 * on:
 *   • renders the hidden input with the character `accept` and no modal at rest;
 *   • `openPicker()` triggers the native picker via `input.click()`;
 *   • a successful parse mounts the preview modal with the right title /
 *     subtitle / confirm label;
 *   • confirm calls `onImportFiles([file])` and clears the modal;
 *   • cancel / close clears the modal without invoking `onImportFiles`;
 *   • a parse failure toasts `err.message` and opens no modal;
 *   • dismissing the native picker (no selection) opens no modal;
 *   • the avatar object URL is revoked on close, confirm, and unmount;
 *   • overlapping selections commit only the newest parse result, and a stale
 *     result's avatar URL is revoked immediately;
 *   • a parse resolving after unmount commits nothing and revokes its URL.
 *
 * `parseCharacterFile` is mocked per-test with real exports spread so
 * `initial` / `truncate` / types stay intact for `<CharacterImportPreview>`).
 * `useT` is mocked to `(key) => key` for locale-independent assertions (same
 * pattern as `ImportPreviewModal.test.tsx`). `sonner`'s `toast` is mocked so
 * parse-error assertions don't depend on the real toast renderer.
 *
 * Runner: bun:test with scoped happy-dom cleanup.
 */
import { beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createRef } from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { mocked } from "../../../../test/mock-utils.js";
import type { CharacterImportMobileHandle } from "./CharacterImportMobile.js";
import type { CharacterPreview } from "./parse-import-file.js";

useDomEnv();

const toastError = mock();
const toastSuccess = mock();
const toastWarning = mock();
const toastInfo = mock();
const realI18nContext = await import("../../../i18n/context.js");
const realSonner = await import("sonner");
const realParseImportFile = await import("./parse-import-file.js");
const parseCharacterFile = mock(realParseImportFile.parseCharacterFile);

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

mock.module("sonner", () => ({
  ...realSonner,
  toast: {
    ...realSonner.toast,
    error: toastError,
    success: toastSuccess,
    warning: toastWarning,
    info: toastInfo,
  },
}));

mock.module("./parse-import-file.js", () => ({
  ...realParseImportFile,
  parseCharacterFile,
}));

let CharacterImportMobile: typeof import("./CharacterImportMobile.js").CharacterImportMobile;
beforeAll(async () => {
  ({ CharacterImportMobile } = await import("./CharacterImportMobile.js"));
});

const onImportFiles = mock();
const mockParse = mocked(parseCharacterFile);
const mockToastError = mocked(toastError);

const PNG_FILE = new File(["x"], "card.png", { type: "image/png" });
const MOCK_AVATAR_URL = "blob:mock-avatar-url";

function previewFor(file: File, name: string, avatarUrl: string | null): CharacterPreview {
  return { file, name, description: "desc", tags: ["tag1"], avatarUrl };
}

function mockPreview(avatarUrl: string | null): CharacterPreview {
  return previewFor(PNG_FILE, "Test Character", avatarUrl);
}

function deferred<T>() {
  const holder: { resolve: ((value: T) => void) | null } = { resolve: null };
  const promise = new Promise<T>((res) => {
    holder.resolve = res;
  });
  if (holder.resolve === null) throw new Error("Promise executor did not run synchronously");
  return { promise, resolve: holder.resolve };
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

function pickFile(input: HTMLInputElement, file: File): void {
  setFiles(input, [file]);
  fireEvent.change(input);
}

function renderOrchestrator(isImporting = false) {
  const ref = createRef<CharacterImportMobileHandle>();
  const utils = render(<CharacterImportMobile ref={ref} isImporting={isImporting} onImportFiles={onImportFiles} />);
  return { ...utils, ref };
}

function renderWithInput() {
  const utils = renderOrchestrator();
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { ...utils, input };
}

function setupOverlap() {
  const fileA = new File(["a"], "a.png", { type: "image/png" });
  const fileB = new File(["b"], "b.png", { type: "image/png" });
  const parseA = deferred<CharacterPreview>();
  const parseB = deferred<CharacterPreview>();
  mockParse.mockImplementation((file) => (file === fileA ? parseA.promise : parseB.promise));
  const { input, ...utils } = renderWithInput();
  pickFile(input, fileA);
  pickFile(input, fileB);
  return { ...utils, input, fileA, fileB, parseA, parseB };
}

beforeEach(() => {
  onImportFiles.mockClear();
  mockParse.mockReset();
  mockToastError.mockClear();
});

describe("CharacterImportMobile", () => {
  it("renders a hidden file input with the character accept and no preview modal at rest", () => {
    const { input } = renderWithInput();
    expect(input).not.toBeNull();
    expect(input.className).toBe("hidden");
    expect(input.accept).toBe(".png,.json,.md,.markdown,.vtmd,image/png,application/json");
    expect(document.body.textContent).not.toContain("character_import_title");
  });

  it("openPicker triggers the native picker via input.click() click-through", () => {
    const { ref, input } = renderWithInput();
    const clickSpy = spyOn(input, "click");
    ref.current?.openPicker();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("mounts the preview modal with title, subtitle, and confirm label after a successful parse", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const { input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    expect(document.body.textContent).toContain("character_import_sub");
    expect(document.body.textContent).toContain("add_to_library");
  });

  it("confirm calls onImportFiles([file]) and closes the modal", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const { getByText, input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("add_to_library");
    });
    fireEvent.click(getByText("add_to_library"));
    expect(onImportFiles).toHaveBeenCalledTimes(1);
    expect(onImportFiles).toHaveBeenCalledWith([PNG_FILE]);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("character_import_title");
    });
  });

  it("cancel clears the modal without calling onImportFiles", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const { getByText, input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    fireEvent.click(getByText("cancel"));
    expect(onImportFiles).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("character_import_title");
    });
  });

  it("toasts err.message and opens no modal when parsing throws", async () => {
    mockParse.mockRejectedValue(new Error("boom"));
    const { input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
    expect(document.body.textContent).not.toContain("character_import_title");
  });

  it("does not open a modal when the native picker is dismissed without a selection", () => {
    const { input } = renderWithInput();
    setFiles(input, []);
    fireEvent.change(input);
    expect(mockParse).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("character_import_title");
  });

  it("revokes the avatar object URL when the modal is closed", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { getByText, input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    fireEvent.click(getByText("cancel"));
    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    });
    revokeSpy.mockRestore();
  });

  it("revokes the avatar object URL when the user confirms", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { getByText, input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    fireEvent.click(getByText("add_to_library"));
    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    });
    revokeSpy.mockRestore();
  });

  it("revokes the avatar object URL on unmount", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { unmount, input } = renderWithInput();
    pickFile(input, PNG_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    unmount();
    expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    revokeSpy.mockRestore();
  });

  it("commits only the newest selection when two parses overlap", async () => {
    const { getByText, fileA, fileB, parseA, parseB } = setupOverlap();
    await act(async () => parseB.resolve(previewFor(fileB, "Second Character", null)));
    expect(document.body.textContent).toContain("Second Character");
    // The first selection resolves last — its result must be ignored.
    await act(async () => parseA.resolve(previewFor(fileA, "First Character", null)));
    expect(document.body.textContent).toContain("Second Character");
    expect(document.body.textContent).not.toContain("First Character");
    fireEvent.click(getByText("add_to_library"));
    expect(onImportFiles).toHaveBeenCalledTimes(1);
    expect(onImportFiles).toHaveBeenCalledWith([fileB]);
  });

  it("revokes the avatar URL of a stale parse result immediately and never renders it", async () => {
    const { fileA, fileB, parseA, parseB } = setupOverlap();
    const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await act(async () => parseB.resolve(previewFor(fileB, "Second Character", "blob:fresh")));
    await act(async () => parseA.resolve(previewFor(fileA, "First Character", "blob:stale")));
    expect(revokeSpy).toHaveBeenCalledWith("blob:stale");
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:fresh");
    expect(document.body.textContent).toContain("Second Character");
    expect(document.body.textContent).not.toContain("First Character");
    revokeSpy.mockRestore();
  });

  it("revokes the avatar URL and commits nothing when the parse resolves after unmount", async () => {
    const parseA = deferred<CharacterPreview>();
    mockParse.mockReturnValue(parseA.promise);
    const revokeSpy = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { unmount, input } = renderWithInput();
    pickFile(input, PNG_FILE);
    unmount();
    await act(async () => parseA.resolve(previewFor(PNG_FILE, "Late Character", MOCK_AVATAR_URL)));
    expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    expect(document.body.textContent).not.toContain("Late Character");
    expect(onImportFiles).not.toHaveBeenCalled();
    revokeSpy.mockRestore();
  });
});
