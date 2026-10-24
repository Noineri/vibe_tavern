/**
 * AttachmentGrid voice-bubble DOM tests (STT_PLAN ST-6): audio attachments
 * render the playable bubble (not the zoomable image button), the transcript
 * toggles, and music/ambient clips are playback-only (no transcript UI).
 */

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import React from "react";

import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { render, act, fireEvent, waitFor } = await import("@testing-library/react");

const { default: userEvent } = await import("@testing-library/user-event");

// House i18n test pattern: raw keys render as-is.
const realI18n = await import("../../i18n/context.js");
const en = (await import("../../i18n/locales/en.json")).default;
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    // Interpolates single-brace params (the ST-7 tone row passes {tone}) —
    // otherwise the raw-key passthrough loses the split value under test.
    t: (key: string, params?: Record<string, unknown>) =>
      key === "attachment_tokens" ? en.attachment_tokens.replace("{tokens}", String(params?.tokens)) : params && typeof params === "object" && "tone" in params
        ? `${key}:${String(params.tone)}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

import { AttachmentGrid } from "./AttachmentGrid.js";

type GridAttachment = NonNullable<Parameters<typeof AttachmentGrid>[0]["attachments"]>[number];

const chatApi = await import("../../api/chat-api.js");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const actionSpies: Array<{ mockRestore: () => void }> = [];
const restoreActionSpies = () => {
  for (const spy of actionSpies.splice(0)) spy.mockRestore();
};
afterEach(restoreActionSpies);
afterAll(restoreActionSpies);

const textFile: GridAttachment = {
  id: "att-file", assetId: "asset_file", type: "file", name: "notes.md",
  mimeType: "text/markdown", sizeBytes: 1200, tokenCount: 12400,
};
const image: GridAttachment = {
  id: "att-image", assetId: "asset_image", type: "image", name: "a.png", mimeType: "image/png", sizeBytes: 4,
};

function voiceAttachment(overrides: Partial<GridAttachment> = {}) {
  return {
    id: "att-v1",
    assetId: "asset_v1",
    type: "audio" as const,
    purpose: "voice" as const,
    durationMs: 65000,
    name: "voice-message.webm",
    mimeType: "audio/webm",
    sizeBytes: 1200,
    description: "привет, как дела",
    ...overrides,
  };
}

describe("AttachmentGrid voice bubble (ST-6)", () => {
  test("audio attachment renders the voice bubble with a playable <audio> and duration", () => {
    const view = render(<AttachmentGrid attachments={[voiceAttachment()]} />);
    const bubble = view.getByTestId("voice-bubble");
    expect(bubble.dataset.purpose).toBe("voice");
    const audio = bubble.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio?.getAttribute("src")).toContain("/api/assets/asset_v1");
    // 65000ms → "1:05"
    expect(bubble.textContent).toContain("1:05");
    // The zoomable image-button path must NOT wrap audio.
    expect(bubble.tagName).toBe("DIV");
  });

  test("transcript hidden until toggled; shown after click", async () => {
    const user = userEvent.setup();
    const view = render(<AttachmentGrid attachments={[voiceAttachment()]} />);
    expect(view.queryByTestId("voice-transcript-text")).toBeNull();

    await act(async () => {
      await user.click(view.getByTestId("voice-transcript-toggle"));
    });
    expect(view.getByTestId("voice-transcript-text").textContent).toContain("привет, как дела");
    expect(view.getByTestId("voice-transcript-toggle").getAttribute("aria-expanded")).toBe("true");
  });


  test("ST-7: tone line splits out of the transcript and renders as its own row", async () => {
    const user = userEvent.setup();
    const view = render(
      <AttachmentGrid
        attachments={[voiceAttachment({ description: "я не могу больше\n[Voice tone: дрожит, сбивчиво]" })]}
      />,
    );
    await act(async () => {
      await user.click(view.getByTestId("voice-transcript-toggle"));
    });
    // The transcript block is the CLEAN transcript — the marker line is gone.
    expect(view.getByTestId("voice-transcript-text").textContent).toBe("я не могу больше");
    // The tone rides its own row underneath — interpolation mock pins the
    // split value reached the row.
    expect(view.getByTestId("voice-tone-text").textContent).toBe("voice_message_tone:дрожит, сбивчиво");
  });

  test("ST-7: a description without a tone line renders no tone row", async () => {
    const user = userEvent.setup();
    const view = render(<AttachmentGrid attachments={[voiceAttachment()]} />);
    await act(async () => {
      await user.click(view.getByTestId("voice-transcript-toggle"));
    });
    expect(view.getByTestId("voice-transcript-text").textContent).toContain("привет, как дела");
    expect(view.queryByTestId("voice-tone-text")).toBeNull();
  });

  test("music clip is playback-only: audio player, no transcript toggle", () => {
    const view = render(
      <AttachmentGrid
        attachments={[voiceAttachment({ id: "att-m1", purpose: "music", description: null, name: "song.mp3" })]}
      />,
    );
    const bubble = view.getByTestId("voice-bubble");
    expect(bubble.dataset.purpose).toBe("music");
    expect(bubble.querySelector("audio")).toBeTruthy();
    expect(view.queryByTestId("voice-transcript-toggle")).toBeNull();
  });

  test("undescribed voice note (transcription pending/failed) renders playback-only", () => {
    const view = render(
      <AttachmentGrid attachments={[voiceAttachment({ description: null })]} />,
    );
    expect(view.getByTestId("voice-bubble").querySelector("audio")).toBeTruthy();
    expect(view.queryByTestId("voice-transcript-toggle")).toBeNull();
  });

  test("image attachments keep the lightbox path (no voice bubble)", () => {
    const view = render(
      <AttachmentGrid
        attachments={[{ id: "att-i1", assetId: "asset_i1", type: "image", name: "a.png", mimeType: "image/png", sizeBytes: 4 }]}
      />,
    );
    expect(view.queryByTestId("voice-bubble")).toBeNull();
    expect(view.container.querySelector("img")).toBeTruthy();
  });
});

describe("lightbox full-message write characterization (CA-1e)", () => {
  test("description edits preserve the file and audio beside the image", async () => {
    const save = spyOn(chatApi, "updateAttachmentDescription").mockResolvedValue({ ok: true });
    // Instrument the existing action without replacing its implementation.
    const update = spyOn(useSnapshotStore.getState(), "updateMessage");
    actionSpies.push(save, update);
    const attachments = [textFile, image, voiceAttachment()];
    const view = render(<AttachmentGrid attachments={attachments} messageId="message_1" />);
    fireEvent.click(view.getByAltText("a.png"));
    fireEvent.click(view.getByTitle("Add description"));
    fireEvent.change(view.getByPlaceholderText("describe_attachment_placeholder"), { target: { value: "A tower" } });
    fireEvent.click(view.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("message_1", {
      attachments: [textFile, { ...image, description: "A tower" }, attachments[2]],
    }));
    expect(save).toHaveBeenCalledWith("_", "message_1", image.id, "A tower");
  });

  test("deleting an image preserves non-media siblings in the message update", async () => {
    const remove = spyOn(chatApi, "deleteAttachment").mockResolvedValue({ ok: true });
    const update = spyOn(useSnapshotStore.getState(), "updateMessage");
    actionSpies.push(remove, update);
    const audio = voiceAttachment();
    const view = render(<AttachmentGrid attachments={[textFile, image, audio]} messageId="message_1" />);
    fireEvent.click(view.getByAltText("a.png"));
    fireEvent.click(view.getByTitle("delete_attachment_title"));
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: /^delete$/ })));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("_", "message_1", image.id));
    expect(update).toHaveBeenCalledWith("message_1", { attachments: [textFile, audio] });
  });
});

describe("sent file chips and media-only navigation (CA-1e)", () => {
  test("sent markdown is a read-only counted file chip, never an image", () => {
    const view = render(<AttachmentGrid attachments={[textFile]} />);
    const chip = view.getByTestId("file-attachment-chip");
    expect(view.getByTitle(textFile.name).textContent).toBe(textFile.name);
    expect(view.getByTitle(textFile.name).nextElementSibling?.textContent).toBe(en.attachment_tokens.replace("{tokens}", (textFile.tokenCount!).toLocaleString()));
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.querySelector("button")).toBeNull();
  });

  test("a file before one image does not shift the clicked image or create navigation", () => {
    const view = render(<AttachmentGrid attachments={[textFile, image]} />);
    fireEvent.click(view.getByAltText(image.name));
    expect(view.getAllByAltText(image.name)).toHaveLength(2);
    expect(view.queryByTestId("attachment-lightbox-next")).toBeNull();
    expect(view.queryByTestId("attachment-lightbox-prev")).toBeNull();
  });

  test("prev/next skips files and audio and wraps between the media entries", () => {
    const secondImage = { ...image, id: "second", assetId: "asset_second", name: "b.png" };
    const view = render(<AttachmentGrid attachments={[textFile, image, voiceAttachment(), secondImage]} />);
    fireEvent.click(view.getByAltText("b.png"));
    expect(view.getAllByAltText("b.png")).toHaveLength(2);
    fireEvent.click(view.getByTestId("attachment-lightbox-next"));
    expect(view.getAllByAltText("a.png")).toHaveLength(2);
    expect(view.getAllByAltText("b.png")).toHaveLength(1);
    fireEvent.click(view.getByTestId("attachment-lightbox-prev"));
    expect(view.getAllByAltText("b.png")).toHaveLength(2);
  });

  test("regenerating an image description preserves every non-media sibling", async () => {
    const regenerate = spyOn(chatApi, "regenerateAttachmentDescription").mockResolvedValue({ description: "A tower" });
    const update = spyOn(useSnapshotStore.getState(), "updateMessage");
    actionSpies.push(regenerate, update);
    const audio = voiceAttachment();
    const view = render(<AttachmentGrid attachments={[textFile, image, audio]} messageId="message_1" />);
    fireEvent.click(view.getByAltText(image.name));
    fireEvent.click(view.getByTitle("regenerate_description_title"));
    await waitFor(() => expect(update).toHaveBeenCalledWith("message_1", { attachments: [textFile, { ...image, description: "A tower" }, audio] }));
    expect(regenerate).toHaveBeenCalledTimes(1);
  });
});

// ─── CA-4g2: the lightbox action seam ───────────────────────────────────────

describe("lightbox actions seam (CA-4g2)", () => {
  test("with imageActions the three controls call the given actions", async () => {
    const actions = {
      saveDescription: mock(async (_att: GridAttachment, _text: string) => {}),
      regenerateDescription: mock(async (_att: GridAttachment, _signal: AbortSignal) => "Fresh text"),
      remove: mock(async (_att: GridAttachment) => {}),
      applyLocal: mock((_next: GridAttachment[]) => {}),
    };
    const second = { ...image, id: "att-image-2", assetId: "asset_image_2", name: "b.png" };
    const view = render(<AttachmentGrid attachments={[image, second]} imageActions={actions} />);
    fireEvent.click(view.getByAltText(image.name));
    // Regenerate → the seam's call + the applied description overlay.
    fireEvent.click(view.getByTitle("regenerate_description_title"));
    await waitFor(() => expect(actions.regenerateDescription).toHaveBeenCalledTimes(1));
    expect(actions.regenerateDescription.mock.calls[0]![0].id).toBe(image.id);
    await waitFor(() => expect(document.body.textContent).toContain("Fresh text"));
    // Edit → save through the seam (the regenerated description turned the
    // add-hint into an edit button).
    fireEvent.click(view.getByTitle("Edit description"));
    fireEvent.change(view.getByPlaceholderText("describe_attachment_placeholder"), { target: { value: "A tower" } });
    fireEvent.click(view.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(actions.saveDescription).toHaveBeenCalledWith(expect.objectContaining({ id: image.id }), "A tower"));
    // Delete → confirm through the seam (a surviving sibling keeps the call).
    fireEvent.click(view.getByTitle("delete_attachment_title"));
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: /^delete$/ })));
    await waitFor(() => expect(actions.remove).toHaveBeenCalledWith(expect.objectContaining({ id: image.id })));
    expect(actions.applyLocal).toHaveBeenCalled();
  });

  test("without a messageId and without imageActions there are still no controls", () => {
    const view = render(<AttachmentGrid attachments={[image]} />);
    fireEvent.click(view.getByAltText(image.name));
    expect(document.querySelector(".fixed.inset-0")).not.toBeNull();
    expect(document.querySelector('[title="Edit description"], [title="Add description"]')).toBeNull();
    expect(document.querySelector('[title="regenerate_description_title"]')).toBeNull();
    expect(document.querySelector('[title="delete_attachment_title"]')).toBeNull();
  });
});

// ─── CA-4h: deleting the message's LAST image reaches the server ────────────

describe("last-attachment delete (CA-4h)", () => {
  test("deleting the message's only image still calls the chat delete and empties the row", async () => {
    const remove = spyOn(chatApi, "deleteAttachment").mockResolvedValue({ ok: true });
    const update = spyOn(useSnapshotStore.getState(), "updateMessage");
    actionSpies.push(remove, update);
    const view = render(<AttachmentGrid attachments={[image]} messageId="message_1" />);
    fireEvent.click(view.getByAltText(image.name));
    fireEvent.click(view.getByTitle("delete_attachment_title"));
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: /^delete$/ })));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("_", "message_1", image.id));
    expect(update).toHaveBeenCalledWith("message_1", { attachments: [] });
    // The lightbox closed (the grid hides itself with the last attachment gone).
    await waitFor(() => expect(document.querySelector(".fixed.inset-0")).toBeNull());
  });
});
