/**
 * CS-22 — CoauthorInputArea render (smoke) test.
 *
 * Pins the surface's PRESENCE contract vs. the RP InputArea: the quick module
 * switch + tool-filtered favorites pill render, and the RP-only affordances
 * (persona switch, AI-impersonation pill, prompt-preset switcher) are ABSENT.
 * CA-3b adds the shared image/text attachment path.
 *
 * The two BEHAVIOURAL contracts — "selecting a module calls the action" and
 * "only tool-capable favorites are offered" — live in use-coauthor-input-area.test.ts,
 * pinned at the hook level (useModuleSwitch.handleSelect + decorated favorites).
 * They were formerly driven here through the Select UI, but Radix Select.Content
 * does not mount under happy-dom (no layout → Presence/Portal never appears; the
 * same limitation for which shared/DropdownSelect.test is `.skip`'d). The Select
 * is plumbing; the contracts belong to the data hook, so that is where they are
 * pinned now. See overlay-primitive-audit.md execution log.
 *
 * Mocking follows CoauthorTopBar.test / CoauthorModuleModal.test: capture real
 * modules first, spread `...real` in every factory (mock.module is
 * process-global — AGENTS.md gotcha). The data stores (chat-store,
 * provider-store, snapshot-store) are left REAL and seeded via `setState`
 * (same pattern CoauthorModuleModal.test uses) instead of being replaced —
 * replacing `useChatStore` breaks `useIsSending`, which reads nested state the
 * a mock would have to re-implement wholesale. `use-mobile` is NOT mocked
 * (collides with VibeMdView.test process-globally; happy-dom's desktop viewport
 * already yields useIsMobile()=false, exercising the desktop branch).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireCharacter, wireProviderProfile, wireUiSettings } from "../../../test/wire-fixtures.js";
import { brandId, type Attachment, type MessageId, type ChatId, type ChatBranchId } from "@vibe-tavern/domain";
import type { AppMessage } from "../../api/types.js";

useDomEnv();

let act: typeof import("@testing-library/react").act;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;
let cleanup: typeof import("@testing-library/react").cleanup;
import type { CoauthorModule } from "@vibe-tavern/api-contracts";
import { useChatStore } from "../../stores/chat-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
const assets = await import("../../api/asset-api.js");
const voiceMap = await import("../../lib/tts/voice-map-data.js");
const { toast } = await import("sonner");
const { default: userEvent } = await import("@testing-library/user-event");

// CA-3b T2: real composer/hook/upload validation/preview/store and sent-message
// chain. Upload is the external adapter seam. Restore all state and spies;
// no paths, sleeps, real i18n init, network or DB setup in the added cases.
const initial = { chat: useChatStore.getState(), provider: useProviderStore.getState(), snapshot: useSnapshotStore.getState(), data: useProviderDataStore.getState(), bootstrap: useBootstrapStore.getState() };
const spies: Array<{ mockRestore(): void }> = [];
function restore() {
  cleanup?.();
  for (const spy of spies.splice(0)) spy.mockRestore();
  useChatStore.setState(initial.chat, true);
  useProviderStore.setState(initial.provider, true);
  useSnapshotStore.setState(initial.snapshot, true);
  useProviderDataStore.setState(initial.data, true);
  useBootstrapStore.setState(initial.bootstrap, true);
}
beforeEach(restore);
afterEach(restore);
afterAll(restore);

// Capture the real modules before registering the process-global mock.module
// factories.

const handleSelectFavoriteProviderModel = mock(async (_profileId: string, _modelId: string) => undefined);
const handleSend = mock(async () => undefined);
const handleCancelGeneration = mock();
const realI18n = await import("../../i18n/context.js");
const realProviderProfiles = await import("../../hooks/use-provider-profiles.js");
const realChatController = await import("../../hooks/use-chat-controller.js");
const realTooltip = await import("../shared/Tooltip.js");
const realChatActions = await import("../../stores/api-actions/chat-actions.js");

mock.module("../../i18n/context.js", () => ({
		...realI18n,
		useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// Provider profiles: one active profile with two favorites — one tool-capable,
// one not. The tool-only filtering is what the test pins.
mock.module("../../hooks/use-provider-profiles.js", () => ({
		...realProviderProfiles,
		useProviderProfiles: () => ({
			activeProviderProfile: { id: "p1", name: "OpenAI Pro", defaultModel: "gpt-4o" },
			providerProfiles: [],
			favoriteModelsByProfile: {
				p1: [
					{ modelId: "gpt-4o", label: "GPT-4o", contextLength: 128000 },
					{ modelId: "gpt-3.5", label: "GPT-3.5 (no tools)", contextLength: 16000 },
				],
			},
			handleSelectFavoriteProviderModel,
		}),
}));

// useToolCapableModels is NOT mocked — it is exercised for real against a
// seeded provider-data-store cache (see seedStores). Mocking the hook leaks
// process-globally and clobbers useToolCapableModels.test.ts (AGENTS.md
// mock.module gotcha); driving it through its real cache path tests the
// component + hook integration AND keeps the suite leak-free.

// Send/cancel: the co-author box reuses the chat pipeline, but we don't want a
// real send here — stub the two methods the component calls.
mock.module("../../hooks/use-chat-controller.js", () => ({
		...realChatController,
		useChatController: () => ({
			handleSend,
			handleCancelGeneration,
		}),
}));

// CustomTooltip (Radix) needs a TooltipProvider ancestor the isolated render
// lacks; passthrough keeps the box's children under test. Same pattern as
// CoauthorTopBar.test.
mock.module("../shared/Tooltip.js", () => ({
		...realTooltip,
		CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Chat-actions: only the two the module switch calls are needed. List returns
// two seed modules so the switch dropdown has rows to render + select.
const MODULES: CoauthorModule[] = [
	{ id: "default", name: "Default Co-Author", description: "", basePrompt: "p", openingMessage: "", skillIds: [], toolSet: {}, maxSteps: 5, isBuiltIn: true },
	{ id: "profile-editor", name: "Profile Editor", description: "", basePrompt: "p", openingMessage: "", skillIds: [], toolSet: {}, maxSteps: 3, isBuiltIn: true },
];
// Keep the bindings above the later mock.module registration. MODULES is
// declared above so TS sees it before this destructure.
const listCoauthorModulesAction = mock(() => Promise.resolve(MODULES));
const setCoauthorModuleAction = mock(async (_chatId: string, _moduleId: string | null) => undefined);
mock.module("../../stores/api-actions/chat-actions.js", () => ({
	...realChatActions,
	listCoauthorModulesAction,
	setCoauthorModuleAction,
}));

let CoauthorInputArea: typeof import("./CoauthorInputArea.js").CoauthorInputArea;
beforeAll(async () => {
	({ act, render, fireEvent, waitFor, cleanup } = await import("@testing-library/react"));
	({ CoauthorInputArea } = await import("./CoauthorInputArea.js"));
});

/** Seed the real stores so the box sees a connected provider + an active chat.
 * The provider-data-store cache carries the two test models (gpt-4o tool-capable,
 * gpt-3.5 not) so the REAL useToolCapableModels hook filters without a fetch. */
function seedStores() {
	useChatStore.setState({ activeChatId: "chat1", draft: "" } as never);
	useProviderStore.setState({
		connection: { ...useProviderStore.getState().connection, status: "connected", model: "gpt-4o" },
	});
	useSnapshotStore.setState({
		activeChat: {
			id: "chat1",
			characterId: "char1",
			mode: "coauthor",
			coauthorModuleId: null,
			coauthorContextLinks: [],
		} as never,
	});
	// Cache two models on profile p1: gpt-4o advertises tools, gpt-3.5 does not.
	// The hook reads profile.cachedModels.models and keeps only tool-capable ones.
	useProviderDataStore.setState({
		profiles: [
			{
				id: "p1",
				cachedModels: {
					models: [
						{ id: "gpt-4o", label: "GPT-4o", contextLength: 128000, capabilities: { tools: true } },
						{ id: "gpt-3.5", label: "GPT-3.5 (no tools)", contextLength: 16000, capabilities: { tools: false } },
					],
				},
			} as never,
		],
	});
}

describe("CoauthorInputArea", () => {

	beforeEach(() => {
		listCoauthorModulesAction.mockReturnValue(Promise.resolve(MODULES));
		setCoauthorModuleAction.mockClear();
		seedStores();
	});

	it("renders the quick module switch + favorites pill, not the RP affordances", async () => {
		const { getByTestId, queryByText, getByRole } = render(<CoauthorInputArea />);
		// Module switch + favorites pill present.
		expect(getByTestId("coauthor-module-switch")).toBeDefined();
		expect(getByTestId("coauthor-favorites-pill")).toBeDefined();
		// RP-only affordances absent: persona switch, AI impersonation, preset.
		expect(queryByText("speak_as")).toBeNull();
		expect(queryByText("multi_persona_tooltip")).toBeNull();
		expect(queryByText("topbar_prompt_preset")).toBeNull();
		// Behavior change: no clip -> shared clip; owner 2026-09-30 Co-Author attachments.
		expect(getByRole("button", { name: "attach_image" })).toBeDefined();
		// useModuleSwitch fires an async module-list load on mount; drain its
		// trailing setModules/setLoading so they don't warn about a state update
		// outside act(). One macrotask flushes the whole .then/.finally chain.
		await act(async () => { await new Promise((r) => setTimeout(r)); });
	});

	it("fails closed with a choose-model prompt and disabled model picker when no Co-Author binding exists", async () => {
		const { getByTestId } = render(<CoauthorInputArea />);
		expect((getByTestId("coauthor-favorites-pill") as HTMLButtonElement).disabled).toBe(true);
		expect((getByTestId("coauthor-send-btn") as HTMLButtonElement).disabled).toBe(true);
		expect((getByTestId("coauthor-input-textarea") as HTMLTextAreaElement).placeholder).toBe("coauthor.input.choose_model");
		await act(async () => { await new Promise((resolve) => setTimeout(resolve)); });
	});
});

const textFile: Attachment = { id: "file", assetId: "asset-file", name: "notes.md", type: "file", mimeType: "text/markdown", sizeBytes: 12, tokenCount: 42 };
function seedReady() {
  seedStores();
  useBootstrapStore.setState({ data: {
    initialChatId: null, snapshot: null, isFirstRun: false, allCharacters: [], promptPresets: [], agentKindSettings: {}, isArmServer: false,
    uiSettings: { ...wireUiSettings(), coauthorProviderId: "p1" },
  } });
  useProviderDataStore.setState({
    profiles: [{ ...wireProviderProfile(), id: "p1", defaultModel: "gpt-4o", cachedModels: { cachedAt: "0", models: [{ id: "gpt-4o", label: "GPT-4o", contextLength: 128000, capabilities: { tools: true } }] } }],
    coauthorFavoritesByProfile: { p1: [] },
    coauthorSettingsByProfile: { p1: { providerProfileId: "p1", modelName: "gpt-4o", settings: { contextBudget: 6000, maxTokens: 1000 }, createdAt: "0", updatedAt: "0" } },
  });
  handleSend.mockClear();
}
function pasted(files: File[]) {
  return { clipboardData: { items: files.map((file) => ({ kind: "file", getAsFile: () => file })) } };
}
async function composer() {
  const view = render(<CoauthorInputArea />);
  await waitFor(() => expect(listCoauthorModulesAction).toHaveBeenCalled());
  return view;
}

describe("CoauthorInputArea attachments (CA-3b)", () => {
  beforeEach(seedReady);

  it("paperclip opens the multiple picker, accepts only images/text and uses RP chrome before the counter", async () => {
    const view = await composer();
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = spyOn(input, "click");
    spies.push(click);
    const clip = view.getByRole("button", { name: "attach_image" });
    fireEvent.click(clip);
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain(".md");
    expect(input.accept).toContain("image/png");
    expect(input.accept).not.toMatch(/audio|video/);
    expect(clip.className).toBe("flex h-[26px] w-[26px] items-center justify-center rounded-md text-t3 transition-colors hover:bg-s2 hover:text-t1 disabled:opacity-45");
    expect(clip.parentElement?.firstElementChild).toBe(clip);
  });

  it("pasted image and markdown upload through the shared hook and render removable previews", async () => {
    const upload = spyOn(assets, "uploadAsset").mockResolvedValueOnce({ assetId: "image", url: "image" }).mockResolvedValueOnce({ assetId: "file", url: "file", tokenCount: 42 });
    spies.push(upload);
    const view = await composer();
    fireEvent.paste(view.getByTestId("coauthor-input-textarea"), pasted([new File(["png"], "capture.png", { type: "image/png" }), new File(["notes"], "notes.md", { type: "" })]));
    await waitFor(() => expect(useChatStore.getState().draftAttachments).toHaveLength(2));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(view.getByAltText("capture.png")).toBeDefined();
    expect(view.getByTitle("notes.md")).toBeDefined();
    expect(useChatStore.getState().draftAttachments[1]).toMatchObject({ type: "file", mimeType: "text/markdown", tokenCount: 42 });
    fireEvent.click(view.getByTestId("file-attachment-chip").querySelector("button")!);
    expect(useChatStore.getState().draftAttachments).toHaveLength(1);
  });

  it("desktop drag overlay and multi-file drop use the common handlers", async () => {
    const upload = spyOn(assets, "uploadAsset").mockResolvedValue({ assetId: "file", url: "file", tokenCount: 42 });
    spies.push(upload);
    const view = await composer();
    const container = view.container.firstElementChild!;
    fireEvent.dragOver(container, { dataTransfer: { types: ["Files"] } });
    expect(view.getByText("drop_image_here")).toBeDefined();
    fireEvent.drop(container, { dataTransfer: { files: [new File(["md"], "a.md"), new File(["json"], "b.json")] } });
    await waitFor(() => expect(useChatStore.getState().draftAttachments).toHaveLength(2));
    expect(view.queryByText("drop_image_here")).toBeNull();
    expect(view.getAllByTestId("file-attachment-chip")).toHaveLength(2);
  });

  it("audio and video picked or dropped are refused before upload", async () => {
    const upload = spyOn(assets, "uploadAsset");
    const error = spyOn(toast, "error").mockImplementation(() => "toast");
    spies.push(upload, error);
    const view = await composer();
    const input = view.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["voice"], "a.webm", { type: "audio/webm" })] } });
    fireEvent.drop(view.container.firstElementChild!, { dataTransfer: { files: [new File(["video"], "a.mp4", { type: "video/mp4" })] } });
    expect(error).toHaveBeenCalledWith("unsupported_attachment_format");
    expect(error).toHaveBeenCalledTimes(2);
    expect(upload).not.toHaveBeenCalled();
    expect(useChatStore.getState().draftAttachments).toEqual([]);
  });

  it("attachment-only draft enables send; the Co-Author budget warning never blocks it", async () => {
    const view = await composer();
    expect((view.getByTestId("coauthor-send-btn") as HTMLButtonElement).disabled).toBe(true);
    act(() => useChatStore.getState().addDraftAttachment({ ...textFile, tokenCount: 5001 }));
    expect(view.getByText("attachments_overflow_warning")).toBeDefined();
    expect((view.getByTestId("coauthor-send-btn") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByTestId("coauthor-send-btn"));
    expect(handleSend).toHaveBeenCalledTimes(1);
    act(() => useChatStore.getState().clearDraftAttachments());
    expect(view.queryByText("attachments_overflow_warning")).toBeNull();
  });

  it("picker attaches multiple files and the clip disables at the shared five-file limit", async () => {
    const upload = spyOn(assets, "uploadAsset").mockResolvedValue({ assetId: "file", url: "file", tokenCount: 42 });
    spies.push(upload);
    const view = await composer();
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: Array.from({ length: 5 }, (_, i) => new File(["md"], `${i}.md`)) } });
    await waitFor(() => expect(useChatStore.getState().draftAttachments).toHaveLength(5));
    expect((view.getByRole("button", { name: "attach_image" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a sent Co-Author user file reaches the existing CA-2c chip and dropdown through CoauthorMessageBlock", async () => {
    spies.push(spyOn(voiceMap, "useVoiceMapData").mockReturnValue({ data: null, refresh: async () => {} }));
    const { CoauthorMessageBlock } = await import("./CoauthorMessageBlock.js");
    const message: AppMessage = {
      id: brandId<MessageId>("sent"), chatId: brandId<ChatId>("chat1"), branchId: brandId<ChatBranchId>("branch"),
      role: "user", authorType: "user", position: 0, content: "Read this", state: "complete", createdAt: "0", updatedAt: "0",
      variants: [], selectedVariantIndex: null, modelId: null, sceneTracker: null, coauthorModuleId: null, coauthorSkillId: null, attachments: [textFile],
    };
    useSnapshotStore.setState({ character: wireCharacter(), messagesById: { sent: message } });
    const view = render(<CoauthorMessageBlock messageId="sent" index={0} isFirstAssistant={false} isLast prevRole={null} />);
    expect(view.getByTestId("file-attachment-chip")).toBeDefined();
    await userEvent.setup().click(view.getByRole("button", { name: "attachment_file_actions" }));
    await waitFor(() => expect(view.getByRole("menuitem", { name: "attachment_summarize" })).toBeDefined());
  });
});
