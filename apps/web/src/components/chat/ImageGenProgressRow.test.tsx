import { afterEach, describe, expect, it, mock } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realImageGenApi = await import("../../api/image-gen-api.js");
const realI18n = await import("../../i18n/context.js");
import type { ImageGenProgressInfoValue } from "@vibe-tavern/api-contracts";

/** The single snapshot the poll double serves (null = error-free "no data"). */
let served: ImageGenProgressInfoValue | null = null;

mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  fetchImageGenProgress: () => {
    if (served === null) return Promise.reject(new Error("no snapshot"));
    return Promise.resolve(served);
  },
}));

// Raw-key i18n stub (the SttLocalServerPanel.test harness): t returns the
// key itself, so assertions address copy by stable identifiers.
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
  }),
}));

const { render, cleanup, waitFor } = await import("@testing-library/react");
const React = await import("react");
const { useImageGenChatStore } = await import("../../stores/image-gen-chat-store.js");
const { ImageGenProgressRow } = await import("./ImageGenProgressRow.js");

function setRunning(liveProgress: boolean): void {
  useImageGenChatStore.setState({
    runningByChat: { "chat-1": { mode: "portrait", anchorMessageId: "m1", profileId: "p1", liveProgress } },
  });
}

afterEach(() => {
  cleanup();
  useImageGenChatStore.setState({ runningByChat: {} });
  served = null;
});

describe("ImageGenProgressRow (PG-2)", () => {
  it("renders nothing while the chat is idle", () => {
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    expect(view.queryByTestId("image-gen-progress-row")).toBeNull();
  });

  it("cloud run past the prompt phase: the plain Generating pulse, no bar", () => {
    setRunning(false);
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    const row = view.getByTestId("image-gen-progress-row");
    expect(row.textContent).toContain("image_gen_generating");
    expect(view.queryByTestId("image-gen-progress-bar")).toBeNull();
    expect(view.queryByTestId("image-gen-progress-preview")).toBeNull();
  });

  it("live run: percent + ETA line and the bar width from the snapshot", async () => {
    setRunning(true);
    served = { progress: 0.42, etaRelative: 7.6, previewBase64: "cHJldg==" };
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() => expect(view.getByTestId("image-gen-progress-line").textContent).toBe("42% · ~8s"));
    expect(view.getByTestId("image-gen-progress-bar").getAttribute("style")).toContain("42%");
    // The optional live-preview thumb rides the pill when the wire has one.
    expect(view.getByTestId("image-gen-progress-preview").getAttribute("src")).toContain("cHJldg==");
  });

  it("live run before the first snapshot: the Starting label, never a fake 0% bar (MR-11)", async () => {
    setRunning(true);
    served = null;
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() => expect(view.getByTestId("image-gen-progress-phase").textContent).toContain("image_gen_phase_starting"));
    expect(view.queryByTestId("image-gen-progress-bar")).toBeNull();
    expect(view.queryByTestId("image-gen-progress-line")).toBeNull();
  });
});

describe("ImageGenProgressRow — MR-11 phase timeline", () => {
  it("prompt phase: the Writing-prompt label wins on a live run — no bar while the LLM composes", async () => {
    setRunning(true);
    served = { phase: "prompt" };
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() =>
      expect(view.getByTestId("image-gen-progress-phase").textContent).toContain("image_gen_phase_prompt"),
    );
    expect(view.queryByTestId("image-gen-progress-bar")).toBeNull();
  });

  it("prompt phase on a CLOUD run: the same Writing-prompt label (cloud runs poll their phase too)", async () => {
    setRunning(false);
    served = { phase: "prompt" };
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() =>
      expect(view.getByTestId("image-gen-progress-phase").textContent).toContain("image_gen_phase_prompt"),
    );
  });

  it("starting phase: the Starting label, no bar — the queue/model-load span never shows an inherited percent", async () => {
    setRunning(true);
    served = { phase: "starting", progress: 1 };
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() =>
      expect(view.getByTestId("image-gen-progress-phase").textContent).toContain("image_gen_phase_starting"),
    );
    expect(view.queryByTestId("image-gen-progress-bar")).toBeNull();
    // Even a stale-looking progress: 1 payload must not leak into a bar.
    expect(view.queryByTestId("image-gen-progress-line")).toBeNull();
  });

  it("steps phase: the bar + percent line render from the snapshot fields", async () => {
    setRunning(true);
    served = { phase: "steps", progress: 0.25, etaRelative: 12.4 };
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() => expect(view.getByTestId("image-gen-progress-line").textContent).toBe("25% · ~12s"));
    expect(view.getByTestId("image-gen-progress-bar").getAttribute("style")).toContain("25%");
  });
});
