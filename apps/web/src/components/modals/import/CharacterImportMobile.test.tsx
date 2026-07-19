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
 *   • the avatar object URL is revoked on close, confirm, and unmount.
 *
 * `parseCharacterFile` is mocked per-test (via `vi.importActual` spread so
 * `initial` / `truncate` / types stay intact for `<CharacterImportPreview>`).
 * `useT` is mocked to `(key) => key` for locale-independent assertions (same
 * pattern as `ImportPreviewModal.test.tsx`). `sonner`'s `toast` is mocked so
 * parse-error assertions don't depend on the real toast renderer.
 *
 * Runner: vitest (apps/web) under happy-dom.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("./parse-import-file.js", async () => {
  const actual = await vi.importActual<typeof import("./parse-import-file.js")>("./parse-import-file.js");
  return { ...actual, parseCharacterFile: vi.fn() };
});

import { CharacterImportMobile, type CharacterImportMobileHandle } from "./CharacterImportMobile.js";
import { parseCharacterFile } from "./parse-import-file.js";
import { toast } from "sonner";

const onImportFiles = vi.fn();
const mockParse = vi.mocked(parseCharacterFile);
const mockToastError = vi.mocked(toast.error);

const PNG_FILE = new File(["x"], "card.png", { type: "image/png" });
const MOCK_AVATAR_URL = "blob:mock-avatar-url";

function mockPreview(avatarUrl: string | null) {
  return {
    file: PNG_FILE,
    name: "Test Character",
    description: "desc",
    tags: ["tag1"],
    avatarUrl,
  };
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

function renderOrchestrator(isImporting = false) {
  const ref = createRef<CharacterImportMobileHandle>();
  const utils = render(
    <CharacterImportMobile ref={ref} isImporting={isImporting} onImportFiles={onImportFiles} />,
  );
  return { ...utils, ref };
}

beforeEach(() => {
  onImportFiles.mockClear();
  mockParse.mockReset();
  mockToastError.mockClear();
});

describe("CharacterImportMobile", () => {
  it("renders a hidden file input with the character accept and no preview modal at rest", () => {
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.className).toBe("hidden");
    expect(input.accept).toBe(".png,.json,image/png,application/json");
    expect(document.body.textContent).not.toContain("character_import_title");
    cleanup();
  });

  it("openPicker triggers the native picker via input.click() click-through", () => {
    const { container, ref } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    ref.current?.openPicker();
    expect(clickSpy).toHaveBeenCalledOnce();
    cleanup();
  });

  it("mounts the preview modal with title, subtitle, and confirm label after a successful parse", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    expect(document.body.textContent).toContain("character_import_sub");
    expect(document.body.textContent).toContain("add_to_library");
    cleanup();
  });

  it("confirm calls onImportFiles([file]) and closes the modal", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("add_to_library");
    });
    fireEvent.click(getByText("add_to_library"));
    expect(onImportFiles).toHaveBeenCalledOnce();
    expect(onImportFiles).toHaveBeenCalledWith([PNG_FILE]);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("character_import_title");
    });
    cleanup();
  });

  it("cancel clears the modal without calling onImportFiles", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    fireEvent.click(getByText("cancel"));
    expect(onImportFiles).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("character_import_title");
    });
    cleanup();
  });

  it("toasts err.message and opens no modal when parsing throws", async () => {
    mockParse.mockRejectedValue(new Error("boom"));
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
    expect(document.body.textContent).not.toContain("character_import_title");
    cleanup();
  });

  it("does not open a modal when the native picker is dismissed without a selection", () => {
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, []);
    fireEvent.change(input);
    expect(mockParse).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("character_import_title");
    cleanup();
  });

  it("revokes the avatar object URL when the modal is closed", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    fireEvent.click(getByText("cancel"));
    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    });
    revokeSpy.mockRestore();
    cleanup();
  });

  it("revokes the avatar object URL when the user confirms", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    fireEvent.click(getByText("add_to_library"));
    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    });
    revokeSpy.mockRestore();
    cleanup();
  });

  it("revokes the avatar object URL on unmount", async () => {
    mockParse.mockResolvedValue(mockPreview(MOCK_AVATAR_URL));
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { container, unmount } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [PNG_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("character_import_title");
    });
    unmount();
    expect(revokeSpy).toHaveBeenCalledWith(MOCK_AVATAR_URL);
    revokeSpy.mockRestore();
  });
});
