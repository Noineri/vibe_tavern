/**
 * AttachmentPreview audio chip tests (owner request 2026-09-06: listen to
 * an attached voice file before sending): the audio draft chip's artwork is
 * a play/pause toggle wired to a hidden <audio> element — click plays,
 * click again pauses, media events drive the icon (not optimistic state),
 * and non-audio drafts render the plain image thumb.
 */

import { afterAll, describe, expect, mock, test, beforeEach } from "bun:test";
import React from "react";

import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

const { render, act, cleanup } = await import("@testing-library/react");

const { default: userEvent } = await import("@testing-library/user-event");

// House i18n test pattern via the shared co-load seam: raw keys render as-is;
// the interpolated attachment_tokens pin reads the bundled EN template.
installI18nContextSeam({ interpolateKeys: ["attachment_tokens"] });
const en = (await import("../../i18n/locales/en.json")).default;
const ru = (await import("../../i18n/locales/ru.json")).default;
const { LocaleProvider } = await import("../../i18n/context.js");
const { i18next, initI18n } = await import("../../i18n/i18n.js");
// Deterministic language base for the provider-mounted RU/EN loop below
// (`initI18n` is first-wins process-wide; idempotent here).
initI18n("en");

// Existing fixtures still use the real store; the preview now receives its
// values through props instead of subscribing itself (CA-1e seam change).
const { useChatStore } = await import("../../stores/index.js");
const originalDrafts = useChatStore.getState().draftAttachments;

import { AttachmentPreview } from "./AttachmentPreview.js";
import type { Attachment } from "@vibe-tavern/domain";

// happy-dom has no media playback — prototype-level mocks make
// el.play()/el.pause() observable and let the onPlay/onPause handlers fire
// through the REAL media event semantics (we dispatch the events manually
// after the calls, mirroring a browser).
const playMock = mock(() => Promise.resolve());
const pauseMock = mock(() => {});
const originalPlay = HTMLMediaElement.prototype.play;
const originalPause = HTMLMediaElement.prototype.pause;
beforeEach(() => {
  playMock.mockClear();
  pauseMock.mockClear();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  proto.play = playMock;
  proto.pause = pauseMock;
});
afterAll(async () => {
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
  useChatStore.setState({ draftAttachments: originalDrafts });
  // R13: the RU/EN loop below drives the process-global i18next language;
  // restore the default so no sibling file observes RU.
  await i18next.changeLanguage("en");
});

function renderPreview() {
  return render(<AttachmentPreview attachments={useChatStore.getState().draftAttachments} onRemove={useChatStore.getState().removeDraftAttachment} />);
}

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
    const view = renderPreview();
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
    const view = renderPreview();
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
    const view = renderPreview();
    expect(view.getByTestId("draft-audio-play").getAttribute("aria-label")).toContain("voice-note.wav");
    cleanup();
  });

  test("non-audio drafts render the plain image thumb (no player)", () => {
    setDrafts([
      { id: "draft-2", assetId: "asset_img", type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: 5000 },
    ]);
    const view = renderPreview();
    expect(view.queryByTestId("draft-audio-play")).toBeNull();
    expect(view.getByAltText("pic.png")).toBeTruthy();
    cleanup();
  });
});

describe("AttachmentPreview file chips (CA-1e)", () => {
  const file: Attachment = {
    id: "file_1", assetId: "asset_file", type: "file", name: "a-long-file-name-that-must-ellipsize-in-the-chip.md",
    mimeType: "text/markdown", sizeBytes: 2048, tokenCount: 12400,
  };

  for (const language of ["en", "ru"] as const) {
    test(`${language}: full file name is reachable, tokens are formatted and remove receives the id`, async () => {
      // Real locale path (the AgentTimelineSeparator AP-34 precedent): the
      // seam delegates provider-mounted renders to the real i18next, so the
      // RU label is the REAL translation. Adaptation (i18n co-load seam
      // migration 2026-10-27): was the inline mock's mutable `locale` closure
      // var, now a real LocaleProvider + explicit changeLanguage — the checked
      // fact (the token label follows the UI language) survives on the real path.
      await act(async () => {
        await i18next.changeLanguage(language);
      });
      const remove = mock();
      const view = render(
        <LocaleProvider initialLocale={language}>
          <AttachmentPreview attachments={[file]} onRemove={remove} />
        </LocaleProvider>,
      );
      const chip = view.getByTestId("file-attachment-chip");
      expect(view.getByTitle(file.name).textContent).toBe(file.name);
      const label = (language === "ru" ? ru : en).attachment_tokens.replace("{tokens}", (file.tokenCount!).toLocaleString());
      const count = view.getByTitle(file.name).nextElementSibling as HTMLElement;
      expect(count.textContent).toBe(label);
      expect(count.className).toContain("whitespace-nowrap");
      expect(count.className).toContain("shrink-0");
      expect(count.className).not.toContain("truncate");
      expect(count.parentElement?.className).not.toContain("max-w");
      expect(chip.querySelector("img")).toBeNull();
      await userEvent.setup().click(view.getByRole("button"));
      expect(remove).toHaveBeenCalledWith(file.id);
    });
  }

  test("legacy file without tokenCount keeps the existing byte-size fallback", () => {
    const view = render(<AttachmentPreview attachments={[{ ...file, tokenCount: undefined }]} onRemove={mock()} />);
    expect(view.getByText("2 KB")).toBeTruthy();
  });

  test("zero-token files show zero, not the byte-size fallback", () => {
    const view = render(<AttachmentPreview attachments={[{ ...file, tokenCount: 0 }]} onRemove={mock()} />);
    expect(view.getByText(en.attachment_tokens.replace("{tokens}", "0"))).toBeTruthy();
  });
});
