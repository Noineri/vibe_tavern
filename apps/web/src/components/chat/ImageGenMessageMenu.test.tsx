import { describe, expect, it, mock, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

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

const realImageGenApi = await import("../../api/image-gen-api.js");
const realChatActions = await import("../../stores/api-actions/chat-actions.js");
const realSonner = await import("sonner");

type ProfileRecord = import("../../api/image-gen-api.js").ImageGenProfileRecord;
type GenerateCall = [string, import("@vibe-tavern/api-contracts").GenerateImageGenInput, AbortSignal | undefined];

let profilesStore: ProfileRecord[] = [profile("p1", "OpenRouter main"), profile("p2", "A1111 local")];
const generateCalls: GenerateCall[] = [];

function profile(id: string, name: string): ProfileRecord {
  return {
    id,
    name,
    backend: "openrouter",
    endpoint: "https://example.test",
    hasStoredApiKey: true,
    defaultParams: {},
    modeSizePresets: {},
    llmAssistEnabled: false,
    capabilities: {
      supportsNegativePrompt: false,
      supportsSamplers: false,
      supportsSeed: false,
      sizeSupport: { kind: "free" },
      noApiKey: false,
      supportsLiveProgress: false,
      localExecution: false,
      supportsImg2img: false,
      supportsInpaint: false,
    },
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Parked generate double: rejects with a DOMException AbortError on abort
 *  (the real aborted-fetch behavior the Stop path relies on). */
const pendingByChat = new Map<string, { resolve(): void; reject(error: unknown): void }>();
function parkedGenerate(chatId: string, signal?: AbortSignal): Promise<Record<string, never>> {
  return new Promise((resolve, reject) => {
    const parked = {
      resolve: () => resolve({} as Record<string, never>),
      reject,
    };
    pendingByChat.set(chatId, parked);
    if (signal !== undefined) {
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }
  });
}

mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listAllImageGenProfiles: () => Promise.resolve([...profilesStore]),
  generateImageGen: (chatId: string, input: GenerateCall[1], signal?: AbortSignal) => {
    generateCalls.push([chatId, input, signal]);
    return parkedGenerate(chatId, signal);
  },
}));

const refreshCalls: string[] = [];
mock.module("../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  fetchChatAction: (chatId: string) => {
    refreshCalls.push(chatId);
    return Promise.resolve();
  },
}));

mock.module("sonner", () => ({
  ...realSonner,
  toast: { ...realSonner.toast, error: () => {} },
}));

const { ImageGenMessageMenu } = await import("./ImageGenMessageMenu.js");
const { useImageGenChatStore } = await import("../../stores/image-gen-chat-store.js");
const { useModalStore } = await import("../../stores/modal-store.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { within } = await import("@testing-library/react");

/** The app mounts TooltipProvider at its root (app.tsx) — the component's
 *  CustomTooltip-wrapped trigger renders inside it in production, so the
 *  harness wraps with the same provider (the app-realistic tree). */
function renderMenu(node: React.ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider delayDuration={200}>{node}</TooltipProvider>);
}

/** Container-anchored lookup: with several menus rendered at once (the
 *  shared-state tests), render() queries here resolve against the whole
 *  document, so portaled/parallel mounts collide — query THIS render's
 *  container directly and take its newest matching node. */
function q(view: ReturnType<typeof render>, testid: string): HTMLElement {
  const all = view.container.querySelectorAll(`[data-testid="${testid}"]`);
  const el = all[all.length - 1];
  if (!(el instanceof HTMLElement)) throw new Error(`no "${testid}" in this render's container`);
  return el;
}

function openPopover(view: ReturnType<typeof render>): void {
  const trigger = q(view, "image-gen-message-trigger");
  act(() => {
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
  });
}

function closePopover(view: ReturnType<typeof render>): void {
  const trigger = q(view, "image-gen-message-trigger");
  act(() => {
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
  });
}

afterEach(() => {
  cleanup();
  generateCalls.length = 0;
  refreshCalls.length = 0;
  profilesStore = [profile("p1", "OpenRouter main"), profile("p2", "A1111 local")];
  useModalStore.getState().setIsProviderModalOpen(false);
});

describe("ImageGenMessageMenu — desktop popover (IG-16)", () => {
  it("opens from the message action and lists all six modes with registry labels; free is disabled with its hint", async () => {
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-1" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    const modes = [
      "scene-background",
      "portrait",
      "character",
      "user-persona",
      "scene-illustration",
      "free",
    ];
    for (const mode of modes) {
      const row = within(view.baseElement).getByTestId(`image-gen-mode-${mode}`) as HTMLButtonElement;
      expect(row.textContent).toContain(`image_gen_mode_${mode}`);
    }
    const free = within(view.baseElement).getByTestId("image-gen-mode-free") as HTMLButtonElement;
    expect(free.disabled).toBe(true);
    expect(within(view.baseElement).getByText("image_gen_free_hint")).toBeTruthy();
    // The fine-tuning switch (shared Toggle → role=switch) and the profile
    // picker both live in the popover.
    expect(within(view.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" })).toBeTruthy();
    expect(within(view.baseElement).getByTestId("image-gen-profile-select")).toBeTruthy();
  });

  it("selecting a mode fires the client generate call at the API seam with mode + anchor message", async () => {
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-2" messageId="m-anchor" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    expect(generateCalls.length).toBe(1);
    const [chatId, body, signal] = generateCalls[0];
    expect(chatId).toBe("chat-2");
    expect(body.mode).toBe("portrait");
    expect(body.anchorMessageId).toBe("m-anchor");
    expect(body.profileId).toBe("p1");
    expect(signal).toBeDefined();
    // Settle the parked run so later suites see an idle store.
    pendingByChat.get("chat-2")!.resolve();
    await act(async () => { await Promise.resolve(); });
  });

  it("empty state: no profiles → message + settings jump opens the provider modal", async () => {
    profilesStore = [];
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-3" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-empty-open-settings")).toBeTruthy());
    expect(within(view.baseElement).getByText("image_gen_no_profiles")).toBeTruthy();
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-empty-open-settings"));
    });
    expect(useModalStore.getState().isProviderModalOpen).toBe(true);
  });
});

describe("ImageGenMessageMenu — fine tuning is per-chat, shared across messages (IG-16)", () => {
  it("flipping on message A's popover shows ON on message B's popover in the same chat; another chat stays OFF", async () => {
    const chatAmsg1 = renderMenu(<ImageGenMessageMenu chatId="chat-A" messageId="m-1" variant="desktop" />);
    openPopover(chatAmsg1);
    await waitFor(() => expect(within(chatAmsg1.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" })).toBeTruthy());
    const toggle = within(chatAmsg1.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" }) as HTMLElement;
    expect(toggle.getAttribute("data-state")).toBe("unchecked");
    act(() => {
      fireEvent.click(toggle);
    });
    // The switch flips in place…
    await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
    // …and the store map (the IG-17 chip's data source) is set for the chat.
    expect(useImageGenChatStore.getState().fineTuningByChat["chat-A"]).toBe(true);
    closePopover(chatAmsg1);

    // Message B in the SAME chat shares the state; a different chat does not.
    const chatAmsg2 = renderMenu(<ImageGenMessageMenu chatId="chat-A" messageId="m-2" variant="desktop" />);
    openPopover(chatAmsg2);
    await waitFor(() => expect(within(chatAmsg2.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" })).toBeTruthy());
    const toggleB = within(chatAmsg2.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" }) as HTMLElement;
    expect(toggleB.getAttribute("data-state")).toBe("checked");
    closePopover(chatAmsg2);

    const chatBmsg = renderMenu(<ImageGenMessageMenu chatId="chat-B" messageId="m-1" variant="desktop" />);
    openPopover(chatBmsg);
    await waitFor(() => expect(within(chatBmsg.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" })).toBeTruthy());
    const toggleOther = within(chatBmsg.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" }) as HTMLElement;
    expect(toggleOther.getAttribute("data-state")).toBe("unchecked");
  });
});

describe("ImageGenMessageMenu — in-flight Stop control (IG-16)", () => {
  it("while running, the trigger morphs into Stop; Stop aborts the seam and the UI returns to idle", async () => {
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-stop" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-character")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-character"));
    });
    expect(generateCalls.length).toBe(1);
    const signal = generateCalls[0][2]!;

    // The trigger morphed: the popover trigger is gone, the Stop button is there.
    await waitFor(() => expect(q(view, "image-gen-message-stop")).toBeTruthy());
    expect(view.container.querySelectorAll('[data-testid="image-gen-message-trigger"]').length).toBe(0);

    act(() => {
      fireEvent.click(q(view, "image-gen-message-stop"));
    });
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(q(view, "image-gen-message-trigger")).toBeTruthy());
    expect(useImageGenChatStore.getState().runningByChat["chat-stop"]).toBeUndefined();
  });

  it("a second mode click while running does not fire a second call (one per chat)", async () => {
    const view1 = renderMenu(<ImageGenMessageMenu chatId="chat-busy" messageId="m-1" variant="desktop" />);
    const view2 = renderMenu(<ImageGenMessageMenu chatId="chat-busy" messageId="m-2" variant="desktop" />);
    openPopover(view1);
    await waitFor(() => expect(within(view1.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view1.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    // The other message's trigger is a Stop now — no popover to open.
    await waitFor(() => expect(q(view2, "image-gen-message-stop")).toBeTruthy());
    expect(view2.container.querySelectorAll('[data-testid="image-gen-message-trigger"]').length).toBe(0);
    expect(generateCalls.length).toBe(1);
    // Settle: abort through the shared seam.
    act(() => {
      fireEvent.click(q(view2, "image-gen-message-stop"));
    });
    await waitFor(() => expect(q(view1, "image-gen-message-trigger")).toBeTruthy());
  });
});

describe("ImageGenMessageMenu — mobile sheet (IG-16)", () => {
  it("the icon button opens the BottomSheet with the same mode body", async () => {
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-mob" messageId="m-1" variant="mobile" />);
    expect(view.container.querySelectorAll('[data-testid="image-gen-message-trigger"]').length).toBe(1);
    act(() => {
      fireEvent.click(q(view, "image-gen-message-trigger"));
    });
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    expect(within(view.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" })).toBeTruthy();
    expect(within(view.baseElement).getByText("image_gen_section_title")).toBeTruthy();
  });
});
