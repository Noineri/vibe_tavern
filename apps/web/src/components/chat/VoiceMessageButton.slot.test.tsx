/**
 * VoiceMessageButton — the CM-2 additions: the `slot` variant (the mobile
 * composer's send-slot look), the `fallback` rendered while no STT profile
 * resolves, and `onBusyChange` (recording / uploading). Recording, upload and
 * the profile gate themselves are covered by VoiceMessageButton.test.tsx.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { SttProfileRecord } from "../../api/stt-api.js";
import type { VoiceRecorder } from "../../lib/stt/voice-recorder.js";

useDomEnv();

const { render, act, waitFor, fireEvent } = await import("@testing-library/react");

let profiles: SttProfileRecord[] = [];
const realSttApi = await import("../../api/stt-api.js");
mock.module("../../api/stt-api.js", () => ({
  ...realSttApi,
  listAllSttProfiles: async () => profiles,
}));

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

const { VoiceMessageButton } = await import("./VoiceMessageButton.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");

function profile(): SttProfileRecord {
  return {
    id: "stt-1", name: "Whisper", backend: "whisper-browser", config: {}, hasStoredApiKey: false,
    autoKeyProviderName: null, emotionAnnotation: false, isDefault: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function fakeRecorderFactory(): () => VoiceRecorder {
  let active = false;
  const recorder: VoiceRecorder = {
    async start() { active = true; },
    stop() { active = false; return Promise.resolve(new Blob(["clip"], { type: "audio/webm" })); },
    cancel() { active = false; },
    isActive() { return active; },
  };
  return () => recorder;
}

function mount(props: Partial<Parameters<typeof VoiceMessageButton>[0]> = {}) {
  return render(
    <TooltipProvider>
      <VoiceMessageButton onRecorded={async () => true} {...props} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  profiles = [profile()];
});

describe("VoiceMessageButton fallback", () => {
  test("renders the fallback while no profile resolves", async () => {
    profiles = [];
    const view = mount({ fallback: <span data-testid="fb">fallback</span> });
    await act(async () => {});

    expect(view.getByTestId("fb")).toBeTruthy();
    expect(view.queryByTestId("voice-message-record")).toBeNull();
  });

  test("renders nothing without a fallback (unchanged)", async () => {
    profiles = [];
    const view = mount();
    await act(async () => {});

    expect(view.container.innerHTML).toBe("");
  });

  test("drops the fallback once the profile resolves", async () => {
    const view = mount({ fallback: <span data-testid="fb">fallback</span> });

    await waitFor(() => expect(view.getByTestId("voice-message-record")).toBeTruthy());
    expect(view.queryByTestId("fb")).toBeNull();
  });
});

describe("VoiceMessageButton slot variant", () => {
  test("idle: send-sized accent button; toolbar variant keeps the ghost look", async () => {
    const slot = mount({ variant: "slot" });
    const slotBtn = await waitFor(() => slot.getByTestId("voice-message-record"));
    expect(slotBtn.className).toContain("h-9");
    expect(slotBtn.className).toContain("bg-accent");
    slot.unmount();

    const toolbar = mount();
    const toolbarBtn = await waitFor(() => toolbar.getByTestId("voice-message-record"));
    expect(toolbarBtn.className).toContain("h-[26px]");
    expect(toolbarBtn.className).not.toContain("bg-accent");
  });

  test("recording: the slot grows (min-w, padding) and keeps the timer visible", async () => {
    const view = mount({ variant: "slot", recorderFactory: fakeRecorderFactory() });
    const btn = await waitFor(() => view.getByTestId("voice-message-record"));

    fireEvent.click(btn);

    await waitFor(() => expect(btn.getAttribute("data-status")).toBe("recording"));
    expect(btn.className).toContain("min-w-9");
    expect(btn.className).toContain("px-2");
    expect(btn.textContent).toContain("0:00");
  });
});

describe("VoiceMessageButton onBusyChange", () => {
  test("is true while recording and false again after the clip is delivered", async () => {
    const busy = mock((_busy: boolean) => {});
    const view = mount({ recorderFactory: fakeRecorderFactory(), onBusyChange: busy });
    const btn = await waitFor(() => view.getByTestId("voice-message-record"));
    expect(busy.mock.calls.at(-1)?.[0]).toBe(false);

    fireEvent.click(btn);
    await waitFor(() => expect(busy.mock.calls.at(-1)?.[0]).toBe(true));

    fireEvent.click(btn);
    await waitFor(() => expect(busy.mock.calls.at(-1)?.[0]).toBe(false));
  });
});
