/**
 * AttachmentGrid voice-bubble DOM tests (STT_PLAN ST-6): audio attachments
 * render the playable bubble (not the zoomable image button), the transcript
 * toggles, and music/ambient clips are playback-only (no transcript UI).
 */

import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { render, act } from "@testing-library/react";
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

import { AttachmentGrid } from "./AttachmentGrid.js";

type GridAttachment = NonNullable<Parameters<typeof AttachmentGrid>[0]["attachments"]>[number];

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
