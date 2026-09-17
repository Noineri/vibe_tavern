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

  it("cloud run: the plain Generating pulse, no bar, no polling", () => {
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

  it("live run before the first snapshot: a 0% bar with no ETA", async () => {
    setRunning(true);
    served = null;
    const view = render(<ImageGenProgressRow chatId="chat-1" />);
    await waitFor(() => expect(view.getByTestId("image-gen-progress-line").textContent).toBe("0%"));
    expect(view.queryByTestId("image-gen-progress-preview")).toBeNull();
  });
});
