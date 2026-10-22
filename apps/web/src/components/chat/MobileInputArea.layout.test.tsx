/**
 * MobileInputArea — the CM-2 layout: the action slot (voice / send / cancel),
 * the model button's ring outline and warning dot, the group tints, the
 * persona chip as the row's flexible element, and the accessible names.
 *
 * STT and quota HTTP layers are stubbed with the spread-real pattern; the quota
 * store and the dictation store are seeded directly and restored in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  PROVIDER_QUOTA_KIND,
  PROVIDER_QUOTA_WINDOW_KIND,
  type ProviderQuotaConfig,
  type ProviderQuotaSnapshot,
} from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import type { SttProfileRecord } from "../../api/stt-api.js";
import type { InputAreaData } from "./use-input-area.js";

useDomEnv();

const PROFILE = "prov_1";

let sttProfiles: SttProfileRecord[] = [];
const realSttApi = await import("../../api/stt-api.js");
mock.module("../../api/stt-api.js", () => ({
  ...realSttApi,
  listAllSttProfiles: async () => sttProfiles,
}));

const realQuotaApi = await import("../../api/quota-api.js");
mock.module("../../api/quota-api.js", () => ({
  ...realQuotaApi,
  fetchQuotaCapability: () => new Promise<never>(() => {}),
  fetchQuota: () => new Promise<never>(() => {}),
  updateQuotaConfig: () => new Promise<never>(() => {}),
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

let render: typeof import("@testing-library/react").render;
let waitFor: typeof import("@testing-library/react").waitFor;
let MobileInputArea: typeof import("./MobileInputArea.js").MobileInputArea;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let useQuotaStore: typeof import("../../stores/quota-store.js").useQuotaStore;
let useDictationStore: typeof import("../../stores/dictation-store.js").useDictationStore;
let initialDictationEnabled = false;

beforeAll(async () => {
  ({ render, waitFor } = await import("@testing-library/react"));
  ({ MobileInputArea } = await import("./MobileInputArea.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ useQuotaStore } = await import("../../stores/quota-store.js"));
  ({ useDictationStore } = await import("../../stores/dictation-store.js"));
  initialDictationEnabled = useDictationStore.getState().enabled;
});

afterAll(() => {
  useQuotaStore.getState().reset();
  useDictationStore.getState().setEnabled(initialDictationEnabled);
});

beforeEach(() => {
  useQuotaStore.getState().reset();
  useDictationStore.getState().setEnabled(false);
  sttProfiles = [];
});

function sttProfile(): SttProfileRecord {
  return {
    id: "stt_1", name: "Whisper", backend: "openai", config: {}, hasStoredApiKey: false,
    autoKeyProviderName: null, emotionAnnotation: false, isDefault: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeData(overrides: Record<string, unknown> = {}) {
  return {
    t: (key: string) => key,
    chat: { handleSend: mock(), handleCancelGeneration: mock() },
    character: { handleSetChatPersona: mock() },
    preset: { handleSetActivePromptPresetId: mock() },
    draft: "hello",
    setDraft: mock(),
    isSending: false,
    activeChatId: "chat-1",
    chatMeta: undefined,
    personas: [{ id: "persona-1", name: "A very long persona name that must ellipsize", avatarExt: null, avatarAssetId: null, updatedAt: "2026-01-01T00:00:00.000Z" }],
    activePersonaId: "persona-1",
    promptPresets: [{ id: "preset-1", name: "Narrative" }],
    activePromptPresetId: "preset-1",
    favoriteModels: [],
    activeModelId: null,
    handleSelectFavoriteModel: mock(),
    fileInputRef: { current: null },
    draftAttachments: [],
    onFileInputChange: mock(),
    handlePaste: mock(),
    canSend: true,
    showGenerateMore: false,
    handleGenerateMore: mock(),
    buckets: { system: 0, character: 0, persona: 0, lore: 0, memory: 0, tools: 0, history: 0 },
    inputTokens: 3584,
    permanent: 0,
    contextSize: 8192,
    maxTokens: 1024,
    availableBudget: 7168,
    tokenState: "ok",
    perSendPrefillSupported: false,
    handleVoiceRecorded: mock(),
    provider: { activeProviderProfile: null },
    ...overrides,
  } as unknown as InputAreaData;
}

function mount(data: InputAreaData) {
  return render(<TooltipProvider><MobileInputArea data={data} /></TooltipProvider>);
}
type View = ReturnType<typeof mount>;

const button = (v: View, name: string): HTMLButtonElement => v.getByRole("button", { name }) as HTMLButtonElement;
const modelButton = (v: View): HTMLButtonElement => button(v, "model_label");
const hasDot = (v: View): boolean => modelButton(v).querySelector(".bg-danger") !== null;
const voiceButton = (v: View): HTMLElement | null => v.container.querySelector('[data-testid="voice-message-record"]');
/** True when the element is shown (no ancestor carries the `hidden` utility). */
const shown = (el: Element | null): boolean => el !== null && el.closest(".hidden") === null;

describe("MobileInputArea action slot", () => {
  it("empty draft -> the voice-message button, no send", async () => {
    sttProfiles = [sttProfile()];
    const view = mount(makeData({ draft: "", canSend: false }));

    await waitFor(() => expect(voiceButton(view)).not.toBeNull());
    expect(shown(voiceButton(view))).toBe(true);
    expect(view.queryByRole("button", { name: "send" })).toBeNull();
  });

  it("a whitespace-only draft is still empty -> voice", async () => {
    sttProfiles = [sttProfile()];
    const view = mount(makeData({ draft: "   \n ", canSend: false }));

    await waitFor(() => expect(shown(voiceButton(view))).toBe(true));
    expect(view.queryByRole("button", { name: "send" })).toBeNull();
  });

  it("text -> send, and the voice button is hidden (kept mounted)", async () => {
    sttProfiles = [sttProfile()];
    const view = mount(makeData({ draft: "hello" }));

    expect(button(view, "send").disabled).toBe(false);
    await waitFor(() => expect(voiceButton(view)).not.toBeNull());
    expect(shown(voiceButton(view))).toBe(false);
  });

  it("attachments only (empty draft) -> send", () => {
    sttProfiles = [sttProfile()];
    const view = mount(makeData({ draft: "", draftAttachments: [{ id: "a1" }], canSend: true }));

    expect(button(view, "send").disabled).toBe(false);
    expect(shown(voiceButton(view))).toBe(false);
  });

  it("sending -> cancel only", () => {
    sttProfiles = [sttProfile()];
    const view = mount(makeData({ isSending: true, draft: "", canSend: false }));

    expect(button(view, "cancel")).not.toBeNull();
    expect(view.queryByRole("button", { name: "send" })).toBeNull();
    expect(shown(voiceButton(view))).toBe(false);
  });

  it("no voice profile -> the slot falls back to the disabled send, never a hole", async () => {
    sttProfiles = [];
    const view = mount(makeData({ draft: "", canSend: false }));

    await waitFor(() => expect(button(view, "send").disabled).toBe(true));
    expect(voiceButton(view)).toBeNull();
  });

  it("the standalone context ring is not in the input row", () => {
    const view = mount(makeData());

    expect(view.queryByTestId("chat-context-ring")).toBeNull();
    const rings = view.container.querySelectorAll("svg[data-token-state]");
    expect(rings.length).toBe(1);
    expect(modelButton(view).contains(rings[0] as Element)).toBe(true);
  });
});

describe("MobileInputArea model button", () => {
  it("carries the context ring as its outline, always accent, filled to the usage", () => {
    // 3584 of 7168 -> 50 %.
    const view = mount(makeData({ tokenState: "warn" }));
    const svg = modelButton(view).querySelector("svg[data-token-state]")!;
    const [track, arc] = Array.from(svg.querySelectorAll("circle"));

    expect(svg.getAttribute("width")).toBe("36");
    expect(track?.getAttribute("class")).toContain("stroke-accent/20");
    // Even at the warn state the outline stays accent: the warning is the dot.
    expect(arc?.getAttribute("class")).toBe("stroke-accent");
    const circumference = 2 * Math.PI * 15.5;
    expect(Number(arc?.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * 0.5, 3);
  });

  it("opens the model sheet", async () => {
    const view = mount(makeData());

    expect(view.queryByText("starred_models")).toBeNull();
    button(view, "model_label").click();

    await waitFor(() => expect(view.getByText("starred_models")).toBeTruthy());
  });

  it("the context figure in the sheet follows tokenState", async () => {
    const view = mount(makeData({ tokenState: "warn" }));
    button(view, "model_label").click();

    const label = await waitFor(() => view.getByText("context_label"));
    const figure = label.closest("button")!.querySelector("span.tabular-nums")!;
    expect(figure.classList.contains("text-danger-text")).toBe(true);
  });
});

const QUOTA_CONFIG: ProviderQuotaConfig = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  displayEnabled: true,
  lowQuotaEnabled: false,
  lowQuotaRemainingPercent: 10,
  resetNotifyEnabled: false,
  pollIntervalMinutes: 5,
};

function seedQuota(usedPercent: number, config: ProviderQuotaConfig = QUOTA_CONFIG): void {
  const snapshot: ProviderQuotaSnapshot = {
    kind: PROVIDER_QUOTA_KIND.windowed,
    providerProfileId: PROFILE,
    capabilityId: "zai",
    capabilityVersion: 1,
    observedAt: "2026-08-08T12:00:00.000Z",
    windows: [{ kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: "5-hour session", usedPercent, resetsAt: "2099-01-01T00:00:00.000Z" }],
    balances: [],
  };
  useQuotaStore.setState({
    entries: {
      [PROFILE]: { status: "success", capability: null, config, snapshot, lastError: null, loadError: null, updatedAt: "2026-08-08T12:00:00.000Z" },
    },
  });
}

const withProfile = { provider: { activeProviderProfile: { id: PROFILE, name: "DeepSeek" } } };

describe("MobileInputArea model button warning dot", () => {
  it("is off while the context is ok or mid and there is no quota", () => {
    for (const tokenState of ["ok", "mid"]) {
      const view = mount(makeData({ tokenState }));
      expect(hasDot(view)).toBe(false);
      view.unmount();
    }
  });

  it("is on, decorative, with the surface-colored ring gap, for a warn context", () => {
    const view = mount(makeData({ tokenState: "warn" }));
    const dot = modelButton(view).querySelector(".bg-danger")!;

    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.classList.contains("border-s2")).toBe(true);
    expect(dot.classList.contains("border-2")).toBe(true);
  });

  it("is on for a warn quota when the quota is visible", () => {
    seedQuota(95);

    expect(hasDot(mount(makeData(withProfile)))).toBe(true);
  });

  it("is off for a mid quota", () => {
    seedQuota(80);

    expect(hasDot(mount(makeData(withProfile)))).toBe(false);
  });

  it("is off for a warn quota while the quota is hidden (display toggle off)", () => {
    seedQuota(95, { ...QUOTA_CONFIG, displayEnabled: false });

    expect(hasDot(mount(makeData(withProfile)))).toBe(false);
  });

  it("is off for a warn quota of an unsupported vendor (kind none)", () => {
    seedQuota(95, { ...QUOTA_CONFIG, kind: PROVIDER_QUOTA_KIND.none });

    expect(hasDot(mount(makeData(withProfile)))).toBe(false);
  });

  it("still lights for a warn context when the quota is hidden", () => {
    seedQuota(10, { ...QUOTA_CONFIG, displayEnabled: false });

    expect(hasDot(mount(makeData({ ...withProfile, tokenState: "warn" })))).toBe(true);
  });
});

describe("MobileInputArea group tints", () => {
  const classes = (el: Element | null): string[] => Array.from(el?.classList ?? []);

  it("persona chip and impersonate pill take the info tint", () => {
    const view = mount(makeData());
    const chip = view.getByText(/A very long persona name/).closest("button")!;
    const pillStar = view.container.querySelector("button.group\\/star")!;
    const pill = pillStar.parentElement!;

    expect(classes(chip)).toEqual(expect.arrayContaining(["bg-info-dim", "text-info-text"]));
    expect(classes(pill)).toContain("bg-info-dim");
    expect(classes(pillStar)).toContain("text-info-text");
  });

  it("preset and model take the accent tint", () => {
    const view = mount(makeData());

    for (const name of ["topbar_prompt_preset", "model_label"]) {
      expect(classes(button(view, name))).toEqual(expect.arrayContaining(["bg-accent-dim", "text-accent-t"]));
    }
  });

  it("attach and dictation stay neutral", async () => {
    sttProfiles = [sttProfile()];
    useDictationStore.getState().setEnabled(true);
    const view = mount(makeData());
    const mic = await waitFor(() => view.getByTestId("dictation-mic"));

    for (const el of [button(view, "attach_image"), mic]) {
      expect(classes(el)).toEqual(expect.arrayContaining(["bg-s3", "text-t3"]));
      expect(classes(el)).not.toContain("bg-accent-dim");
      expect(classes(el)).not.toContain("bg-info-dim");
    }
  });

  it("no per-icon star / warning colors remain on preset and model", () => {
    const view = mount(makeData());

    expect(view.container.querySelector(".text-warning-text")).toBeNull();
  });
});

describe("MobileInputArea toolbar width", () => {
  it("the persona chip is the flexible element: it shrinks and its name ellipsizes", () => {
    const view = mount(makeData());
    const chip = view.getByText(/A very long persona name/).closest("button")!;
    const name = view.getByText(/A very long persona name/);

    expect(chip.classList.contains("min-w-0")).toBe(true);
    expect(chip.classList.contains("shrink-0")).toBe(false);
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.classList.contains("min-w-0")).toBe(true);
  });

  it("every other toolbar control is shrink-0", async () => {
    sttProfiles = [sttProfile()];
    useDictationStore.getState().setEnabled(true);
    const view = mount(makeData());
    const mic = await waitFor(() => view.getByTestId("dictation-mic"));
    const pill = view.container.querySelector("button.group\\/star")!.parentElement!.parentElement!;

    for (const el of [pill, button(view, "attach_image"), mic, button(view, "topbar_prompt_preset"), modelButton(view)]) {
      expect(el.classList.contains("shrink-0")).toBe(true);
    }
  });
});

describe("MobileInputArea accessible names", () => {
  it("attach, preset, model, send and cancel are named", () => {
    const idle = mount(makeData());
    for (const name of ["attach_image", "topbar_prompt_preset", "model_label", "send"]) {
      expect(button(idle, name)).not.toBeNull();
    }
    idle.unmount();

    const sending = mount(makeData({ isSending: true }));
    expect(button(sending, "cancel")).not.toBeNull();
  });
});
