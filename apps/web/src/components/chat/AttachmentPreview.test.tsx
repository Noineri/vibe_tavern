/**
 * AttachmentPreview audio chip tests (owner request 2026-09-06: listen to
 * an attached voice file before sending): the audio draft chip's artwork is
 * a play/pause toggle wired to a hidden <audio> element — click plays,
 * click again pauses, media events drive the icon (not optimistic state),
 * and non-audio drafts render the plain image thumb.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";
import React from "react";
import { render, act, cleanup } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { default: userEvent } = await import("@testing-library/user-event");

// House i18n test pattern: raw keys render as-is.
const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// The store is read via useChatStore selectors — set state directly.
const { useChatStore } = await import("../../stores/index.js");

import { AttachmentPreview } from "./AttachmentPreview.js";
import type { Attachment } from "@vibe-tavern/domain";

// happy-dom has no media playback — prototype-level mocks make
// el.play()/el.pause() observable and let the onPlay/onPause handlers fire
// through the REAL media event semantics (we dispatch the events manually
// after the calls, mirroring a browser).
const playMock = mock(() => Promise.resolve());
const pauseMock = mock(() => {});
beforeEach(() => {
  playMock.mockClear();
  pauseMock.mockClear();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = playMock;
  proto.pause = pauseMock;
});

function setDrafts(attachments: Attachment[]): void {
  act(() => {
    useChatStore.setState({ draftAttachments: attachments });
  });
}

const audioDraft: Attachment = {
  id: "draft-1",
  assetId: "asset_v1",
  type: "audio",
  name: "voice-note.wav",
  mimeType: "audio/wav",
  sizeBytes: 32000,
  durationMs: 7000,
};

function fireMediaEvent(el: Element, type: string): void {
  act(() => {
    el.dispatchEvent(new Event(type));
  });
}

describe("AttachmentPreview audio chip playback", () => {
  test("audio draft chip shows the play toggle; click plays, media events flip the icon, click pauses", async () => {
    setDrafts([audioDraft]);
    const view = render(<AttachmentPreview />);
    const play = view.getByTestId("draft-audio-play");
    expect(view.getByTestId("draft-audio-element")).toBeTruthy();
    expect(play.getAttribute("aria-pressed")).toBe("false");

    const user = userEvent.setup();
    await user.click(play);
    expect(playMock).toHaveBeenCalledTimes(1);
    const audio = view.getByTestId("draft-audio-element");
    fireMediaEvent(audio, "play");
    expect(play.getAttribute("aria-pressed")).toBe("true");
    expect(play.getAttribute("aria-label")).toContain("voice_draft_pause");

    await user.click(play);
    expect(pauseMock).toHaveBeenCalledTimes(1);
    fireMediaEvent(audio, "pause");
    expect(play.getAttribute("aria-pressed")).toBe("false");
    expect(play.getAttribute("aria-label")).toContain("voice_draft_play");
    cleanup();
  });

  test("clip end resets the toggle to the play state", async () => {
    setDrafts([audioDraft]);
    const view = render(<AttachmentPreview />);
    const play = view.getByTestId("draft-audio-play");
    const user = userEvent.setup();
    await user.click(play);
    fireMediaEvent(view.getByTestId("draft-audio-element"), "play");
    expect(play.getAttribute("aria-pressed")).toBe("true");
    fireMediaEvent(view.getByTestId("draft-audio-element"), "ended");
    expect(play.getAttribute("aria-pressed")).toBe("false");
    cleanup();
  });

  test("the play toggle carries the file name in the accessible label", () => {
    setDrafts([audioDraft]);
    const view = render(<AttachmentPreview />);
    expect(view.getByTestId("draft-audio-play").getAttribute("aria-label")).toContain("voice-note.wav");
    cleanup();
  });

  test("non-audio drafts render the plain image thumb (no player)", () => {
    setDrafts([
      { id: "draft-2", assetId: "asset_img", type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: 5000 },
    ]);
    const view = render(<AttachmentPreview />);
    expect(view.queryByTestId("draft-audio-play")).toBeNull();
    expect(view.getByAltText("pic.png")).toBeTruthy();
    cleanup();
  });
});
