/**
 * Behavior pin for `<ChatImportMobile>` (plan unit IF-5).
 *
 * Mirrors the `<CharacterImportMobile>` test minus avatar URL revocation
 * (chat previews carry no object URLs). Locks the IF-6 contract:
 *   • renders the hidden input with the `.jsonl` accept and no modal at rest;
 *   • `openPicker()` triggers the native picker via `input.click()`;
 *   • a successful parse mounts the preview modal with the right title /
 *     subtitle / confirm label;
 *   • confirm calls `onImportFiles([file])` and clears the modal;
 *   • cancel clears the modal without invoking `onImportFiles`;
 *   • a parse failure toasts `err.message` and opens no modal;
 *   • dismissing the native picker opens no modal.
 *
 * `parseChatFile` is mocked per-test (via `vi.importActual` spread so
 * `truncate` stays intact for `<ChatImportPreview>`). `useT` and `sonner`'s
 * `toast` are mocked the same way as the character test.
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
  return { ...actual, parseChatFile: vi.fn() };
});

import { ChatImportMobile, type ChatImportMobileHandle } from "./ChatImportMobile.js";
import { parseChatFile } from "./parse-import-file.js";
import { toast } from "sonner";

const onImportFiles = vi.fn();
const mockParse = vi.mocked(parseChatFile);
const mockToastError = vi.mocked(toast.error);

const JSONL_FILE = new File(["x"], "chat.jsonl", { type: "application/jsonl" });

function mockChatPreview() {
  return {
    file: JSONL_FILE,
    fileName: "chat.jsonl",
    title: "chat",
    messageCount: 2,
    characterName: "Alice",
    messages: [
      { role: "user", name: "User", text: "hi" },
      { role: "assistant", name: "Alice", text: "hello" },
    ],
  };
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

function renderOrchestrator(isImporting = false) {
  const ref = createRef<ChatImportMobileHandle>();
  const utils = render(
    <ChatImportMobile ref={ref} isImporting={isImporting} onImportFiles={onImportFiles} />,
  );
  return { ...utils, ref };
}

beforeEach(() => {
  onImportFiles.mockClear();
  mockParse.mockReset();
  mockToastError.mockClear();
});

describe("ChatImportMobile", () => {
  it("renders a hidden file input with the .jsonl accept and no preview modal at rest", () => {
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.className).toBe("hidden");
    expect(input.accept).toBe(".jsonl");
    expect(document.body.textContent).not.toContain("chat_import_title");
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
    mockParse.mockResolvedValue(mockChatPreview());
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [JSONL_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("chat_import_title");
    });
    expect(document.body.textContent).toContain("chat_import_sub");
    expect(document.body.textContent).toContain("confirm_import");
    cleanup();
  });

  it("confirm calls onImportFiles([file]) and closes the modal", async () => {
    mockParse.mockResolvedValue(mockChatPreview());
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [JSONL_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("confirm_import");
    });
    fireEvent.click(getByText("confirm_import"));
    expect(onImportFiles).toHaveBeenCalledOnce();
    expect(onImportFiles).toHaveBeenCalledWith([JSONL_FILE]);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("chat_import_title");
    });
    cleanup();
  });

  it("cancel clears the modal without calling onImportFiles", async () => {
    mockParse.mockResolvedValue(mockChatPreview());
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [JSONL_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(document.body.textContent).toContain("chat_import_title");
    });
    fireEvent.click(getByText("cancel"));
    expect(onImportFiles).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("chat_import_title");
    });
    cleanup();
  });

  it("toasts err.message and opens no modal when parsing throws", async () => {
    mockParse.mockRejectedValue(new Error("boom"));
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, [JSONL_FILE]);
    fireEvent.change(input);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
    expect(document.body.textContent).not.toContain("chat_import_title");
    cleanup();
  });

  it("does not open a modal when the native picker is dismissed without a selection", () => {
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, []);
    fireEvent.change(input);
    expect(mockParse).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("chat_import_title");
    cleanup();
  });
});
