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

function profile(id: string, name: string, caps?: Partial<ProfileRecord["capabilities"]>): ProfileRecord {
  return {
    id,
    name,
    backend: "openrouter",
    endpoint: "https://example.test",
    hasStoredApiKey: true,
    autoKeyProviderName: null,
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
      ...caps,
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
  // The store is a module singleton shared across files in this worker —
  // leave the IG-16/IG-17 maps pristine for the next test/file.
  useImageGenChatStore.setState({
    fineTuningByChat: {},
    fineTuningDraftByChat: {},
    activeProfileIdByChat: {},
    runningByChat: {},
  });
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
    // The fine-tuning switch (shared Toggle → role=switch) lives in the
    // popover; the profile pick does NOT (CF2: the popover is modes + toggle
    // only — provider+model belong to the fine-tuning pill's editor; the
    // menu consumes the chat's active profile read-only from the store).
    expect(within(view.baseElement).getByRole("switch", { name: "image_gen_fine_tuning" })).toBeTruthy();
    expect(within(view.baseElement).queryByTestId("image-gen-profile-select")).toBeNull();
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

describe("ImageGenMessageMenu — chip draft reaches the generate payload (IG-17)", () => {
  function armWithDraft(chatId: string, draft: { prompt?: string; negative?: string; model?: string; sampler?: string }): void {
    useImageGenChatStore.getState().setFineTuning(chatId, true);
    useImageGenChatStore.getState().setFineTuningDraft(chatId, draft);
  }

  function settle(chatId: string): void {
    pendingByChat.get(chatId)!.resolve();
  }

  it("fine tuning on + full caps profile: prompt verbatim, negative/model/sampler as overrides", async () => {
    profilesStore = [profile("p1", "A1111 local", { supportsNegativePrompt: true, supportsSamplers: true })];
    armWithDraft("chat-ft", { prompt: "  a castle at dawn  ", negative: "blurry", model: "pony-v6", sampler: "Euler a" });
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-ft" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    expect(generateCalls.length).toBe(1);
    const [, body] = generateCalls[0];
    // The IG-14 verbatim contract: the trimmed chip text, never re-templated.
    expect(body.prompt).toBe("a castle at dawn");
    expect(body.overrides).toEqual({ negativePrompt: "blurry", model: "pony-v6", sampler: "Euler a" });
    settle("chat-ft");
    await act(async () => { await Promise.resolve(); });
  });

  it("capability gates: no-caps profile never receives a negative (and the sampler pick is a UI impossibility); model still rides", async () => {
    profilesStore = [profile("p1", "OpenRouter main")];
    armWithDraft("chat-gated", { prompt: "x", negative: "should-not-send", model: "flux-1" });
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-gated" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    expect(generateCalls.length).toBe(1);
    const [, body] = generateCalls[0];
    expect(body.overrides).toEqual({ model: "flux-1" });
    expect("negativePrompt" in (body.overrides ?? {})).toBe(false);
    settle("chat-gated");
    await act(async () => { await Promise.resolve(); });
  });

  it("whitespace-only prompt/negative are not sent; an empty draft sends no overrides key at all", async () => {
    profilesStore = [profile("p1", "A1111 local", { supportsNegativePrompt: true, supportsSamplers: true })];
    armWithDraft("chat-empty", { prompt: "   ", negative: "" });
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-empty" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    expect(generateCalls.length).toBe(1);
    const [, body] = generateCalls[0];
    expect("prompt" in body).toBe(false);
    expect("overrides" in body).toBe(false);
    settle("chat-empty");
    await act(async () => { await Promise.resolve(); });
  });

  it("fine tuning OFF ignores the draft entirely (legacy payload: mode + anchor + profile only)", async () => {
    profilesStore = [profile("p1", "A1111 local", { supportsNegativePrompt: true })];
    useImageGenChatStore.getState().setFineTuningDraft("chat-off", { prompt: "ignored", negative: "ignored" });
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-off" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-portrait")).toBeTruthy());
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    expect(generateCalls.length).toBe(1);
    const [, body] = generateCalls[0];
    expect("prompt" in body).toBe(false);
    expect("overrides" in body).toBe(false);
    settle("chat-off");
    await act(async () => { await Promise.resolve(); });
  });
});

describe("ImageGenMessageMenu — free mode unparks with the chip (IG-17)", () => {
  function settle(chatId: string): void {
    pendingByChat.get(chatId)!.resolve();
  }

  it("fine tuning on + non-empty chip prompt: free is enabled and carries the chip prompt as the raw payload", async () => {
    useImageGenChatStore.getState().setFineTuning("chat-free", true);
    useImageGenChatStore.getState().setFineTuningDraft("chat-free", { prompt: "watercolor dragon" });
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-free" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-free")).toBeTruthy());
    const free = within(view.baseElement).getByTestId("image-gen-mode-free") as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    // The hint hides once the requirement is satisfied.
    expect(within(view.baseElement).queryByText("image_gen_free_hint")).toBeNull();
    act(() => {
      fireEvent.click(free);
    });
    expect(generateCalls.length).toBe(1);
    const [, body] = generateCalls[0];
    expect(body.mode).toBe("free");
    expect(body.prompt).toBe("watercolor dragon");
    settle("chat-free");
    await act(async () => { await Promise.resolve(); });
  });

  it("fine tuning on + EMPTY chip prompt: free stays disabled with the hint (the contract's required payload)", async () => {
    useImageGenChatStore.getState().setFineTuning("chat-free2", true);
    const view = renderMenu(<ImageGenMessageMenu chatId="chat-free2" messageId="m-1" variant="desktop" />);
    openPopover(view);
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-gen-mode-free")).toBeTruthy());
    const free = within(view.baseElement).getByTestId("image-gen-mode-free") as HTMLButtonElement;
    expect(free.disabled).toBe(true);
    expect(within(view.baseElement).getByText("image_gen_free_hint")).toBeTruthy();
    // Other modes still fire — the block is free-specific.
    act(() => {
      fireEvent.click(within(view.baseElement).getByTestId("image-gen-mode-portrait"));
    });
    expect(generateCalls.length).toBe(1);
    expect(generateCalls[0][1].mode).toBe("portrait");
    settle("chat-free2");
    await act(async () => { await Promise.resolve(); });
  });
});
