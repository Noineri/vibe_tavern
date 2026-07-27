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
 *   • dismissing the native picker opens no modal;
 *   • overlapping selections commit only the newest parse result.
 *
 * `parseChatFile` is mocked per-test with real exports spread so `truncate`
 * stays intact for `<ChatImportPreview>`. `useT` and `sonner`'s
 * `toast` are mocked the same way as the character test.
 *
 * Runner: bun:test with scoped happy-dom cleanup.
 */
import { describe, it, expect, mock, spyOn, beforeAll, beforeEach } from "bun:test";
import { createRef } from "react";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { mocked } from "../../../../test/mock-utils.js";
import type { ChatImportMobileHandle } from "./ChatImportMobile.js";
import type { ChatPreview } from "./parse-import-file.js";

useDomEnv();

const toastError = mock();
const toastSuccess = mock();
const toastWarning = mock();
const toastInfo = mock();
const realI18nContext = await import("../../../i18n/context.js");
const realSonner = await import("sonner");
const realParseImportFile = await import("./parse-import-file.js");
const parseChatFile = mock(realParseImportFile.parseChatFile);

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
	parseChatFile,
}));

let ChatImportMobile: typeof import("./ChatImportMobile.js").ChatImportMobile;
beforeAll(async () => {
	({ ChatImportMobile } = await import("./ChatImportMobile.js"));
});
const onImportFiles = mock();
const mockParse = mocked(parseChatFile);
const mockToastError = mocked(toastError);

const JSONL_FILE = new File(["x"], "chat.jsonl", { type: "application/jsonl" });

function chatPreviewFor(file: File, fileName: string): ChatPreview {
  return {
    file,
    fileName,
    title: "chat",
    messageCount: 1,
    characterName: "Alice",
    messages: [{ role: "user", name: "User", text: "hi" }],
  };
}

function mockChatPreview(): ChatPreview {
  return {
    ...chatPreviewFor(JSONL_FILE, "chat.jsonl"),
    messageCount: 2,
    messages: [
      { role: "user", name: "User", text: "hi" },
      { role: "assistant", name: "Alice", text: "hello" },
    ],
  };
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
  });

  it("openPicker triggers the native picker via input.click() click-through", () => {
    const { container, ref } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
	const clickSpy = spyOn(input, "click");
    ref.current?.openPicker();
		expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("mounts the preview modal with title, subtitle, and confirm label after a successful parse", async () => {
    mockParse.mockResolvedValue(mockChatPreview());
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    pickFile(input, JSONL_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("chat_import_title");
    });
    expect(document.body.textContent).toContain("chat_import_sub");
    expect(document.body.textContent).toContain("confirm_import");
  });

  it("confirm calls onImportFiles([file]) and closes the modal", async () => {
    mockParse.mockResolvedValue(mockChatPreview());
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    pickFile(input, JSONL_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("confirm_import");
    });
    fireEvent.click(getByText("confirm_import"));
		expect(onImportFiles).toHaveBeenCalledTimes(1);
    expect(onImportFiles).toHaveBeenCalledWith([JSONL_FILE]);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("chat_import_title");
    });
  });

  it("cancel clears the modal without calling onImportFiles", async () => {
    mockParse.mockResolvedValue(mockChatPreview());
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    pickFile(input, JSONL_FILE);
    await waitFor(() => {
      expect(document.body.textContent).toContain("chat_import_title");
    });
    fireEvent.click(getByText("cancel"));
    expect(onImportFiles).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("chat_import_title");
    });
  });

  it("toasts err.message and opens no modal when parsing throws", async () => {
    mockParse.mockRejectedValue(new Error("boom"));
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    pickFile(input, JSONL_FILE);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
    expect(document.body.textContent).not.toContain("chat_import_title");
  });

  it("does not open a modal when the native picker is dismissed without a selection", () => {
    const { container } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    setFiles(input, []);
    fireEvent.change(input);
    expect(mockParse).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("chat_import_title");
  });

  it("commits only the newest selection when two parses overlap", async () => {
    const fileA = new File(["a"], "a.jsonl", { type: "application/jsonl" });
    const fileB = new File(["b"], "b.jsonl", { type: "application/jsonl" });
    const parseA = deferred<ChatPreview>();
    const parseB = deferred<ChatPreview>();
    mockParse.mockImplementation((file) => (file === fileA ? parseA.promise : parseB.promise));
    const { container, getByText } = renderOrchestrator();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    pickFile(input, fileA);
    pickFile(input, fileB);
    await act(async () => parseB.resolve(chatPreviewFor(fileB, "b.jsonl")));
    expect(document.body.textContent).toContain("b.jsonl");
    // The first selection resolves last — its result must be ignored.
    await act(async () => parseA.resolve(chatPreviewFor(fileA, "a.jsonl")));
    expect(document.body.textContent).toContain("b.jsonl");
    expect(document.body.textContent).not.toContain("a.jsonl");
    fireEvent.click(getByText("confirm_import"));
		expect(onImportFiles).toHaveBeenCalledTimes(1);
    expect(onImportFiles).toHaveBeenCalledWith([fileB]);
  });
});
