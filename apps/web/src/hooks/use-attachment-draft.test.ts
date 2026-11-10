import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BaseSyntheticEvent, ChangeEvent, ClipboardEvent, DragEvent } from "react";
import type { Attachment } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { useDomEnv } from "../../test/dom-env.js";
import { inertView } from "../../test/react-event-seam.js";
import { useAttachmentDraft, VALID_AUDIO_TYPES } from "./use-attachment-draft.js";
import type { AttachmentDraftOptions, DraftAttachmentKind } from "./use-attachment-draft.js";

useDomEnv({ failOnNetwork: true });
const { act, renderHook, waitFor } = await import("@testing-library/react");

// T2: only the upload network boundary is injected. No module mocks, real
// i18n initialization, global fetch/env mutations, timers or scratch files.
let errors = spyOn(toast, "error").mockImplementation(() => "toast");
beforeEach(() => {
  errors.mockRestore();
  errors = spyOn(toast, "error").mockImplementation(() => "toast");
});
afterAll(() => errors.mockRestore());

function image(name = "photo.png") {
  return new File(["pixels"], name, { type: "image/png" });
}

// ── Member-for-member React synthetic doubles (step 8b) ────────────────────
// The hook handlers are invoked directly (renderHook — no element to dispatch
// through), so each factory builds the FULL required member set of its React
// synthetic event with inert propagation defaults; the compiler checks the
// member set at the definition sites. DOM-typed surfaces are real happy-dom
// objects where one exists (the file <input> element) or member-for-member
// doubles over the DataTransfer/FileList interfaces (happy-dom's DataTransfer
// derives `types` from item MIMEs — a real browser carries the "Files" type
// this hook pins, so `types` must be fabricable).

function fileListDouble(files: File[]): FileList {
  return Object.assign([...files], { item: (index: number) => files[index] ?? null });
}

function dataTransferItemDouble(file: File | null, kind: string, type: string): DataTransferItem {
  return { kind, type, getAsFile: () => file, getAsString: (_callback) => {}, webkitGetAsEntry: () => null };
}

function dataTransferDouble(items: DataTransferItem[], types: string[], files: File[]): DataTransfer {
  const list = Object.assign(items, {
    add: () => null,
    clear() {},
    item: (index: number) => items[index] ?? null,
    remove() {},
  });
  return {
    dropEffect: "none",
    effectAllowed: "none",
    files: fileListDouble(files),
    items: list,
    types,
    clearData() {},
    getData: () => "",
    setData() {},
    setDragImage() {},
  };
}

/** The BaseSyntheticEvent core every React synthetic carries — shared by the
 *  factories below (currentTarget: EventTarget & Element matches the
 *  SyntheticEvent<T = Element> default; each factory adds its type's own
 *  members). */
type SyntheticEventCore = Omit<BaseSyntheticEvent<Event, EventTarget & Element, EventTarget>, "target">;
function syntheticBase(type: string): SyntheticEventCore {
  return {
    nativeEvent: new Event(type),
    currentTarget: document.createElement("div"),
    bubbles: false,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: 0,
    isTrusted: false,
    preventDefault() {},
    isDefaultPrevented: () => false,
    stopPropagation() {},
    isPropagationStopped: () => false,
    persist() {},
    timeStamp: 0,
    type,
  };
}

/** Drop/drag event over the given transfer surface — `types: ["Files"]` drives
 *  the drag flag, `files` the drop. The NATIVE drag event is a member-for-member
 *  inert double over a real Event base (happy-dom ships no DragEvent
 *  constructor) — the hook reads only the SYNTHETIC's dataTransfer, never the
 *  native one. */
function dragEvent(types: string[], files: File[]): DragEvent {
  return {
    ...syntheticBase("drop"),
    nativeEvent: Object.assign(new Event("drop"), {
      altKey: false,
      button: 0,
      buttons: 0,
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
      getModifierState: () => false,
      metaKey: false,
      movementX: 0,
      movementY: 0,
      pageX: 0,
      pageY: 0,
      relatedTarget: null,
      screenX: 0,
      screenY: 0,
      shiftKey: false,
      layerX: 0,
      layerY: 0,
      offsetX: 0,
      offsetY: 0,
      x: 0,
      y: 0,
      detail: 0,
      view: window,
      which: 0,
      initUIEvent: () => {},
      initMouseEvent: () => {},
      dataTransfer: dataTransferDouble([], [], []),
    }),
    target: document.createElement("div"),
    detail: 0,
    view: inertView(),
    altKey: false,
    button: 0,
    buttons: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    getModifierState: () => false,
    metaKey: false,
    movementX: 0,
    movementY: 0,
    pageX: 0,
    pageY: 0,
    relatedTarget: null,
    screenX: 0,
    screenY: 0,
    shiftKey: false,
    dataTransfer: dataTransferDouble(files.map((file) => dataTransferItemDouble(file, "file", file.type)), types, files),
  };
}

function pasteEvent(files: File[], text = false) {
  const preventDefault = mock();
  const items = [
    ...files.map((file) => dataTransferItemDouble(file, "file", file.type)),
    ...(text ? [dataTransferItemDouble(null, "string", "text/plain")] : []),
  ];
  const event: ClipboardEvent<HTMLTextAreaElement> = {
    ...syntheticBase("paste"),
    // The tracked mock IS the event's preventDefault — the hook's
    // "captured only when files were accepted" pin asserts on it.
    preventDefault,
    // happy-dom's ClipboardEvent constructor exists; its native type only adds
    // `clipboardData` to Event — an inert transfer surface matches it.
    nativeEvent: Object.assign(new Event("paste"), {
      clipboardData: dataTransferDouble([], [], []),
    }),
    // The synthetic's ClipboardEvent<T> carries target/currentTarget typed
    // EventTarget & T — the textarea the paste lands in.
    currentTarget: document.createElement("textarea"),
    target: document.createElement("textarea"),
    clipboardData: dataTransferDouble(items, [], []),
  };
  return { preventDefault, event };
}

/** A real file <input> carrying the given selection — the surface
 *  onFileInputChange reads (currentTarget.files, currentTarget.value).
 *  happy-dom refuses `value = "selected"` on a file input, so the seeded
 *  selection string is an own-instance property shadowing the accessor; the
 *  hook's `value = ""` clear still lands on it. */
function fileInputEvent(files: File[]): ChangeEvent<HTMLInputElement> {
  const target = document.createElement("input");
  target.type = "file";
  Object.defineProperty(target, "files", { value: fileListDouble(files), configurable: true });
  Object.defineProperty(target, "value", { value: "selected", writable: true, configurable: true });
  return {
    ...syntheticBase("change"),
    // The hook reads BOTH currentTarget.files and currentTarget.value — the
    // input element must carry the synthetic's currentTarget too.
    currentTarget: target,
    target,
  };
}

function seed(id: number): Attachment {
  return { id: `seed_${id}`, assetId: `asset_${id}`, type: "image", name: "photo.png", mimeType: "image/png", sizeBytes: 6 };
}

function setup({ count = 0, allowedKinds = ["image", "audio", "file"], upload, storeBacked = true }: {
  count?: number;
  allowedKinds?: DraftAttachmentKind[];
  upload?: Parameters<typeof useAttachmentDraft>[1];
  storeBacked?: boolean;
} = {}) {
  let attachments = Array.from({ length: count }, (_, index) => seed(index));
  const uploadMock = mock(upload ?? (async (file: File) => ({ assetId: `asset_${file.name}`, url: "/asset", tokenCount: 42 })));
  const add = mock((attachment: Attachment) => { attachments = [...attachments, attachment]; });
  const remove = mock((id: string) => { attachments = attachments.filter((attachment) => attachment.id !== id); });
  const options: AttachmentDraftOptions = {
    attachments, add, remove, allowedKinds,
    ...(storeBacked ? { getAttachments: () => attachments } : {}),
  };
  const hook = renderHook(() => useAttachmentDraft(options, uploadMock));
  return { ...hook, upload: uploadMock, add, remove, attachments: () => attachments, options };
}

describe("shared composer attachment draft (CA-1d)", () => {
  test("empty-MIME markdown carries the canonical type and server token count", async () => {
    const env = setup();
    const file = new File(["# Notes"], "notes.md");
    await env.result.current.addFiles([file]);
    expect(env.upload).toHaveBeenCalledWith(file);
    expect(env.attachments()[0]).toMatchObject({ type: "file", name: "notes.md", mimeType: "text/markdown", tokenCount: 42, sizeBytes: file.size });
    expect(env.attachments()[0]?.id).toBeTruthy();
    expect(env.attachments()[0]?.purpose).toBeUndefined();
  });

  test("OS Excel CSV becomes text/csv", async () => {
    const env = setup();
    await env.result.current.addFiles([new File(["a,b"], "a.csv", { type: "application/vnd.ms-excel" })]);
    expect(env.attachments()[0]).toMatchObject({ type: "file", mimeType: "text/csv" });
  });

  test("unknown types and unsupported media are refused without uploading", async () => {
    const env = setup();
    await env.result.current.addFiles([
      new File(["binary"], "a.exe", { type: "application/x-msdownload" }),
      new File(["svg"], "a.txt", { type: "image/svg+xml" }),
      new File(["video"], "a.mp4", { type: "video/mp4" }),
    ]);
    expect(env.upload).not.toHaveBeenCalled();
    expect(errors.mock.calls.map(([message]) => message)).toEqual(Array(3).fill("unsupported_attachment_format"));
  });

  test("over 20 MB is refused; exactly 20 MB is accepted", async () => {
    const env = setup();
    await env.result.current.addFiles([
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.txt"),
      new File([new Uint8Array(20 * 1024 * 1024)], "boundary.txt"),
    ]);
    expect(errors).toHaveBeenCalledWith("file_too_large");
    expect(env.upload).toHaveBeenCalledTimes(1);
    expect(env.attachments()[0]?.name).toBe("boundary.txt");
  });

  test("four existing plus a three-file drop uploads one and reports the limit once", async () => {
    const env = setup({ count: 4 });
    act(() => env.result.current.handleDrop(dragEvent([], [image("one.png"), image("two.png"), image("three.png")])));
    await waitFor(() => expect(env.attachments()).toHaveLength(5));
    expect(env.upload).toHaveBeenCalledTimes(1);
    expect(env.attachments().at(-1)?.name).toBe("one.png");
    expect(errors.mock.calls.map(([message]) => message)).toEqual(["max_attachments"]);
  });

  test("six files on an empty draft add five in order, including without a store getter", async () => {
    const env = setup({ storeBacked: false });
    await env.result.current.addFiles(Array.from({ length: 6 }, (_, index) => image(`${index}.png`)));
    expect(env.attachments().map((attachment) => attachment.name)).toEqual(["0.png", "1.png", "2.png", "3.png", "4.png"]);
    expect(env.upload).toHaveBeenCalledTimes(5);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls reserve uploading and queued files before any upload settles", async () => {
    const parked = Promise.withResolvers<{ assetId: string; url: string }>();
    const env = setup({ count: 3, upload: () => parked.promise });
    const first = env.result.current.addFiles([image("one.png"), image("two.png")]);
    const second = env.result.current.addFiles([image("three.png"), image("four.png")]);
    expect(errors).toHaveBeenCalledTimes(1);
    parked.resolve({ assetId: "asset", url: "/asset" });
    await Promise.all([first, second]);
    expect(env.upload).toHaveBeenCalledTimes(2);
    expect(env.attachments()).toHaveLength(5);
    expect(env.attachments().slice(3).map((attachment) => attachment.name)).toEqual(["one.png", "two.png"]);
  });

  test("reads external draft changes at call time, not from the render closure", async () => {
    const env = setup();
    for (let index = 0; index < 5; index++) env.add(seed(index));
    await env.result.current.addFiles([image()]);
    expect(env.upload).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("max_attachments");
  });

  test("ref-backed consumers can remove then reuse capacity without a render", async () => {
    const env = setup({ count: 4, storeBacked: false });
    await env.result.current.addFiles([image("one.png")]);
    env.result.current.remove("seed_0");
    await env.result.current.addFiles([image("two.png")]);
    expect(env.attachments()).toHaveLength(5);
    expect(env.upload).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  test("a failed upload releases its reserved slot and a zero token count survives", async () => {
    let fail = true;
    const env = setup({ count: 4, upload: async () => {
      if (fail) throw new Error("Upload denied");
      return { assetId: "empty", url: "/asset", tokenCount: 0 };
    } });
    await env.result.current.addFiles([image()]);
    fail = false;
    await env.result.current.addFiles([new File([], "empty.txt")]);
    expect(env.attachments()).toHaveLength(5);
    expect(env.attachments().at(-1)?.tokenCount).toBe(0);
    expect(errors.mock.calls.map(([message]) => message)).toEqual(["Upload denied"]);
  });

  test("paste takes both image and text-file items, leaving string items alone", async () => {
    const env = setup();
    const event = pasteEvent([image(), new File(["notes"], "notes.md")], true);
    env.result.current.handlePaste(event.event);
    await waitFor(() => expect(env.attachments()).toHaveLength(2));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(env.attachments().map((attachment) => attachment.type)).toEqual(["image", "file"]);
  });

  test("plain text paste is never captured or uploaded", async () => {
    const env = setup();
    const event = pasteEvent([], true);
    env.result.current.handlePaste(event.event);
    await env.result.current.addFiles([]);
    expect(env.upload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("image/file consumers refuse audio, and do not capture audio-only paste", async () => {
    const env = setup({ allowedKinds: ["image", "file"] });
    const file = new File(["audio"], "note.webm", { type: "audio/webm" });
    const event = pasteEvent([file], true);
    env.result.current.handlePaste(event.event);
    await env.result.current.addFiles([file]);
    expect(env.upload).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("unsupported_attachment_format");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(env.result.current.accept).not.toContain("audio/");
  });

  test("a failed first upload reports its error and still adds the second file", async () => {
    const env = setup({ upload: async (file) => {
      if (file.name === "bad.png") throw new Error("Upload denied");
      return { assetId: "asset_good", url: "/asset" };
    } });
    await env.result.current.addFiles([image("bad.png"), image("good.png")]);
    expect(errors).toHaveBeenCalledWith("Upload denied");
    expect(env.attachments().map((attachment) => attachment.name)).toEqual(["good.png"]);
    expect(env.attachments()[0]?.tokenCount).toBeUndefined();
    await env.result.current.addFiles([image("next.png")]);
    expect(env.attachments()).toHaveLength(2);
  });

  test("multi-select picker takes all files in order and clears the input", async () => {
    const env = setup();
    const event = fileInputEvent([image("one.png"), image("two.png")]);
    env.result.current.onFileInputChange(event);
    expect(event.currentTarget.value).toBe("");
    await env.result.current.addFiles([]);
    expect(env.attachments().map((attachment) => attachment.name)).toEqual(["one.png", "two.png"]);
  });

  test("accept derives all text MIMEs and extensions plus the existing media types", () => {
    const env = setup();
    const accept = env.result.current.accept.split(",");
    for (const value of ["image/png", "image/jpeg", "image/webp", "image/gif", ...VALID_AUDIO_TYPES,
      "text/plain", "text/markdown", "application/json", "application/x-ndjson", "text/x-jsonl", "text/csv",
      ".txt", ".md", ".json", ".jsonl", ".csv"]) expect(accept).toContain(value);
    expect(new Set(accept).size).toBe(accept.length);
  });

  test("all previous image/audio types keep their draft fields and audio voice purpose", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", ...VALID_AUDIO_TYPES]) {
      const env = setup({ upload: async () => ({ assetId: "media", url: "/asset" }) });
      const file = new File(["media"], "media", { type: `${mime};codecs=opus` });
      await env.result.current.handleFileSelected(file);
      expect(env.attachments()[0]).toMatchObject({ assetId: "media", mimeType: mime, type: mime.startsWith("audio/") ? "audio" : "image", name: "media", sizeBytes: 5 });
      expect(env.attachments()[0]?.purpose).toBe(mime.startsWith("audio/") ? "voice" : undefined);
      env.unmount();
    }
  });

  test("drag flag follows file drag, leave and drop; removal delegates to the consumer", async () => {
    const env = setup({ count: 1 });
    const event = dragEvent(["Files"], []);
    act(() => env.result.current.handleDragOver(event));
    expect(env.result.current.isDragOver).toBe(true);
    act(() => env.result.current.handleDragLeave(event));
    expect(env.result.current.isDragOver).toBe(false);
    act(() => env.result.current.handleDragOver(event));
    act(() => env.result.current.handleDrop(event));
    await env.result.current.addFiles([]);
    expect(env.result.current.isDragOver).toBe(false);
    env.result.current.remove("seed_0");
    expect(env.remove).toHaveBeenCalledWith("seed_0");
    expect(env.attachments()).toEqual([]);
  });
});
