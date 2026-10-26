import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { useState, type ReactElement } from "react";
import { brandId, type Attachment, type MessageId, type ChatId, type ChatBranchId } from "@vibe-tavern/domain";
import type { AppMessage } from "../../api/types.js";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });
const { render, fireEvent, waitFor, act, cleanup } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const en = (await import("../../i18n/locales/en.json")).default;
const { LocaleProvider } = await import("../../i18n/context.js");
const { initI18n } = await import("../../i18n/i18n.js");
// Real i18n (the AgentPermissionCard precedent): every pin in this suite
// asserts real EN text, so it rides the real i18next behind a real
// LocaleProvider — no stub `t` to poison real-i18next siblings in a
// hand-bundled run (the old inline mock was a full en.json lookup, the
// family's worst offender: 26 cross-suite failures in the AgentMessageList
// pair probe, 2026-10-27).
initI18n("en");

/** Renders inside the real LocaleProvider — see the initI18n note above. */
function renderWithLocale(ui: ReactElement) {
  return render(<LocaleProvider>{ui}</LocaleProvider>);
}

const api = await import("../../api/attachment-actions-api.js");
const chatApi = await import("../../api/chat-api.js");
const mobile = await import("../../hooks/use-mobile.js");
const { toast } = await import("sonner");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const { AttachmentGrid } = await import("./AttachmentGrid.js");
const { SentFileAttachment } = await import("./sent-file-attachment.js");

// T2 API-boundary spies only; real dropdown/sheet/modal, action machine,
// snapshot writes and re-renders. No global i18n init, network, sleeps or DB.
const snapshot = useSnapshotStore.getState();
const spies: Array<{ mockRestore(): void }> = [];
function restore() {
  cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
  useSnapshotStore.setState(snapshot, true);
}
beforeEach(() => {
  restore();
  spies.push(spyOn(mobile, "useIsMobile").mockReturnValue(false));
});
afterEach(restore);
afterAll(restore);

const file: Attachment = { id: "file", assetId: "asset-file", name: "notes.md", type: "file", mimeType: "text/markdown", sizeBytes: 100, tokenCount: 12400 };
const summary: Attachment = { ...file, description: "Gate opens at 7.\nBring a key.", summaryTokenCount: 800 };
const image: Attachment = { id: "image", assetId: "asset-image", name: "a.png", type: "image", mimeType: "image/png", sizeBytes: 12 };

function seed(attachments: Attachment[]) {
  useSnapshotStore.getState().ingestSnapshot({ messages: [{
    id: brandId<MessageId>("message"), chatId: brandId<ChatId>("chat"), branchId: brandId<ChatBranchId>("branch"), role: "user", authorType: "user", position: 0,
    content: "Read this", state: "complete", createdAt: "0", updatedAt: "0", variants: [],
    selectedVariantIndex: null, modelId: null, sceneTracker: null, coauthorModuleId: null, coauthorSkillId: null, attachments,
  } satisfies AppMessage] });
}
function StoreGrid() {
  const attachments = useSnapshotStore((state) => state.messagesById.message?.attachments);
  return <AttachmentGrid attachments={attachments} messageId="message" />;
}
function grid(attachment = file, siblings: Attachment[] = []) {
  seed([attachment, ...siblings]);
  return renderWithLocale(<StoreGrid />);
}
type View = ReturnType<typeof render>;
async function openMenu(view: View) {
  // Real pointer/focus sequencing lets Radix finish close-auto-focus before
  // another open; a bare synthetic keydown can race the prior FocusScope.
  await userEvent.setup().click(view.getByRole("button", { name: en.attachment_file_actions }));
  await waitFor(() => expect(view.queryByRole("menu")).not.toBeNull());
}
async function choose(view: View, label: string) {
  await openMenu(view);
  await userEvent.setup().click(view.getByRole("menuitem", { name: label }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("sent file actions (CA-2c)", () => {
  for (const [label, attachment, expected] of [
    ["plain", file, [en.attachment_summarize, en.attachment_exclude, en.attachment_delete_title]],
    ["summarized", summary, [en.attachment_restore_full_text, en.attachment_show_summary, en.attachment_exclude, en.attachment_delete_title]],
    ["excluded", { ...file, includeInPrompt: false }, [en.attachment_summarize, en.attachment_include, en.attachment_delete_title]],
  ] as const) {
    test(`${label}: desktop menu has exactly the prescribed items in order`, async () => {
      const view = grid(attachment);
      await openMenu(view);
      expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([...expected]);
      const remove = view.getByRole("menuitem", { name: en.attachment_delete_title });
      expect(remove.className).toContain("text-danger-text");
      expect(remove.previousElementSibling?.getAttribute("role")).toBe("separator");
    });
  }

  test("summarize calls the RP client with an AbortSignal and the canonical chip shows the returned count", async () => {
    const call = spyOn(api, "summarizeAttachment").mockResolvedValue(summary);
    spies.push(call);
    const view = grid(file, [image]);
    await choose(view, en.attachment_summarize);
    await waitFor(() => expect(view.queryByText("Summary · ~800 tok")).not.toBeNull());
    expect(call).toHaveBeenCalledWith("_", "message", file.id, expect.any(AbortSignal));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([summary, image]);
  });

  test("the surface-independent seam returns the authoritative Attachment through onUpdated", async () => {
    const onUpdated = mock((_attachment: Attachment) => {});
    const actions = { summarize: mock(async (_signal: AbortSignal) => summary), clearSummary: async () => file, setIncluded: async () => {}, remove: async () => {} };
    function Harness() {
      const [attachment, setAttachment] = useState(file);
      return <SentFileAttachment attachment={attachment} actions={actions} onUpdated={(updated) => { onUpdated(updated); setAttachment(updated); }} onRemoved={() => {}} />;
    }
    const view = renderWithLocale(<Harness />);
    await choose(view, en.attachment_summarize);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(summary));
    expect(view.getByText("Summary · ~800 tok")).toBeTruthy();
  });

  test("cancel aborts the request, restores the old state and ignores a late success", async () => {
    const pending = deferred<Attachment>();
    const call = spyOn(api, "summarizeAttachment").mockImplementation(() => pending.promise);
    spies.push(call);
    const view = grid();
    await choose(view, en.attachment_summarize);
    await waitFor(() => expect(view.queryByRole("status")).not.toBeNull());
    expect(view.getByText(en.attachment_summarizing)).toBeTruthy();
    expect(view.getByRole("button", { name: en.attachment_file_actions }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("status").querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: en.cancel }));
    expect(call.mock.calls[0]![3].aborted).toBe(true);
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByTitle(file.name).nextElementSibling?.textContent).toBe(en.attachment_tokens.replace("{tokens}", file.tokenCount!.toLocaleString()));
    await act(async () => pending.resolve(summary));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([file]);
  });

  test("restore full text uses the returned cleared attachment", async () => {
    const cleared = { ...file, description: null };
    const call = spyOn(api, "clearAttachmentSummary").mockResolvedValue(cleared);
    spies.push(call);
    const view = grid(summary);
    await choose(view, en.attachment_restore_full_text);
    await waitFor(() => expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([cleared]));
    expect(call).toHaveBeenCalledWith("_", "message", file.id);
    expect(view.queryByText("Summary · ~800 tok")).toBeNull();
  });

  test("non-summary work also disables the menu until the action settles", async () => {
    const pending = deferred<Attachment>();
    const call = spyOn(api, "clearAttachmentSummary").mockImplementation(() => pending.promise);
    spies.push(call);
    const view = grid(summary);
    await choose(view, en.attachment_restore_full_text);
    expect(view.getByRole("button", { name: en.attachment_file_actions }).hasAttribute("disabled")).toBe(true);
    expect(view.queryByRole("menu")).toBeNull();
    await act(async () => pending.resolve({ ...file, description: null }));
    expect(view.getByRole("button", { name: en.attachment_file_actions }).hasAttribute("disabled")).toBe(false);
  });

  test("a cancelled request cannot clear the busy state or overwrite a subsequent summary", async () => {
    const first = deferred<Attachment>();
    const second = deferred<Attachment>();
    const call = spyOn(api, "summarizeAttachment").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    spies.push(call);
    const view = grid();
    await choose(view, en.attachment_summarize);
    fireEvent.click(view.getByRole("button", { name: en.cancel }));
    await choose(view, en.attachment_summarize);
    await act(async () => first.resolve({ ...summary, description: "Cancelled old summary" }));
    expect(view.getByRole("status")).toBeTruthy();
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([file]);
    await act(async () => second.resolve(summary));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([summary]);
  });

  test("show summary opens a read-only modal named after the file and preserves newlines", async () => {
    const view = grid(summary);
    await choose(view, en.attachment_show_summary);
    const dialog = await waitFor(() => view.getByRole("dialog", { name: file.name }));
    expect(dialog.textContent).toContain(summary.description!);
    expect(dialog.querySelector(".whitespace-pre-wrap")?.textContent).toBe(summary.description!);
    expect(dialog.querySelector("textarea,input")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: en.close }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("exclude then include reuse the existing client and exclusion takes precedence over the summary", async () => {
    const call = spyOn(chatApi, "updateAttachmentIncludeInPrompt").mockResolvedValue({ ok: true });
    spies.push(call);
    const view = grid(summary);
    await choose(view, en.attachment_exclude);
    await waitFor(() => expect(view.queryByText(en.attachment_excluded)).not.toBeNull());
    expect(view.getByTitle(file.name).className).toContain("line-through");
    expect(view.queryByText("Summary · ~800 tok")).toBeNull();
    await choose(view, en.attachment_include);
    await waitFor(() => expect(view.queryByText("Summary · ~800 tok")).not.toBeNull());
    expect(call.mock.calls).toEqual([["_", "message", file.id, false], ["_", "message", file.id, true]]);
  });

  test("delete opens the shared confirm, removes only after success and keeps siblings", async () => {
    const call = spyOn(chatApi, "deleteAttachment").mockResolvedValue({ ok: true });
    const success = spyOn(toast, "success").mockImplementation(() => "toast");
    spies.push(call, success);
    const view = grid(file, [image]);
    await choose(view, en.attachment_delete_title);
    expect(call).not.toHaveBeenCalled();
    expect(await waitFor(() => view.getByText(en.attachment_delete_msg))).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: en.delete }));
    await waitFor(() => expect(view.queryByTestId("file-attachment-chip")).toBeNull());
    expect(call).toHaveBeenCalledWith("_", "message", file.id);
    expect(success).toHaveBeenCalledWith(en.attachment_deleted);
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([image]);
  });

  test("delete passes the attachment id through onRemoved", async () => {
    const onRemoved = mock((_id: string) => {});
    const remove = mock(async () => {});
    const view = renderWithLocale(<SentFileAttachment attachment={file} actions={{ summarize: async () => summary, clearSummary: async () => file, setIncluded: async () => {}, remove }} onUpdated={() => {}} onRemoved={onRemoved} />);
    await choose(view, en.attachment_delete_title);
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: en.delete })));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(file.id));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("server error toasts the message and preserves the previous state", async () => {
    const call = spyOn(api, "summarizeAttachment").mockRejectedValue(new Error("Provider context length exceeded"));
    const error = spyOn(toast, "error").mockImplementation(() => "toast");
    spies.push(call, error);
    const view = grid();
    await choose(view, en.attachment_summarize);
    await waitFor(() => expect(error).toHaveBeenCalledWith("Provider context length exceeded"));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([file]);
    expect(view.getByRole("button", { name: en.attachment_file_actions }).hasAttribute("disabled")).toBe(false);
  });

  test("delete failure uses the image-path failure toast and retains the file", async () => {
    const call = spyOn(chatApi, "deleteAttachment").mockRejectedValue(new Error("No disk access"));
    const error = spyOn(toast, "error").mockImplementation(() => "toast");
    spies.push(call, error);
    const view = grid();
    await choose(view, en.attachment_delete_title);
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: en.delete })));
    await waitFor(() => expect(error).toHaveBeenCalledWith(en.attachment_delete_failed));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([file]);
  });

  test("mobile whole-chip trigger opens the standard sheet with the same items and destructive separator", async () => {
    spies.push(spyOn(mobile, "useIsMobile").mockReturnValue(true));
    const view = grid(summary);
    fireEvent.click(view.getByRole("button", { name: en.attachment_file_actions }));
    const dialog = await waitFor(() => view.getByRole("dialog"));
    const labels = [...dialog.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toEqual([en.attachment_restore_full_text, en.attachment_show_summary, en.attachment_exclude, en.attachment_delete_title, en.cancel]);
    expect(view.queryByRole("menu")).toBeNull();
    expect(view.getByRole("button", { name: en.attachment_delete_title }).previousElementSibling?.getAttribute("role")).toBe("separator");
  });

  test("fresh canonical sibling edits survive a pending summary; a refetched DTO restores the state", async () => {
    const pending = deferred<Attachment>();
    spies.push(spyOn(api, "summarizeAttachment").mockImplementation(() => pending.promise));
    const view = grid(file, [image]);
    await choose(view, en.attachment_summarize);
    await waitFor(() => expect(view.queryByRole("status")).not.toBeNull());
    const changedImage = { ...image, description: "Edited during generation" };
    act(() => useSnapshotStore.getState().updateMessage("message", { attachments: [file, changedImage] }));
    await act(async () => pending.resolve(summary));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([summary, changedImage]);
    view.unmount();
    seed([{ ...summary, includeInPrompt: false }, changedImage]);
    const refreshed = renderWithLocale(<StoreGrid />);
    expect(refreshed.getByText(en.attachment_excluded)).toBeTruthy();
    await openMenu(refreshed);
    expect(refreshed.getByRole("menuitem", { name: en.attachment_show_summary })).toBeTruthy();
  });

  test("images still open the original lightbox and read-only files have no actions", () => {
    const view = renderWithLocale(<AttachmentGrid attachments={[file, image]} />);
    expect(view.queryByRole("button", { name: en.attachment_file_actions })).toBeNull();
    fireEvent.click(view.getByAltText(image.name));
    expect(view.getAllByAltText(image.name)).toHaveLength(2);
  });

  test("unmount aborts an in-flight summary and suppresses its late update", async () => {
    const pending = deferred<Attachment>();
    const call = spyOn(api, "summarizeAttachment").mockImplementation(() => pending.promise);
    spies.push(call);
    const view = grid();
    await choose(view, en.attachment_summarize);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(call.mock.calls[0]![3].aborted).toBe(true);
    await act(async () => pending.resolve(summary));
    expect(useSnapshotStore.getState().messagesById.message?.attachments).toEqual([file]);
  });

  test("real action clients send POSTs with the summary signal and return the updated attachment", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }));
    spies.push(fetch);
    const controller = new AbortController();
    expect(await api.summarizeAttachment("_", "message", file.id, controller.signal)).toEqual(summary);
    expect(await api.clearAttachmentSummary("_", "message", file.id)).toEqual(summary);
    expect(String(fetch.mock.calls[0]![0])).toContain(`/api/chats/_/messages/message/attachments/${file.id}/summarize`);
    expect(fetch.mock.calls[0]![1]).toEqual({ method: "POST", signal: controller.signal });
    expect(String(fetch.mock.calls[1]![0])).toContain(`/api/chats/_/messages/message/attachments/${file.id}/clear-summary`);
    expect(fetch.mock.calls[1]![1]?.method).toBe("POST");
  });

  test("real action clients throw the nested or string server message, never an object string", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { kind: "NotFound", message: "File is gone" } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Cannot clear" }), { status: 400 }));
    spies.push(fetch);
    await expect(api.summarizeAttachment("_", "message", file.id, new AbortController().signal)).rejects.toThrow("File is gone");
    await expect(api.clearAttachmentSummary("_", "message", file.id)).rejects.toThrow("Cannot clear");
  });

  test("include-client nested errors retain the server message (characterized before fixing)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { kind: "NotFound", message: "Attachment not found" } }), { status: 404 }));
    spies.push(fetch);
    await expect(chatApi.updateAttachmentIncludeInPrompt("_", "message", file.id, false)).rejects.toThrow("Attachment not found");
  });
});
