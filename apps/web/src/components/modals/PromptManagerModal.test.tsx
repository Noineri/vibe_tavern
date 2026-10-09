import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
/**
 * buildDuplicatePayload — deep-copy characterization.
 *
 * Pins the fix for PRESET_COPY_DELETE_CORRUPTION bug 1: the "Duplicate" create
 * payload must NOT share mutable array/object references (`promptOrder`,
 * `customInjections`, `aiAssistantPrompts`) with the live source draft. The
 * former shallow `{...draft}` spread aliased those nested values, letting edits
 * to the copy leak back into the source's in-memory state. The pure helper is
 * exported precisely so this invariant has a direct unit test (no RTL render).
 */
import { afterEach, beforeAll, describe, expect, jest, mock, test } from "bun:test";
import type { ReactNode } from "react";
import React from "react";
import type { CustomInjection, PromptOrderEntry, PromptPresetDto } from "@vibe-tavern/domain";
import { SERVICE_PROMPT_FIELD_KEYS, type ServicePromptFieldKey } from "@vibe-tavern/domain";
import { serializeStPreset, type RegexScriptImportDraft } from "@vibe-tavern/import-export";
import {
  createPresetRegexProfile,
  createPresetWithRegexProfile,
  summarizeRegexImportRules,
} from "./preset-import-flow.js";
import type {
  ImagePromptFamilyInfoValue,
  ImagePromptTemplateRowKeyValue,
  ImagePromptProfileDetailResponse,
  ServicePromptProfile,
} from "@vibe-tavern/api-contracts";
import type { RegexPresetRecord, RegexProfileRecord } from "../../api/types.js";
import { brandId, type RegexPresetId, type RegexProfileId } from "@vibe-tavern/domain";
import type { DraftData } from "./PromptManagerModal.js";
import { useModalStore } from "../../stores/modal-store.js";
import { makeRegexProfileAssignmentHandler } from "../settings/prompt/regex-profile-assignment.js";

class TestBoundary extends React.Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(_error: unknown, _info: { componentStack: string }) {}
  render() { return this.props.children; }
}

const realI18nContext = await import("../../i18n/context.js");
const realTokenizer = await import("../../utils/tokenizer.js");
const realUseMobile = await import("../../hooks/use-mobile.js");
const realMasterDetail = await import("../shared/MasterDetailModal.js");
const realTooltip = await import("../shared/Tooltip.js");
const realPromptCanvasLore = await import("../../lib/prompt-canvas-lore.js");
const loadPromptCanvasLoreEntries = mock(realPromptCanvasLore.loadPromptCanvasLoreEntries);
const realRegexApi = await import("../../api/regex-api.js");
const listAllRegexPresetsMock = mock(realRegexApi.listAllRegexPresets);
const createRegexPresetMock = mock(realRegexApi.createRegexPreset);
const createRegexProfileBundleMock = mock(async (body: Parameters<typeof realRegexApi.createRegexProfileBundle>[0]) => ({
  profile: { id: "prof_bundle", name: body?.name ?? "Bundle", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 },
  rules: [],
}) as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfileBundle>>);
const listAllRegexProfilesMock = mock(async () => [] as unknown as Awaited<ReturnType<typeof realRegexApi.listAllRegexProfiles>>);
const createRegexProfileMock = mock(async (body: unknown) => ({ id: "p_new", name: (body as { name?: string })?.name ?? "new", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 } as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfile>>));
const attachRegexRuleMock = mock(async (_a: unknown, _b: unknown) => null as unknown as Awaited<ReturnType<typeof realRegexApi.attachRegexRule>>);
const detachRegexRuleMock = mock(async (_id: unknown) => null as unknown as Awaited<ReturnType<typeof realRegexApi.detachRegexRule>>);
const getRegexProfileLinksMock = mock(async () => [] as unknown as Awaited<ReturnType<typeof realRegexApi.getRegexProfileLinks>>);
const updateRegexProfileMock = mock(async (id: string, body: { name?: string; disabled?: boolean; isGlobal?: boolean; sortOrder?: number }) => {
  // Merge over a base record so every field stays a primitive (a naive
  // `body ?? fallback` returns the WHOLE body object when the field is
  // absent — an object then flows into state and React crashes rendering it).
  return {
    id,
    name: typeof body?.name === "string" ? body.name : "Bundle",
    disabled: typeof body?.disabled === "boolean" ? body.disabled : false,
    isGlobal: typeof body?.isGlobal === "boolean" ? body.isGlobal : true,
    sortOrder: typeof body?.sortOrder === "number" ? body.sortOrder : 0,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Awaited<ReturnType<typeof realRegexApi.updateRegexProfile>>;
});
const deleteRegexProfileMock = mock(async () => undefined as unknown as Awaited<ReturnType<typeof realRegexApi.deleteRegexProfile>>);
const setRegexProfileLinksMock = mock(async () => [] as unknown as Awaited<ReturnType<typeof realRegexApi.setRegexProfileLinks>>);
const realServiceApi = await import("../../api/service-prompt-api.js");
const listServiceProfilesMock = mock(realServiceApi.listServicePromptProfiles);
const getServiceDetailMock = mock(realServiceApi.getServicePromptProfileDetail);
const realImageGenApi = await import("../../api/image-gen-api.js");
const listImagePromptTemplatesMock = mock(async () => makeImagePromptTemplates());
const listImagePromptFamiliesMock = mock(realImageGenApi.listImagePromptFamilies);
const realDownload = await import("../../lib/download.js");
const downloadTextFileMock = mock(realDownload.downloadTextFile);
// RXU-21: the bundle-failure toast is part of the surfaced failure contract —
// captured (not asserted) for every other test in this file.
const realSonner = await import("sonner");
const toastErrorMock = mock(() => {});
mock.module("sonner", () => ({ ...realSonner, toast: { ...realSonner.toast, error: toastErrorMock } }));

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === "promptManager.regex.profileMemberCount" ? `${key}:${options?.count ?? 0}` : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../utils/tokenizer.js", () => ({ ...realTokenizer, countTokens: () => 0 }));
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
mock.module("../shared/MasterDetailModal.js", () => {
  return {
    ...realMasterDetail,
    MasterDetailMobileDrillDown: (props: { onSelect: () => void }) => <button onClick={() => props.onSelect()}>drill</button>,
  };
});
mock.module("../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));
mock.module("../../lib/prompt-canvas-lore.js", () => ({
  ...realPromptCanvasLore,
  loadPromptCanvasLoreEntries,
}));
mock.module("../../api/regex-api.js", () => {
  return {
    ...realRegexApi,
    listAllRegexPresets: listAllRegexPresetsMock,
    createRegexPreset: createRegexPresetMock,
    createRegexProfileBundle: createRegexProfileBundleMock,
    listAllRegexProfiles: listAllRegexProfilesMock,
    createRegexProfile: createRegexProfileMock,
    attachRegexRule: attachRegexRuleMock,
    detachRegexRule: detachRegexRuleMock,
    getRegexProfileLinks: getRegexProfileLinksMock,
    updateRegexProfile: updateRegexProfileMock,
    deleteRegexProfile: deleteRegexProfileMock,
    setRegexProfileLinks: setRegexProfileLinksMock,
  };
});
mock.module("../../api/service-prompt-api.js", () => {
  return {
    ...realServiceApi,
    listServicePromptProfiles: listServiceProfilesMock,
    getServicePromptProfileDetail: getServiceDetailMock,
  };
});
mock.module("../../api/image-gen-api.js", () => ({
  ...realImageGenApi,
  listImagePromptTemplates: listImagePromptTemplatesMock,
  listImagePromptFamilies: listImagePromptFamiliesMock,
}));
const realImageProfileApi = await import("../../api/image-prompt-profile-api.js");
const listImagePromptProfilesMock = mock(realImageProfileApi.listImagePromptProfiles);
const getImagePromptProfileDetailMock = mock(realImageProfileApi.getImagePromptProfileDetail);
mock.module("../../api/image-prompt-profile-api.js", () => ({
  ...realImageProfileApi,
  listImagePromptProfiles: listImagePromptProfilesMock,
  getImagePromptProfileDetail: getImagePromptProfileDetailMock,
}));
mock.module("../../lib/download.js", () => ({
  ...realDownload,
  downloadTextFile: downloadTextFileMock,
}));

const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");

let PromptManagerModal: typeof import("./PromptManagerModal.js").PromptManagerModal;
let buildDuplicatePayload: typeof import("./PromptManagerModal.js").buildDuplicatePayload;

beforeAll(async () => {
  ({ PromptManagerModal, buildDuplicatePayload } = await import("./PromptManagerModal.js"));
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => {});
  cleanup();
  loadPromptCanvasLoreEntries.mockReset();
  listAllRegexPresetsMock.mockReset();
  createRegexPresetMock.mockReset();
  createRegexProfileBundleMock.mockReset();
  createRegexProfileBundleMock.mockImplementation(async (body: Parameters<typeof realRegexApi.createRegexProfileBundle>[0]) => ({
    profile: { id: "prof_bundle", name: body?.name ?? "Bundle", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 },
    rules: [],
  }) as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfileBundle>>);
  listAllRegexProfilesMock.mockReset();
  listAllRegexProfilesMock.mockResolvedValue([]);
  createRegexProfileMock.mockReset();
  createRegexProfileMock.mockResolvedValue({ id: "p_new", name: "new", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 } as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfile>>);
  attachRegexRuleMock.mockReset();
  detachRegexRuleMock.mockReset();
  getRegexProfileLinksMock.mockReset();
  getRegexProfileLinksMock.mockResolvedValue([]);
  updateRegexProfileMock.mockReset();
  updateRegexProfileMock.mockImplementation(async (id: string, body: { name?: string; disabled?: boolean; isGlobal?: boolean; sortOrder?: number }) =>
    ({
      id,
      name: typeof body?.name === "string" ? body.name : "Bundle",
      disabled: typeof body?.disabled === "boolean" ? body.disabled : false,
      isGlobal: typeof body?.isGlobal === "boolean" ? body.isGlobal : true,
      sortOrder: typeof body?.sortOrder === "number" ? body.sortOrder : 0,
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as Awaited<ReturnType<typeof realRegexApi.updateRegexProfile>>
  );
  deleteRegexProfileMock.mockReset();
  deleteRegexProfileMock.mockResolvedValue(undefined);
  setRegexProfileLinksMock.mockReset();
  setRegexProfileLinksMock.mockResolvedValue([]);
  listServiceProfilesMock.mockReset();
  getServiceDetailMock.mockReset();
  listImagePromptTemplatesMock.mockReset();
  listImagePromptTemplatesMock.mockResolvedValue(makeImagePromptTemplates());
  listImagePromptFamiliesMock.mockReset();
  listImagePromptFamiliesMock.mockResolvedValue({ families: imagePromptFamilies });
  listImagePromptProfilesMock.mockReset();
  listImagePromptProfilesMock.mockResolvedValue(makeImagePromptProfileList());
  getImagePromptProfileDetailMock.mockReset();
  getImagePromptProfileDetailMock.mockImplementation(async (id: string) => makeImagePromptProfileDetail(id));
  downloadTextFileMock.mockReset();
  toastErrorMock.mockReset();
  useModalStore.setState({ isPromptManagerOpen: false });
});

const imagePromptFamilies: ImagePromptFamilyInfoValue[] = [
  { id: "prose", grammar: "prose", ownTemplates: true, ownNegative: true, ownQuality: false, hasAssistAddendum: false },
  { id: "pony", grammar: "tags", ownTemplates: true, ownNegative: true, ownQuality: true, hasAssistAddendum: true },
];

const imagePromptRows: ImagePromptTemplateRowKeyValue[] = [
  "scene-background",
  "portrait",
  "character",
  "user-persona",
  "scene-illustration",
  "free",
  "selfie",
  "avatar",
  "negative",
];

function makeImagePromptTemplates(): ImagePromptProfileDetailResponse["catalog"] {
  return {
    cells: imagePromptRows.flatMap((rowKey) => imagePromptFamilies.map((family) => ({
      rowKey,
      family: family.id,
      canonText: `canon ${rowKey} ${family.id}`,
      canonSource: family.id === "prose" ? "family-canon" as const : "prose-canon" as const,
      customText: null,
      qualityText: null,
      isCustomized: false,
    }))),
    qualityCanon: { pony: "canon quality pony" },
    assist: { core: "assist core", addenda: { pony: "pony addendum" } },
  };
}

/** IF-1d: the images tab loads through the image prompt PROFILE api — a
 *  read-only Default plus one live non-default profile (the editor surface). */
function makeImagePromptProfileList() {
  return {
    profiles: [
      { id: "default", name: "Default", isDefault: true, sortOrder: 0, overrides: {}, createdAt: "", updatedAt: "" },
      { id: "ipp1", name: "My Profile", isDefault: false, sortOrder: 1, overrides: {}, createdAt: "", updatedAt: "" },
    ],
    activeProfileId: "ipp1",
  };
}

function makeImagePromptProfileDetail(id: string) {
  const templates = makeImagePromptTemplates();
  const isDefault = id === "default";
  return {
    profile: { id, name: isDefault ? "Default" : "My Profile", isDefault, sortOrder: isDefault ? 0 : 1, overrides: {}, createdAt: "", updatedAt: "" },
    catalog: templates,
  };
}

function baseDraft(): DraftData {
  return {
    name: "Source",
    system: "sys",
    jailbreak: "jb",
    prefill: "pf",
    authorsNote: "an",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
    perSendPrefillEnabled: false,
    summary: "",
    tools: "",
    nsfw: "",
    enhanceDefinitions: "",
    scriptAiSystemPrompt: "",
    aiAssistantPrompts: { vision: "describe", lore: "expand" },
    customInjections: [{ identifier: "inj_1", name: "Inj", content: "c", role: "system" }],
    promptOrder: [{ identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" }],
    advancedMode: false,
    mergeConsecutiveRoles: false,
    generationFormat: null,
  };
}

function advancedPreset(): PromptPresetDto {
  const { generationFormat, ...fields } = baseDraft();
  return {
    ...fields,
    id: "preset-1",
    advancedMode: true,
    perSendPrefillEnabled: false,
    aiAssistantPrompts: JSON.stringify(fields.aiAssistantPrompts),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

describe("PromptManagerModal — character save boundary", () => {
  test("persists an edited character V3 canvas field only after preset save succeeds", async () => {
    const onUpdate = mock(async () => true);
    const onCharacterFieldUpdate = mock();
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        characterFields={{
          systemPrompt: "old character system",
          postHistoryInstructions: "",
          depthPrompt: "",
          depthPromptDepth: 4,
          depthPromptRole: "system",
          description: "old description",
          personalitySummary: "old personality",
          scenario: "old scenario",
          mesExample: "old examples",
        }}
        onCharacterFieldUpdate={onCharacterFieldUpdate}
      />,
    );

    const card = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="charSystemPrompt"]');
    expect(card).toBeTruthy();
    fireEvent.click(within(card!).getByText("character_system_prompt"));
    const textarea = within(card!).getByRole("textbox");
    fireEvent.input(textarea, { target: { value: "new character system" } });
    const saveButton = within(view.baseElement).getByRole("button", { name: "save" });
    await waitFor(() => expect(saveButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onCharacterFieldUpdate).toHaveBeenCalledWith("charSystemPrompt", "new character system");
    });
  });

  test("persists the consecutive-role merge checkbox through the preset update patch", async () => {
    const onUpdate = mock(async () => true);
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );

    fireEvent.click(within(view.baseElement).getByRole("checkbox", { name: "merge_consecutive_roles" }));
    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        "preset-1",
        expect.objectContaining({ mergeConsecutiveRoles: true }),
      );
    });
  });

  test("the accordion-era header block is gone; the canon SegmentedControl alone carries the mode", async () => {
    useModalStore.setState({ isPromptManagerOpen: true });

    const simplePreset: PromptPresetDto = { ...advancedPreset(), advancedMode: false };
    const view = render(
      <PromptManagerModal
        presets={[simplePreset]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    const q = within(view.baseElement);

    // Owner 2026-09-19: the mode TITLE duplicated the control's selected
    // segment, the advanced HINT duplicated the canvas's own header, and the
    // simple-mode MERGE NOTE described assembly behavior implicitly — the
    // whole accordion shell is deleted; the segmented control is the only
    // mode surface. (The switch itself still works: Radix radios.)
    await waitFor(() => {
      expect(q.getByRole("radio", { name: "preset_simple_mode_short" })).toBeTruthy();
    });
    for (const legacy of [
      "preset_simple_mode",
      "preset_advanced_mode",
      "preset_simple_mode_hint",
      "preset_advanced_mode_hint",
      "preset_simple_mode_merge_note",
      "prompt_section_chat",
    ]) {
      expect(q.queryByText(legacy), `legacy header text "${legacy}"`).toBeNull();
    }

    // Simple: chat fields render, canvas does not.
    expect(q.getByText("system_prompt")).toBeTruthy();
    expect(q.queryByTestId("prompt-canvas-header")).toBeNull();

    // Switch to advanced: the canvas (with its OWN header hint — the single
    // explanation surface now) appears and the control reflects the mode.
    // (The simple fields' disappearance is PromptFields' own pinned contract
    // — "renders nothing when hideChatPrompts is set" — not re-pinned here;
    // canvas cards legitimately reuse field labels like system_prompt.)
    fireEvent.click(q.getByRole("radio", { name: "preset_advanced_mode_short" }));
    await waitFor(() => {
      expect(q.getByTestId("prompt-canvas-header")).toBeTruthy();
      expect(q.getByText("preset_prompt_order_canvas_hint")).toBeTruthy();
    });
    expect(q.getByRole("radio", { name: "preset_advanced_mode_short" }).getAttribute("aria-checked")).toBe("true");
    expect(q.getByRole("radio", { name: "preset_simple_mode_short" }).getAttribute("aria-checked")).toBe("false");
  });

  test("loads active-chat lore summaries into the expandable anchor card", async () => {
    loadPromptCanvasLoreEntries.mockResolvedValueOnce([{
      id: "entry-1",
      lorebookId: "book-1",
      lorebookName: "Character Lore",
      title: "Before Entry",
      position: "before_char",
      priority: 10,
      sortOrder: 0,
    }]);
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        loreContext={{ chatId: "chat-1", characterId: "char-1", personaId: "persona-1" }}
      />,
    );

    await waitFor(() => {
      expect(loadPromptCanvasLoreEntries).toHaveBeenCalledWith({
        chatId: "chat-1",
        characterId: "char-1",
        personaId: "persona-1",
      });
    });
    const anchor = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="worldInfoBefore"]');
    expect(anchor).toBeTruthy();
    fireEvent.click(within(anchor!).getByText("prompt_slot_world_info_before"));
    await waitFor(() => {
      expect(within(anchor!).getByText("Before Entry")).toBeTruthy();
      expect(within(anchor!).getByText("Character Lore")).toBeTruthy();
    });
  });

  test("routes edited character content and persona description after preset save", async () => {
    const onUpdate = mock(async () => true);
    const onCharacterFieldUpdate = mock();
    const onPersonaDescriptionUpdate = mock();
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        characterFields={{
          systemPrompt: "",
          postHistoryInstructions: "",
          depthPrompt: "",
          depthPromptDepth: 4,
          depthPromptRole: "system",
          description: "old description",
          personalitySummary: "old personality",
          scenario: "old scenario",
          mesExample: "old examples",
        }}
        onCharacterFieldUpdate={onCharacterFieldUpdate}
        personaDescription="old persona"
        onPersonaDescriptionUpdate={onPersonaDescriptionUpdate}
      />,
    );

    const characterCard = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="charDescription"]');
    expect(characterCard).toBeTruthy();
    fireEvent.click(within(characterCard!).getByText("prompt_slot_character_description"));
    fireEvent.change(within(characterCard!).getByRole("textbox"), {
      target: { value: "new description" },
    });

    const personaCard = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="personaDescription"]');
    expect(personaCard).toBeTruthy();
    fireEvent.click(within(personaCard!).getByText("prompt_slot_persona"));
    fireEvent.change(within(personaCard!).getByRole("textbox"), {
      target: { value: "new persona" },
    });

    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onCharacterFieldUpdate).toHaveBeenCalledWith("charDescription", "new description");
      expect(onPersonaDescriptionUpdate).toHaveBeenCalledWith("new persona");
    });
  });
});

describe("buildDuplicatePayload — deep-copy (PRESET_COPY_DELETE_CORRUPTION bug 1)", () => {
  test("payload does not share mutable array/object refs with the source draft", () => {
    const source = baseDraft();
    const payload = buildDuplicatePayload(source, "Presets");

    // The clone produced fresh containers (different identity, not the source refs).
    expect(payload.promptOrder).not.toBe(source.promptOrder);
    expect(payload.customInjections).not.toBe(source.customInjections);

    // Mutating the payload's nested arrays must NOT touch the source — the
    // aliasing that caused copy-edits to leak into the original is gone.
    payload.promptOrder.push({ identifier: "jailbreak", enabled: false, order: 1, zone: "after_chat", depth: null, kind: "built_in" });
    payload.customInjections.push({ identifier: "inj_2", name: "X", content: "y", role: "user" });
    expect(source.promptOrder).toHaveLength(1);
    expect(source.customInjections).toHaveLength(1);

    // aiAssistantPrompts is stringified to JSON (DTO contract) — a string, not the source record ref.
    expect(typeof payload.aiAssistantPrompts).toBe("string");
    expect(payload.aiAssistantPrompts).toBe(JSON.stringify({ vision: "describe", lore: "expand" }));
  });

  test("name carries the source name + (copy) suffix, falling back to the supplied label when empty", () => {
    expect(buildDuplicatePayload(baseDraft(), "Presets").name).toBe("Source (copy)");
    const blank = baseDraft();
    blank.name = "";
    expect(buildDuplicatePayload(blank, "Presets").name).toBe("Presets (copy)");
  });

  test("field content is preserved through the deep copy", () => {
    const source = baseDraft();
    const payload = buildDuplicatePayload(source, "Presets");
    expect(payload.system).toBe("sys");
    expect(payload.promptOrder[0]).toEqual(source.promptOrder[0]);
    expect(payload.customInjections[0]).toEqual(source.customInjections[0]);
  });

  test("CustomInjection/PromptOrderEntry typings used above are the domain shapes (compile-time guard)", () => {
    const _inj: CustomInjection = { identifier: "x", name: "y", content: "z", role: "assistant" };
    const _po: PromptOrderEntry = { identifier: "x", enabled: true, order: 0, zone: "in_chat", depth: 1, kind: "custom" };
    expect([_inj.identifier, _po.identifier]).toEqual(["x", "x"]);
  });
});

describe("PromptManagerModal — chatDynamicPrompt save (Wave 6)", () => {
  test("does NOT call onChatDynamicPromptUpdate when chatDynamicPrompt is unchanged", async () => {
    const onUpdate = mock(async () => true);
    const onChatDynamicPromptUpdate = mock(async () => {});
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        chatDynamicPrompt="existing"
        onChatDynamicPromptUpdate={onChatDynamicPromptUpdate}
      />,
    );

    // Toggle the consecutive-role merge checkbox to trigger dirty
    // (so the save button is enabled), but keep chatDynamicPrompt unchanged.
    fireEvent.click(within(view.baseElement).getByRole("checkbox", { name: "merge_consecutive_roles" }));

    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled();
    });
    // chatDynamicPromptDraft (initialised to "existing") === input.chatDynamicPrompt ("existing") → no call.
    expect(onChatDynamicPromptUpdate).not.toHaveBeenCalled();
  });

  test("waits for a successful preset save before updating the chat dynamic prompt", async () => {
    let resolvePresetSave: ((ok: boolean) => void) | undefined;
    const onUpdate = mock(() => new Promise<boolean>((resolve) => { resolvePresetSave = resolve; }));
    const onChatDynamicPromptUpdate = mock(async () => {});
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        chatDynamicPrompt="old"
        onChatDynamicPromptUpdate={onChatDynamicPromptUpdate}
      />,
    );

    const card = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="chatDynamicPrompt"]');
    expect(card).toBeTruthy();
    if (!card) return;
    fireEvent.click(within(card).getByText("prompt_slot_chat_dynamic"));
    fireEvent.change(within(card).getByRole("textbox"), { target: { value: "new content" } });
    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    expect(onUpdate).toHaveBeenCalled();
    expect(onChatDynamicPromptUpdate).not.toHaveBeenCalled();
    expect(resolvePresetSave).toBeDefined();
    resolvePresetSave?.(true);

    await waitFor(() => {
      expect(onChatDynamicPromptUpdate).toHaveBeenCalledWith("new content");
    });
  });

  test("does not update the chat dynamic prompt when the preset save fails", async () => {
    const onChatDynamicPromptUpdate = mock(async () => {});
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => false)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        chatDynamicPrompt="old"
        onChatDynamicPromptUpdate={onChatDynamicPromptUpdate}
      />,
    );

    const card = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="chatDynamicPrompt"]');
    expect(card).toBeTruthy();
    if (!card) return;
    fireEvent.click(within(card).getByText("prompt_slot_chat_dynamic"));
    fireEvent.change(within(card).getByRole("textbox"), { target: { value: "new content" } });
    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(onChatDynamicPromptUpdate).not.toHaveBeenCalled();
      const retry = within(view.baseElement).getByRole("button", { name: "save" }) as HTMLButtonElement;
      expect(retry.disabled).toBe(false);
    });
  });

  test("rejected onChatDynamicPromptUpdate is caught and does not crash the save flow", async () => {
    // The save handler uses try/catch around the awaited onChatDynamicPromptUpdate.
    // Even when the update rejects, the handler itself must not throw — it should
    // catch, set error state, and return without calling setDirty(false).
    const onUpdate = mock(async () => true);
    let rejected = false;
    const onChatDynamicPromptUpdate = mock(async () => {
      rejected = true;
      throw new Error("offline");
    });
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        chatDynamicPrompt="old"
        onChatDynamicPromptUpdate={onChatDynamicPromptUpdate}
      />,
    );

    const card = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="chatDynamicPrompt"]');
    fireEvent.click(within(card!).getByText("prompt_slot_chat_dynamic"));
    fireEvent.change(within(card!).getByRole("textbox"), { target: { value: "changed" } });

    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled();
      expect(onChatDynamicPromptUpdate).toHaveBeenCalled();
    });
    // The rejection was caught, the draft remains dirty, and Save is available
    // for retry rather than falsely changing to the "saved" state.
    expect(rejected).toBe(true);
    await waitFor(() => {
      const retry = within(view.baseElement).getByRole("button", { name: "save" }) as HTMLButtonElement;
      expect(retry.disabled).toBe(false);
      expect(within(view.baseElement).queryByRole("button", { name: "saved" })).toBeNull();
    });
  });

  test("null onChatDynamicPromptUpdate is handled gracefully (no-op)", async () => {
    const onUpdate = mock(async () => true);
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={onUpdate}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
        chatDynamicPrompt="old"
        // onChatDynamicPromptUpdate intentionally omitted (undefined)
      />,
    );

    // Edit to trigger a change.
    const card = view.baseElement.querySelector<HTMLElement>('[data-canvas-identifier="chatDynamicPrompt"]');
    fireEvent.click(within(card!).getByText("prompt_slot_chat_dynamic"));
    fireEvent.change(within(card!).getByRole("textbox"), { target: { value: "changed" } });

    // Save should not crash — the optional ?.call handles the undefined case.
    fireEvent.click(within(view.baseElement).getByRole("button", { name: "save" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled();
    });
  });
});

/**
 * R-1 regression (REGEX_V13_FOLLOWUP): the regex tab's lazy-load effect must
 * actually populate the list when the regex tab becomes active. The original
 * bug: the effect had `regexLoadState` in its deps AND called
 * `setRegexLoadState("loading")` itself, so its own setState re-triggered the
 * cleanup (`cancelled = true`), killing the only in-flight fetch; the re-run
 * then early-returned on the `!== "idle"` guard. State pinned at "loading",
 * list empty forever — unconditionally, production included.
 */
describe("PromptManagerModal — regex tab lazy-load (R-1)", () => {
  function regexRecord(id: string, name: string): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id),
      name,
      findRegex: "/x+/g",
      replaceString: "",
      trimStrings: [],
      substituteRegex: 0,
      disabled: false,
      markdownOnly: false,
      promptOnly: true,
      runOnEdit: false,
      minDepth: null,
      maxDepth: null,
      placement: [2],
      isGlobal: false,
      sortOrder: 0,
      profileId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  test("switching to the regex tab populates the preset list", async () => {
    listAllRegexPresetsMock.mockResolvedValue([
      regexRecord("rx_a", "Alpha Strip"),
      regexRecord("rx_b", "Beta Wrap"),
    ]);
    useModalStore.setState({ isPromptManagerOpen: true });

    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );

    // Switch to the regex tab (SegmentedControl segment labelled by its i18n key).
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));

    await waitFor(() => {
      expect(listAllRegexPresetsMock).toHaveBeenCalled();
      expect(within(view.baseElement).getByText("Alpha Strip")).toBeTruthy();
      expect(within(view.baseElement).getByText("Beta Wrap")).toBeTruthy();
    });
  });
});

// ── R-12: copy (duplicate in place) & export (standalone ST JSON) ───────
describe("PromptManagerModal — regex copy & export (R-12)", () => {
  function fullRecord(id: string, name: string): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id),
      name,
      findRegex: "/alpha+/gi",
      replaceString: "$1 [{{match}}]",
      trimStrings: ["x", "y"],
      substituteRegex: 2,
      disabled: false,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      minDepth: 3,
      maxDepth: null,
      placement: [2, 5],
      isGlobal: false,
      sortOrder: 0,
      profileId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async function openRegexTabWith(records: RegexPresetRecord[]) {
    listAllRegexPresetsMock.mockResolvedValue(records);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => {
      expect(listAllRegexPresetsMock).toHaveBeenCalled();
    });
    return view;
  }

  test("copy clones the source fields, seeds disabled, and selects the duplicate", async () => {
    const view = await openRegexTabWith([fullRecord("rx_1", "Alpha Strip")]);
    createRegexPresetMock.mockResolvedValue({ ...fullRecord("rx_2", "copy"), id: brandId<RegexPresetId>("rx_2") });

    // Footer action on the SELECTED rule (auto-selected first) — desktop span.
    const copyBtn = within(view.baseElement).getByText("promptManager.regex.copy");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(createRegexPresetMock).toHaveBeenCalled();
    });
    const body = createRegexPresetMock.mock.calls[0][0] as unknown as Record<string, unknown>;
    // useT is mocked to return keys verbatim, so copySuffix resolves to its key.
    expect(body.name).toBe("Alpha Strip" + "promptManager.regex.copySuffix");
    expect(body).toMatchObject({
      findRegex: "/alpha+/gi",
      replaceString: "$1 [{{match}}]",
      trimStrings: ["x", "y"],
      substituteRegex: 2,
      // Import-parity security gate: duplicate starts disabled.
      disabled: true,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      minDepth: 3,
      maxDepth: null,
      placement: [2, 5],
      isGlobal: false,
    });
  });

  test("export downloads an ST-compatible array-of-one JSON with the safe filename", async () => {
    const view = await openRegexTabWith([fullRecord("rx_1", "Alpha Strip")]);

    // Footer action on the SELECTED rule — desktop span.
    const exportBtn = within(view.baseElement).getByText("promptManager.regex.export");
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(downloadTextFileMock).toHaveBeenCalled();
    });
    const [fileName, json, mime] = downloadTextFileMock.mock.calls[0] as [string, string, string];
    expect(fileName).toBe("regex-Alpha_Strip.json");
    expect(mime).toBe("application/json");
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      scriptName: "Alpha Strip",
      findRegex: "/alpha+/gi",
      replaceString: "$1 [{{match}}]",
      trimStrings: ["x", "y"],
      substituteRegex: 2,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      minDepth: 3,
      maxDepth: null,
      placement: [2, 5],
    });
  });
});

// ── R-13b: profiles in master list ─────────────────────────────────────
describe("PromptManagerModal — regex profiles (R-13b)", () => {
  function profileRecord(id: string, name: string, sortOrder = 0): RegexProfileRecord {
    return { id: brandId<RegexProfileId>(id), name, disabled: false, isGlobal: true, sortOrder, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  }
  function regexRecord(id: string, name: string, profileId: string | null = null): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id), name, findRegex: "/x/g", replaceString: "", trimStrings: [], substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0, profileId: profileId === null ? null : brandId<RegexProfileId>(profileId), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  test("switching to regex tab fetches profiles", async () => {
    listAllRegexPresetsMock.mockResolvedValue([regexRecord("rx1", "R1")]);
    listAllRegexProfilesMock.mockResolvedValue([profileRecord("p1", "Bundle")]);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => { expect(listAllRegexProfilesMock).toHaveBeenCalled(); });
    await waitFor(() => { expect(within(view.baseElement).getByText("Bundle")).toBeTruthy(); });
  });
  test("creating a new profile calls the API", async () => {
    listAllRegexPresetsMock.mockResolvedValue([]);
    listAllRegexProfilesMock.mockResolvedValue([]);
    createRegexProfileMock.mockResolvedValue(profileRecord("p2", "MyProf"));
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => expect(listAllRegexProfilesMock).toHaveBeenCalled());
    const newProfileBtn = within(view.baseElement).getByText("promptManager.regex.newProfile");
    fireEvent.click(newProfileBtn);
    const input = within(view.baseElement).getByPlaceholderText("promptManager.regex.newProfilePlaceholder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "MyProf" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => { expect(createRegexProfileMock).toHaveBeenCalled(); });
    expect((createRegexProfileMock.mock.calls[0][0] as unknown as { name: string }).name).toBe("MyProf");
  });

  test("member rule status reflects the PROFILE gate: enabled-but-unbound profile → Unbound on both the profile row and its member (R-13b owner spec)", async () => {
    // Enabled, non-global, zero profile links → applies in NO chat: both rows
    // must state Unbound; an active member badge would contradict the profile gate.
    const unboundProfile: RegexProfileRecord = { id: brandId<RegexProfileId>("pu"), name: "UnboundProf", disabled: false, isGlobal: false, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    listAllRegexPresetsMock.mockResolvedValue([regexRecord("m1", "MemRule", "pu")]);
    listAllRegexProfilesMock.mockResolvedValue([unboundProfile]);
    getRegexProfileLinksMock.mockResolvedValue([]);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => expect(within(view.baseElement).getAllByText("UnboundProf")[0]).toBeTruthy());
    // Expand the profile so the member row renders.
    fireEvent.click(view.getAllByLabelText("promptManager.regex.expandProfile")[0]);
    await waitFor(() => expect(within(view.baseElement).getByText("MemRule")).toBeTruthy());
    // Both the profile row and member row expose the same accessible status.
    await waitFor(() => {
      expect(view.getAllByLabelText("promptManager.regex.availabilityUnbound").length).toBe(2);
    });
  });
});

// ── R-13c: profile pane + member chip + profile export ────────────────────
describe("PromptManagerModal — regex profile pane & member chip (R-13c)", () => {
  function profileRecord(id: string, name: string, overrides: Partial<RegexProfileRecord> = {}): RegexProfileRecord {
    return { id: brandId<RegexProfileId>(id), name, disabled: false, isGlobal: true, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
  }
  function regexRecord(id: string, name: string, profileId: string | null = null, overrides: Partial<Record<string, unknown>> = {}): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id), name, findRegex: "/x/g", replaceString: "", trimStrings: [], substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0, profileId: profileId === null ? null : brandId<RegexProfileId>(profileId), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
    };
  }

  async function openRegexTab(profiles: ReturnType<typeof profileRecord>[], presets: RegexPresetRecord[]) {
    listAllRegexPresetsMock.mockResolvedValue(presets);
    listAllRegexProfilesMock.mockResolvedValue(profiles);
    getRegexProfileLinksMock.mockResolvedValue([]);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => expect(listAllRegexProfilesMock).toHaveBeenCalled());
    return view;
  }

  test("selecting a profile renders the profile pane (name field, export button)", async () => {
    const view = await openRegexTab([profileRecord("p1", "Bundle")], []);
    await waitFor(() => expect(within(view.baseElement).getAllByText("Bundle")[0]).toBeTruthy());
    const profileEl = within(view.baseElement).getAllByText("Bundle")[0];
    await act(async () => { fireEvent.pointerDown(profileEl); fireEvent.click(profileEl); });
    await waitFor(() => expect((within(view.baseElement).getByDisplayValue("Bundle") as HTMLInputElement).value).toBe("Bundle"));
    expect(within(view.baseElement).getByText("promptManager.regex.profileExport")).toBeTruthy();
    expect(within(view.baseElement).getByText("promptManager.regex.profileDelete")).toBeTruthy();
  });

  test("profile enable toggle PATCHes updateRegexProfile with disabled", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const view = await openRegexTab([profileRecord("p1", "Bundle", { disabled: false })], []);
    await waitFor(() => expect(within(view.baseElement).getAllByText("Bundle")[0]).toBeTruthy());
    const profileEl = within(view.baseElement).getAllByText("Bundle")[0];
    await act(async () => { fireEvent.pointerDown(profileEl); fireEvent.click(profileEl); });
    await waitFor(() => expect(within(view.baseElement).getByDisplayValue("Bundle")).toBeTruthy());
    const switches = within(view.baseElement).getAllByRole("switch");
    const toggle = switches[0] as HTMLButtonElement;
    await act(async () => { await user.click(toggle); });
    await waitFor(() => expect(updateRegexProfileMock).toHaveBeenCalled());
    const args = updateRegexProfileMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args[0]).toBe("p1");
    expect(args[1]).toHaveProperty("disabled", true);
    // Allow the optimistic state update to settle before unmount
    await new Promise((r) => setTimeout(r, 20));
  });

  test("delete profile dialog offers BOTH options and chosen one calls deleteRegexProfile with right mode", async () => {
    const presets = [regexRecord("r1", "R1", "p1"), regexRecord("r2", "R2", "p1")];
    const view = await openRegexTab([profileRecord("p1", "Bundle")], presets);
    await waitFor(() => expect(within(view.baseElement).getAllByText("Bundle")[0]).toBeTruthy());
    const profileEl = within(view.baseElement).getAllByText("Bundle")[0];
    await act(async () => { fireEvent.pointerDown(profileEl); fireEvent.click(profileEl); });
    await waitFor(() => expect(within(view.baseElement).getByDisplayValue("Bundle")).toBeTruthy());
    await act(async () => { fireEvent.click(within(view.baseElement).getByText("promptManager.regex.profileDelete")); });
    await waitFor(() => expect(within(document.body).getByText("promptManager.regex.profileDeleteTitle")).toBeTruthy());
    const keepBtn = within(document.body).getByText("promptManager.regex.profileDeleteKeep");
    const cascadeBtn = within(document.body).getByText("promptManager.regex.profileDeleteCascade");
    expect(keepBtn).toBeTruthy();
    expect(cascadeBtn).toBeTruthy();
    listAllRegexPresetsMock.mockResolvedValue([]);
    listAllRegexProfilesMock.mockResolvedValue([]);
    await act(async () => { fireEvent.click(keepBtn); });
    await waitFor(() => expect(deleteRegexProfileMock).toHaveBeenCalled());
    const lastCall = deleteRegexProfileMock.mock.calls.at(-1) as [string, string] | undefined;
    expect(lastCall?.[0]).toBe("p1");
    expect(lastCall?.[1]).toBe("keep");
    await new Promise((r) => setTimeout(r, 20));
  });

  test("member rule editor shows chip instead of own scope segmented control", async () => {
    const view = await openRegexTab([profileRecord("p1", "Bundle")], [regexRecord("r1", "MemRule", "p1", { isGlobal: false })]);
    await waitFor(() => expect(within(view.baseElement).getAllByText("Bundle")[0]).toBeTruthy());
    await act(async () => { fireEvent.click(view.getAllByLabelText("promptManager.regex.expandProfile")[0]); });
    await waitFor(() => expect(within(view.baseElement).getByText("MemRule")).toBeTruthy());
    const memEl = within(view.baseElement).getByText("MemRule");
    await act(async () => { fireEvent.pointerDown(memEl); fireEvent.click(memEl); });
    await waitFor(() => expect(within(view.baseElement).getByText("promptManager.regex.memberViaProfile")).toBeTruthy());
    // Own scope controls should be absent for a member (the chip replaces them)
    // The scope label stays but the bind-add button (scoped to rule) must not appear
    expect(within(view.baseElement).queryByText("promptManager.regex.bindingsAdd")).toBeNull();
  });

  test("standalone rule editor still shows own scope controls (no chip)", async () => {
    const view = await openRegexTab([profileRecord("p1", "Bundle")], [regexRecord("r1", "Standalone", null, { isGlobal: true })]);
    await waitFor(() => expect(within(view.baseElement).getByText("Bundle")).toBeTruthy());
    const standEl = within(view.baseElement).getByText("Standalone");
    await act(async () => { fireEvent.pointerDown(standEl); fireEvent.click(standEl); });
    await waitFor(() => expect(within(view.baseElement).queryByText("promptManager.regex.memberViaProfile")).toBeNull());
    // Scope segmented should be present (label exists)
    expect(within(view.baseElement).getByText("promptManager.regex.scopeLabel")).toBeTruthy();
  });

  test("profile export calls downloadTextFile with regex-profile-<name>.json and array body", async () => {
    const view = await openRegexTab([profileRecord("p1", "Bundle")], [
      regexRecord("r1", "R1", "p1", { findRegex: "/a/g", replaceString: "x" }),
      regexRecord("r2", "R2", "p1", { findRegex: "/b/g", replaceString: "y" }),
    ]);
    await waitFor(() => expect(within(view.baseElement).getAllByText("Bundle")[0]).toBeTruthy());
    const profileEl = within(view.baseElement).getAllByText("Bundle")[0];
    await act(async () => { fireEvent.pointerDown(profileEl); fireEvent.click(profileEl); });
    await waitFor(() => expect(within(view.baseElement).getByDisplayValue("Bundle")).toBeTruthy());
    await act(async () => { fireEvent.click(within(view.baseElement).getByText("promptManager.regex.profileExport")); });
    await waitFor(() => expect(downloadTextFileMock).toHaveBeenCalled());
    const [fileName, json, mime] = downloadTextFileMock.mock.calls[0] as [string, string, string];
    expect(fileName).toBe("regex-profile-Bundle.json");
    expect(mime).toBe("application/json");
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((o) => typeof o.scriptName === "string")).toBe(true);
  });

  test("Profile text edits debounce and coalesce into one autosave", async () => {
    const view = await openRegexTab([profileRecord("p1", "Bundle")], []);
    const q = within(view.baseElement);
    await act(async () => { const profile = q.getAllByText("Bundle")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    const name = await waitFor(() => q.getByDisplayValue("Bundle")) as HTMLInputElement;
    jest.useFakeTimers();
    try {
      fireEvent.change(name, { target: { value: "First" } });
      fireEvent.change(name, { target: { value: "Final" } });
      expect(updateRegexProfileMock).not.toHaveBeenCalled();

      await act(async () => { jest.advanceTimersByTime(999); });
      expect(updateRegexProfileMock).not.toHaveBeenCalled();
      await act(async () => { jest.advanceTimersByTime(1); });

      expect(updateRegexProfileMock).toHaveBeenCalledTimes(1);
      expect(updateRegexProfileMock).toHaveBeenCalledWith("p1", { name: "Final" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("Profile discrete controls save immediately", async () => {
    const view = await openRegexTab([profileRecord("p1", "Bundle")], []);
    const q = within(view.baseElement);
    await act(async () => { const profile = q.getAllByText("Bundle")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    const toggle = await waitFor(() => q.getByRole("switch", { name: "promptManager.regex.fieldActive" }));

    fireEvent.click(toggle);

    await waitFor(() => expect(updateRegexProfileMock).toHaveBeenCalledWith("p1", { disabled: true }));
  });

  test("a failed Profile autosave rolls back the optimistic control and shows an error", async () => {
    updateRegexProfileMock.mockRejectedValueOnce(new Error("offline"));
    const view = await openRegexTab([profileRecord("p1", "Bundle")], []);
    const q = within(view.baseElement);
    await act(async () => { const profile = q.getAllByText("Bundle")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    const toggle = await waitFor(() => q.getByRole("switch", { name: "promptManager.regex.fieldActive" }));

    fireEvent.click(toggle);

    await waitFor(() => expect(updateRegexProfileMock).toHaveBeenCalledWith("p1", { disabled: true }));
    await waitFor(() => expect(q.getByText("promptManager.regex.profileAutosaveFailed")).toBeTruthy());
  });

  test("flushes a pending Profile rename before switching selection", async () => {
    let resolveSave: ((record: RegexProfileRecord) => void) | undefined;
    updateRegexProfileMock.mockImplementationOnce(() => new Promise<RegexProfileRecord>((resolve) => { resolveSave = resolve; }));
    const rule = regexRecord("rule-1", "Standalone");
    const view = await openRegexTab([profileRecord("p1", "Bundle")], [rule]);
    const q = within(view.baseElement);
    await act(async () => { const profile = q.getAllByText("Bundle")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    fireEvent.change(await waitFor(() => q.getByDisplayValue("Bundle")), { target: { value: "Renamed" } });

    const standalone = q.getByText("Standalone");
    fireEvent.pointerDown(standalone);
    fireEvent.click(standalone);

    await waitFor(() => expect(updateRegexProfileMock).toHaveBeenCalledWith("p1", { name: "Renamed" }));
    expect(q.getByDisplayValue("Renamed")).toBeTruthy();
    resolveSave?.(profileRecord("p1", "Renamed"));
    await waitFor(() => expect(q.getByText("promptManager.regex.fieldFind")).toBeTruthy());
  });

  test("flushes a pending Profile rename before closing", async () => {
    let resolveSave: ((record: RegexProfileRecord) => void) | undefined;
    updateRegexProfileMock.mockImplementationOnce(() => new Promise<RegexProfileRecord>((resolve) => { resolveSave = resolve; }));
    const view = await openRegexTab([profileRecord("p1", "Bundle")], []);
    const q = within(view.baseElement);
    await act(async () => { const profile = q.getAllByText("Bundle")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    fireEvent.change(await waitFor(() => q.getByDisplayValue("Bundle")), { target: { value: "Renamed" } });

    fireEvent.click(q.getAllByText("close")[0]);

    await waitFor(() => expect(updateRegexProfileMock).toHaveBeenCalledWith("p1", { name: "Renamed" }));
    expect(useModalStore.getState().isPromptManagerOpen).toBe(true);
    resolveSave?.(profileRecord("p1", "Renamed"));
    await waitFor(() => expect(useModalStore.getState().isPromptManagerOpen).toBe(false));
  });

  test("Profile Export and Delete live only in the footer, and Export disables when empty", async () => {
    const emptyView = await openRegexTab([profileRecord("p1", "Empty")], []);
    const emptyQuery = within(emptyView.baseElement);
    await act(async () => { const profile = emptyQuery.getAllByText("Empty")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    const editor = await waitFor(() => emptyQuery.getByTestId("regex-profile-editor"));
    expect(within(editor).queryByText("promptManager.regex.profileExport")).toBeNull();
    expect(within(editor).queryByText("promptManager.regex.profileDelete")).toBeNull();
    expect(emptyQuery.getByText("promptManager.regex.profileExport").getAttribute("aria-disabled")).toBe("true");

    cleanup();
    const memberView = await openRegexTab([profileRecord("p2", "Filled")], [regexRecord("member", "Member", "p2")]);
    const memberQuery = within(memberView.baseElement);
    await act(async () => { const profile = memberQuery.getAllByText("Filled")[0]; fireEvent.pointerDown(profile); fireEvent.click(profile); });
    await waitFor(() => expect(memberQuery.getByText("promptManager.regex.profileExport").getAttribute("aria-disabled")).toBeNull());
    expect(memberQuery.getByText("promptManager.regex.profileDelete")).toBeTruthy();
  });
});

// ── RXU-14: manual rule creation from empty local drafts ───────────────
describe("PromptManagerModal — manual rule drafts (RXU-14)", () => {
  function regexRecord(id: string, name: string, profileId: string | null = null): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id), name, findRegex: "/x/g", replaceString: "", trimStrings: [], substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0, profileId: profileId === null ? null : brandId<RegexProfileId>(profileId), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  function profileRecord(id: string, name: string): RegexProfileRecord {
    return { id: brandId<RegexProfileId>(id), name, disabled: false, isGlobal: true, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  }

  async function openRegexTab(presets: RegexPresetRecord[], profiles: RegexProfileRecord[] = []) {
    listAllRegexPresetsMock.mockResolvedValue(presets);
    listAllRegexProfilesMock.mockResolvedValue(profiles);
    getRegexProfileLinksMock.mockResolvedValue([]);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => expect(listAllRegexPresetsMock).toHaveBeenCalled());
    return view;
  }

  /** Open a standalone draft via the master list's inline "+ New" entry. */
  async function openStandaloneDraft(view: ReturnType<typeof render>, name: string) {
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.newPreset"));
    const input = within(view.baseElement).getByPlaceholderText("promptManager.regex.newNamePlaceholder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The draft editor mounts: name seeded, find EMPTY, Active OFF.
    await waitFor(() => expect(within(view.baseElement).getByLabelText("promptManager.regex.fieldFind")).toBeTruthy());
  }

  test("opening a draft makes ZERO write calls, adds no list row, and starts empty + disabled", async () => {
    const view = await openRegexTab([regexRecord("rx_a", "Existing")]);
    const listReadsBefore = listAllRegexPresetsMock.mock.calls.length;
    await openStandaloneDraft(view, "Fresh");

    // Zero writes and no extra reads for opening the draft.
    expect(createRegexPresetMock).not.toHaveBeenCalled();
    expect(attachRegexRuleMock).not.toHaveBeenCalled();
    expect(updateRegexProfileMock).not.toHaveBeenCalled();
    expect(listAllRegexPresetsMock).toHaveBeenCalledTimes(listReadsBefore);

    const q = within(view.baseElement);
    // The seeded name lives ONLY in the editor input — no phantom list row.
    expect(q.getByDisplayValue("Fresh")).toBeTruthy();
    expect(q.queryByText("Fresh")).toBeNull();
    // Draft starts empty (owner correction quoted in the RXU-14 plan).
    expect((q.getByLabelText("promptManager.regex.fieldFind") as HTMLTextAreaElement).value).toBe("");
    expect((q.getByLabelText("promptManager.regex.fieldReplace") as HTMLTextAreaElement).value).toBe("");
    // Agreed manual default: Active OFF until the user opts in.
    expect(q.getByRole("switch", { name: "promptManager.regex.fieldActive" }).getAttribute("aria-checked")).toBe("false");
  });

  test("Save stays disabled with field feedback while name or regex is invalid — zero writes", async () => {
    const view = await openRegexTab([]);
    await openStandaloneDraft(view, "Blocked");
    const q = within(view.baseElement);

    // Name valid, find EMPTY → find feedback, Save disabled.
    expect(q.getByText("promptManager.regex.draftFindRequired")).toBeTruthy();
    let save = q.getByRole("button", { name: "save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Type a broken pattern → still blocked.
    fireEvent.change(q.getByLabelText("promptManager.regex.fieldFind"), { target: { value: "/[unclosed/g" } });
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(q.getByText("promptManager.regex.draftFindRequired")).toBeTruthy();

    // Clear the name → name feedback.
    fireEvent.change(q.getByLabelText("promptManager.regex.fieldName"), { target: { value: "" } });
    await waitFor(() => expect(q.getByText("promptManager.regex.draftNameRequired")).toBeTruthy());

    // A blocked Save never reaches the server.
    fireEvent.click(q.getByRole("button", { name: "save" }));
    expect(createRegexPresetMock).not.toHaveBeenCalled();
    expect(attachRegexRuleMock).not.toHaveBeenCalled();
  });

  test("first valid Save creates the Rule ONCE with the exact payload, then it appears in the list", async () => {
    const view = await openRegexTab([regexRecord("rx_a", "Existing")]);
    await openStandaloneDraft(view, "My Stripper");
    const q = within(view.baseElement);
    createRegexPresetMock.mockResolvedValue(regexRecord("rx_new", "My Stripper"));

    // No row until Save (the name exists only as the input's value).
    expect(q.queryByText("My Stripper")).toBeNull();

    fireEvent.change(q.getByLabelText("promptManager.regex.fieldFind"), { target: { value: "/<think>[\\s\\S]*?<\\/think>/g" } });
    fireEvent.change(q.getByLabelText("promptManager.regex.fieldReplace"), { target: { value: "" } });
    const save = q.getByRole("button", { name: "save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(createRegexPresetMock).toHaveBeenCalledTimes(1));
    const body = createRegexPresetMock.mock.calls[0][0] as unknown as Record<string, unknown>;
    // Fields exactly as typed in the empty-started draft; born disabled; standalone.
    expect(body).toMatchObject({
      name: "My Stripper",
      findRegex: "/<think>[\\s\\S]*?<\\/think>/g",
      replaceString: "",
      trimStrings: [],
      substituteRegex: 0,
      disabled: true,
      isGlobal: false,
      placement: [2],
      minDepth: null,
      maxDepth: null,
      markdownOnly: false,
      promptOnly: false,
    });
    expect("profileId" in body).toBe(false);
    // ONE write — no create-then-attach.
    expect(attachRegexRuleMock).not.toHaveBeenCalled();
    expect(updateRegexProfileMock).not.toHaveBeenCalled();
    // The saved rule (and only it) renders as a list row.
    await waitFor(() => expect(q.getByText("My Stripper")).toBeTruthy());
  });

  test("a draft opened inside a Profile saves ONCE with profileId and lands as a member row", async () => {
    const view = await openRegexTab([], [profileRecord("p1", "Bundle")]);
    const q = within(view.baseElement);
    createRegexPresetMock.mockResolvedValue(regexRecord("rx_new", "InProf", "p1"));

    // Expand the profile → inline "+ New rule" member entry.
    fireEvent.click(view.getAllByLabelText("promptManager.regex.expandProfile")[0]);
    await waitFor(() => expect(q.getByText("promptManager.regex.memberNewRule")).toBeTruthy());
    fireEvent.click(q.getByText("promptManager.regex.memberNewRule"));
    const input = q.getByPlaceholderText("promptManager.regex.newNamePlaceholder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "InProf" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Draft editor mounted with the member chip (intended destination shown).
    await waitFor(() => expect(q.getByText("promptManager.regex.memberViaProfile")).toBeTruthy());
    fireEvent.change(q.getByLabelText("promptManager.regex.fieldFind"), { target: { value: "/x/g" } });
    const save = q.getByRole("button", { name: "save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    // ONE create carrying the intended profileId — the attach endpoint is
    // never used for manual creation anymore.
    await waitFor(() => expect(createRegexPresetMock).toHaveBeenCalledTimes(1));
    const body = createRegexPresetMock.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(body.name).toBe("InProf");
    expect(body.profileId).toBe("p1");
    expect(body.disabled).toBe(true);
    expect(attachRegexRuleMock).not.toHaveBeenCalled();
    // The created rule lands in state and renders as the profile's member.
    await waitFor(() => expect(q.getByText("InProf")).toBeTruthy());
  });

  test("closing the modal discards a dirty draft with ZERO writes and no phantom row", async () => {
    const view = await openRegexTab([]);
    await openStandaloneDraft(view, "Doomed");
    const q = within(view.baseElement);
    // Make the draft dirty AND valid — a state worth protecting with the
    // unsaved-changes guard, then confirm the discard.
    fireEvent.change(q.getByLabelText("promptManager.regex.fieldFind"), { target: { value: "/x/g" } });

    fireEvent.click(q.getAllByText("close")[0]);
    await waitFor(() => expect(q.getByText("unsaved_changes_title")).toBeTruthy());
    fireEvent.click(q.getByText("close_without_saving"));

    await waitFor(() => expect(useModalStore.getState().isPromptManagerOpen).toBe(false));
    expect(createRegexPresetMock).not.toHaveBeenCalled();
    expect(attachRegexRuleMock).not.toHaveBeenCalled();
  });
});

// ── RXU-42: Profile member workflows ───────────────────────────────────
describe("PromptManagerModal — Profile member workflows (RXU-42)", () => {
  function profileRecord(id: string, name: string): RegexProfileRecord {
    return { id: brandId<RegexProfileId>(id), name, disabled: false, isGlobal: true, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  }
  function regexRecord(id: string, name: string, profileId: string | null = null): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id), name, findRegex: "/x/g", replaceString: "", trimStrings: [], substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0, profileId: profileId === null ? null : brandId<RegexProfileId>(profileId), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  async function openProfile(presets: RegexPresetRecord[]) {
    listAllRegexPresetsMock.mockResolvedValue(presets);
    listAllRegexProfilesMock.mockResolvedValue([profileRecord("profile-1", "Bundle")]);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => expect(within(view.baseElement).getAllByText("Bundle").length).toBeGreaterThan(0));
    const profile = within(view.baseElement).getAllByText("Bundle")[0]!;
    await act(async () => { fireEvent.pointerDown(profile); fireEvent.click(profile); });
    await waitFor(() => expect(within(view.baseElement).getByRole("button", { name: "promptManager.regex.createRule" })).toBeTruthy());
    return view;
  }

  test("Create Rule opens an empty local draft bound to the selected Profile without a write", async () => {
    const view = await openProfile([]);
    const q = within(view.baseElement);
    fireEvent.click(q.getByRole("button", { name: "promptManager.regex.createRule" }));

    await waitFor(() => expect(q.getByText("promptManager.regex.memberViaProfile")).toBeTruthy());
    expect((q.getByLabelText("promptManager.regex.fieldName") as HTMLInputElement).value).toBe("");
    expect((q.getByLabelText("promptManager.regex.fieldFind") as HTMLTextAreaElement).value).toBe("");
    expect(createRegexPresetMock).not.toHaveBeenCalled();
    expect(attachRegexRuleMock).not.toHaveBeenCalled();
  });

  test("Add existing opens for a selected Profile, attaches candidates, and keeps that Profile selected", async () => {
    const member = regexRecord("member-1", "Existing member", "profile-1");
    const standalone = regexRecord("standalone-1", "Standalone");
    const secondStandalone = regexRecord("standalone-2", "Second standalone");
    const view = await openProfile([member, standalone, secondStandalone]);
    const q = within(view.baseElement);
    attachRegexRuleMock.mockImplementation(async (_profileId, ruleId) => {
      const id = String(ruleId);
      return regexRecord(id, id === "standalone-1" ? "Standalone" : "Second standalone", "profile-1");
    });

    fireEvent.click(q.getByRole("button", { name: "promptManager.regex.pickerTrigger" }));
    fireEvent.click(q.getByRole("checkbox", { name: "Standalone" }));
    fireEvent.click(q.getByRole("checkbox", { name: "Second standalone" }));
    fireEvent.click(q.getByRole("button", { name: "promptManager.regex.pickerAttach" }));

    await waitFor(() => {
      expect(attachRegexRuleMock).toHaveBeenCalledWith("profile-1", "standalone-1");
      expect(attachRegexRuleMock).toHaveBeenCalledWith("profile-1", "standalone-2");
      expect(q.getByText("promptManager.regex.profileMemberCount:3")).toBeTruthy();
    });
    expect((q.getByDisplayValue("Bundle") as HTMLInputElement).value).toBe("Bundle");
  });
});

// ── RXU-43: explicit Profile assignment ─────────────────────────────────
describe("PromptManagerModal — explicit Profile assignment (RXU-43)", () => {
  function regexRecord(id: string, profileId: string | null): RegexPresetRecord {
    return {
      id: brandId<RegexPresetId>(id), name: "Rule", findRegex: "/x/g", replaceString: "", trimStrings: [], substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0, profileId: profileId === null ? null : brandId<RegexProfileId>(profileId), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  function assignmentHost(initial: RegexPresetRecord) {
    let rules = [initial];
    const onConfirmed = mock(() => {});
    const onFailed = mock(() => {});
    const handler = makeRegexProfileAssignmentHandler({
      attach: attachRegexRuleMock,
      detach: detachRegexRuleMock,
      setRules: (next) => { rules = typeof next === "function" ? next(rules) : next; },
      setExpandedProfileIds: mock(() => {}),
      onConfirmed,
      onFailed,
    });
    return { handler, onConfirmed, onFailed, rules: () => rules };
  }

  test("attaching a Profile updates local state only from the confirmed Rule", async () => {
    const host = assignmentHost(regexRecord("rule-1", "p1"));
    attachRegexRuleMock.mockResolvedValue(regexRecord("rule-1", "p2"));

    await host.handler.assign("rule-1", "p2");

    expect(attachRegexRuleMock).toHaveBeenCalledWith("p2", "rule-1");
    expect(host.rules()[0].profileId).toBe(brandId<RegexProfileId>("p2"));
    expect(host.onConfirmed).toHaveBeenCalledTimes(1);
  });

  test("selecting Standalone detaches the Rule only after confirmation", async () => {
    const host = assignmentHost(regexRecord("rule-1", "p1"));
    detachRegexRuleMock.mockResolvedValue(regexRecord("rule-1", null));

    await host.handler.detach("rule-1");

    expect(detachRegexRuleMock).toHaveBeenCalledWith("rule-1");
    expect(host.rules()[0].profileId).toBeNull();
    expect(host.onConfirmed).toHaveBeenCalledTimes(1);
  });

  test("failed attach or detach preserves the confirmed Profile and reports an error", async () => {
    const attachFailure = assignmentHost(regexRecord("rule-1", "p1"));
    attachRegexRuleMock.mockRejectedValue(new Error("offline"));
    await attachFailure.handler.assign("rule-1", "p2");
    expect(attachFailure.rules()[0].profileId).toBe(brandId<RegexProfileId>("p1"));
    expect(attachFailure.onFailed).toHaveBeenCalledTimes(1);

    const detachFailure = assignmentHost(regexRecord("rule-1", "p1"));
    detachRegexRuleMock.mockRejectedValue(new Error("offline"));
    await detachFailure.handler.detach("rule-1");
    expect(detachFailure.rules()[0].profileId).toBe(brandId<RegexProfileId>("p1"));
    expect(detachFailure.onFailed).toHaveBeenCalledTimes(1);
  });
});

// ── RXU-21: preset-import Regex Profile (one Profile per import) ────────

describe("preset-import-flow — Regex bundle sequence (RXU-21)", () => {
  function importDraft(name: string, disabled: boolean): RegexScriptImportDraft {
    return {
      name,
      findRegex: "/x/g",
      replaceString: "",
      trimStrings: [],
      substituteRegex: 0,
      disabled,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: false,
      minDepth: null,
      maxDepth: null,
      placement: [2],
      isGlobal: false,
      sortOrder: 0,
      profileId: null,
      sourceScript: { scriptName: name },
    };
  }

  test("summarizeRegexImportRules counts mixed source states (N · X enabled · Y disabled)", () => {
    expect(summarizeRegexImportRules([])).toEqual({ total: 0, enabled: 0, disabled: 0 });
    expect(summarizeRegexImportRules([importDraft("only", false)])).toEqual({ total: 1, enabled: 1, disabled: 0 });
    expect(summarizeRegexImportRules([
      importDraft("on", false),
      importDraft("off", true),
      importDraft("on2", false),
    ])).toEqual({ total: 3, enabled: 2, disabled: 1 });
  });

  test("createPresetRegexProfile: toggle OFF → master disabled true; toggle ON → disabled false — both positions explicit", async () => {
    const rules = [importDraft("on", false), importDraft("off", true)];
    const bodies: Array<Parameters<typeof realRegexApi.createRegexProfileBundle>[0]> = [];
    const createBundle = async (body: Parameters<typeof realRegexApi.createRegexProfileBundle>[0]) => {
      bodies.push(body);
      return { profile: { id: "p1" }, rules: [] } as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfileBundle>>;
    };

    // Toggle OFF (the default): the master switch is disabled — source-
    // enabled rules stay enabled but are gated by the disabled Profile.
    await createPresetRegexProfile({ rules, enableProfile: false, profileName: "P" }, "preset-9", createBundle);
    expect(bodies[0]).toMatchObject({
      name: "P",
      disabled: true,
      links: [{ targetType: "preset", targetId: "preset-9" }],
    });
    expect(bodies[0].rules.map((rule) => rule.disabled)).toEqual([false, true]);

    // Toggle ON: the Profile is active immediately; source-disabled rules
    // stay disabled (their own flags are untouched).
    await createPresetRegexProfile({ rules, enableProfile: true, profileName: "P" }, "preset-9", createBundle);
    expect(bodies[1].disabled).toBe(false);
    expect(bodies[1].rules.map((rule) => rule.disabled)).toEqual([false, true]);

    // Import-only channels never reach the API body (membership is
    // bundle-owned; sourceScript is a preview-channel detail).
    for (const key of ["sourceScript", "profileId"] as const) {
      expect(key in (bodies[0].rules[0] as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  test("createPresetWithRegexProfile without rules: create only — no bundle call, no compensation", async () => {
    const createPreset = mock(async () => ({ id: "p_new" }));
    const deletePreset = mock(async () => {});
    const createBundle = mock(async () => { throw new Error("must not be called"); });

    const outcome = await createPresetWithRegexProfile({
      createPreset, deletePreset, plan: null, createBundle,
    });

    expect(outcome).toEqual({ ok: true, presetId: "p_new" });
    expect(createBundle).not.toHaveBeenCalled();
    expect(deletePreset).not.toHaveBeenCalled();
  });

  test("createPresetWithRegexProfile: bundle failure → compensation delete, regexBundleFailed outcome, single bundle call", async () => {
    const createPreset = mock(async () => ({ id: "p_new" }));
    const deletePreset = mock(async () => {});
    const createBundle = mock(async () => {
      throw new Error("bundle boom");
    });

    const outcome = await createPresetWithRegexProfile({
      createPreset,
      deletePreset,
      plan: { rules: [importDraft("on", false)], enableProfile: false, profileName: "P" },
      createBundle,
    });

    expect(outcome).toEqual({ ok: false, reason: "regexBundleFailed" });
    expect(createPreset).toHaveBeenCalledTimes(1);
    expect(createBundle).toHaveBeenCalledTimes(1); // no partial retry
    expect(deletePreset).toHaveBeenCalledWith("p_new"); // the preset is rolled back
  });

  test("createPresetWithRegexProfile: preset-create failure → no bundle, no delete", async () => {
    const createPreset = mock(async () => null);
    const deletePreset = mock(async () => {});
    const createBundle = mock(async () => ({ profile: { id: "x" }, rules: [] } as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfileBundle>>));

    const outcome = await createPresetWithRegexProfile({
      createPreset,
      deletePreset,
      plan: { rules: [importDraft("on", false)], enableProfile: false, profileName: "P" },
      createBundle,
    });

    expect(outcome).toEqual({ ok: false, reason: "presetCreateFailed" });
    expect(createBundle).not.toHaveBeenCalled();
    expect(deletePreset).not.toHaveBeenCalled();
  });
});

describe("PromptManagerModal — preset import Regex Profile wiring (RXU-21)", () => {
  /** ST preset file embedding 3 rules with MIXED source states. */
  function stPresetFileWithRegex(): File {
    return new File([
      JSON.stringify({
        name: "Regex bundle preset",
        prompts: [
          { identifier: "main", name: "Main", role: "system", content: "System text", injection_position: 0, injection_depth: 4, injection_order: 100, enabled: true },
        ],
        extensions: {
          regex_scripts: [
            { scriptName: "On rule", findRegex: "/x/g", replaceString: "", disabled: false },
            { scriptName: "Off rule", findRegex: "/y/g", replaceString: "", disabled: true },
            { scriptName: "Second on", findRegex: "/z/g", replaceString: "", disabled: false },
          ],
        },
      }),
    ], "regex-preset.json", { type: "application/json" });
  }

  /** VT-native export (full DTO under `_vibe_tavern`) embedding one disabled
   *  rule — built with the real serializer (rides the real export shape). */
  function vtPresetFileWithRegex(): File {
    const dto: PromptPresetDto = {
      id: "vt-1",
      name: "VT source",
      system: "VT lossless system",
      jailbreak: "jb",
      prefill: "",
      authorsNote: "",
      authorsNoteDepth: 4,
      authorsNotePosition: "in_chat",
      authorsNoteRole: "system",
      summary: "",
      tools: "",
      nsfw: "",
      enhanceDefinitions: "",
      scriptAiSystemPrompt: "",
      aiAssistantPrompts: "{}",
      customInjections: [],
      promptOrder: [],
      advancedMode: false,
      mergeConsecutiveRoles: false,
      perSendPrefillEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    return new File([
      serializeStPreset(dto, [{
        name: "VT rule", findRegex: "/y/g", replaceString: "", trimStrings: [],
        substituteRegex: 0, disabled: true, markdownOnly: false, promptOnly: false,
        runOnEdit: false, minDepth: null, maxDepth: null, placement: [2],
        isGlobal: false, sortOrder: 0, profileId: null,
      }]),
    ], "vt-preset.json", { type: "application/json" });
  }

  function renderManager(overrides: Partial<Parameters<typeof PromptManagerModal>[0]> = {}) {
    const onCreate = mock(async () => ({ id: "preset_new" }));
    const onDelete = mock(async () => true);
    const setActivePresetId = mock();
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={setActivePresetId}
        onCreate={onCreate}
        onUpdate={mock(async () => true)}
        onDelete={onDelete}
        onReorder={mock(async () => true)}
        {...overrides}
      />,
    );
    return { view, onCreate, onDelete, setActivePresetId };
  }

  /** Simple-mode preset: the target-"current" tests assert on the system
   *  textarea, which advanced mode hides behind the canvas (SP-7). */
  function simplePreset(): PromptPresetDto {
    return { ...advancedPreset(), advancedMode: false };
  }

  /** Open the presets-tab import flow and feed `file` into the preview. The
   *  LAST file input in the body is the import modal's Dropzone (its portal
   *  renders after the list's hidden import input). */
  async function openPresetImportPreview(
    view: ReturnType<typeof render>,
    file: File,
    previewName: string,
  ) {
    fireEvent.click(within(view.baseElement).getByText("import_preset_btn"));
    const inputs = view.baseElement.querySelectorAll("input[type='file']");
    expect(inputs.length).toBeGreaterThan(1); // list input + Dropzone input
    fireEvent.change(inputs[inputs.length - 1]!, { target: { files: [file] } });
    await waitFor(() =>
      expect(within(view.baseElement).getAllByText(`${previewName}.json`).length).toBeGreaterThan(0)
    );
  }

  test("ST import, target new, toggle OFF (default): preset FIRST, then ONE bundle bound to the new preset", async () => {
    const { view, onCreate, onDelete, setActivePresetId } = renderManager();
    await openPresetImportPreview(view, stPresetFileWithRegex(), "Regex bundle preset");
    const q = within(view.baseElement);

    // The card is present with the default-off master toggle (the preview
    // boundary itself is pinned in PresetImportModal.test).
    expect(q.getByRole("switch", { name: "regexImport.enableAfterImport" }).getAttribute("aria-checked")).toBe("false");

    // Target "new" so the preset is created by THIS import (compensation path).
    fireEvent.click(q.getByText("preset_import_to_new"));
    await waitFor(() => expect(q.getByPlaceholderText("preset_import_new_name_placeholder")).toBeTruthy());

    fireEvent.click(q.getByText("preset_import_btn"));

    await waitFor(() => expect(createRegexProfileBundleMock).toHaveBeenCalledTimes(1));
    // Preset FIRST: onCreate resolved before the bundle fired.
    expect(onCreate).toHaveBeenCalledTimes(1);
    const body = createRegexProfileBundleMock.mock.calls[0][0];
    expect(body).toMatchObject({
      name: "Regex bundle preset",
      disabled: true, // toggle OFF → master disabled
      links: [{ targetType: "preset", targetId: "preset_new" }],
    });
    // Source-faithful rules: source states intact under the disabled master.
    expect(body.rules.map((rule: { disabled?: boolean }) => rule.disabled)).toEqual([false, true, false]);
    // Success: the new preset is selected, nothing is deleted, the Regex
    // lists refresh (the display-regex cache invalidation rides the refresh).
    await waitFor(() => expect(setActivePresetId).toHaveBeenCalledWith("preset_new"));
    expect(onDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(listAllRegexPresetsMock.mock.calls.length).toBeGreaterThan(0));
  });

  test("ST import bundle failure: the just-created preset is rolled back and the failure is surfaced", async () => {
    createRegexProfileBundleMock.mockRejectedValueOnce(new Error("bundle boom"));
    const { view, onDelete, setActivePresetId } = renderManager();
    await openPresetImportPreview(view, stPresetFileWithRegex(), "Regex bundle preset");
    const q = within(view.baseElement);
    fireEvent.click(q.getByText("preset_import_to_new"));
    await waitFor(() => expect(q.getByPlaceholderText("preset_import_new_name_placeholder")).toBeTruthy());
    fireEvent.click(q.getByText("preset_import_btn"));

    // Compensation: delete called with the newly created preset id.
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("preset_new"));
    // The rolled-back import never selects the preset, and the failure toast
    // states the rollback.
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("regexImport.bundleFailedRolledBack"));
    expect(setActivePresetId).not.toHaveBeenCalled();
    // No partial rows: exactly one bundle attempt, never retried.
    expect(createRegexProfileBundleMock).toHaveBeenCalledTimes(1);
  });

  test("VT-native import, target current, toggle ON: bundle binds the EXISTING preset with an active master", async () => {
    const { view, onCreate } = renderManager({ presets: [simplePreset()] });
    await openPresetImportPreview(view, vtPresetFileWithRegex(), "VT source");
    const q = within(view.baseElement);

    // Toggle ON before confirming: source-enabled rules work immediately.
    fireEvent.click(q.getByRole("switch", { name: "regexImport.enableAfterImport" }));
    expect(q.getByRole("switch", { name: "regexImport.enableAfterImport" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(q.getByText("preset_import_btn"));

    await waitFor(() => expect(createRegexProfileBundleMock).toHaveBeenCalledTimes(1));
    const body = createRegexProfileBundleMock.mock.calls[0][0];
    expect(body).toMatchObject({
      name: "VT source",
      disabled: false, // toggle ON → active master
      links: [{ targetType: "preset", targetId: "preset-1" }], // EXISTING preset
    });
    // Source-disabled rule stays disabled even under the active Profile.
    expect(body.rules.map((rule: { disabled?: boolean }) => rule.disabled)).toEqual([true]);
    // Target "current" creates no preset — only the bundle fired.
    expect(onCreate).not.toHaveBeenCalled();
    // The VT lossless draft replacement ran (the system field now carries
    // the imported DTO's system verbatim — plain value check per R8).
    const system = q.getByPlaceholderText("system_prompt_placeholder") as HTMLTextAreaElement;
    await waitFor(() => expect(system.value).toBe("VT lossless system"));
  });

  test("zero embedded rules: the import stays regex-free — zero regex API calls", async () => {
    const plain = new File([
      JSON.stringify({
        name: "Plain preset",
        prompts: [
          { identifier: "main", name: "Main", role: "system", content: "text", injection_position: 0, injection_depth: 4, injection_order: 100, enabled: true },
        ],
      }),
    ], "plain.json", { type: "application/json" });
    const { view, onCreate } = renderManager({ presets: [simplePreset()] });
    await openPresetImportPreview(view, plain, "Plain preset");
    const q = within(view.baseElement);
    // No card at all.
    expect(q.queryByRole("switch")).toBeNull();

    fireEvent.click(q.getByText("preset_import_btn"));

    // Default target is "current": the draft merge fires (the system field
    // appends the imported block), nothing else does. Plain value check —
    // getByDisplayValue's normalizer collapses the newlines (R8 idiom).
    const system = q.getByPlaceholderText("system_prompt_placeholder") as HTMLTextAreaElement;
    await waitFor(() => expect(system.value).toBe("sys\n\ntext"));
    expect(createRegexProfileBundleMock).not.toHaveBeenCalled();
    expect(createRegexPresetMock).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

// ── SP-9: service prompts tab ───────────────────────────────────────────
describe("PromptManagerModal — service prompts tab (SP-9)", () => {
  function makeServiceProfile(overrides: Partial<ServicePromptProfile> = {}): ServicePromptProfile {
    return {
      id: "default",
      name: "Default",
      isDefault: true,
      sortOrder: 0,
      overrides: {},
      createdAt: "",
      updatedAt: "",
      ...overrides,
    };
  }
  function makeResolved(overrides: Partial<Record<ServicePromptFieldKey, string>> = {}): Record<ServicePromptFieldKey, { override: string | null; default: string }> {
    const map: Record<string, { override: string | null; default: string }> = {};
    for (const k of SERVICE_PROMPT_FIELD_KEYS) {
      map[k] = { override: overrides[k] ?? null, default: `default-${k}-value` };
    }
    return map;
  }

  test("four tab labels render", async () => {
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    expect(within(view.baseElement).getByText("promptManager.tabPresets")).toBeTruthy();
    expect(within(view.baseElement).getByText("promptManager.regex.tabLabel")).toBeTruthy();
    expect(within(view.baseElement).getByText("promptManager.servicePrompts.tabLabel")).toBeTruthy();
    expect(within(view.baseElement).getByText("promptManager.servicePrompts.tabLabelImages")).toBeTruthy();
  });

  test("service tab stays lazy: no service fetch until switched", async () => {
    listServiceProfilesMock.mockResolvedValue({ profiles: [makeServiceProfile()], activeProfileId: null });
    useModalStore.setState({ isPromptManagerOpen: true });
    render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    // Rendered on presets tab — service API not touched.
    expect(listServiceProfilesMock).not.toHaveBeenCalled();
    expect(getServiceDetailMock).not.toHaveBeenCalled();
  });

  test("switching to service tab fetches list and renders master + footer", async () => {
    const def = makeServiceProfile();
    const p2 = { ...makeServiceProfile(), id: "p2", name: "Alpha", isDefault: false };
    listServiceProfilesMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
    getServiceDetailMock.mockResolvedValue({ profile: def, resolved: makeResolved() });
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.servicePrompts.tabLabel"));
    await waitFor(() => expect(listServiceProfilesMock).toHaveBeenCalled());
    await waitFor(() => expect(within(view.baseElement).getByText("promptManager.servicePrompts.masterTitle")).toBeTruthy());
    // Master shows both profiles (Default + Alpha)
    await waitFor(() => expect(within(view.baseElement).getByText("Alpha")).toBeTruthy());
    // Detail and footer from pane are rendered
    await waitFor(() => expect(getServiceDetailMock).toHaveBeenCalled());
  });

  test("service detail switches dirty tracking via pane", async () => {
    const def = makeServiceProfile();
    const p2 = { ...makeServiceProfile(), id: "p2", name: "Alpha", isDefault: false, overrides: { summary: "hi" } };
    listServiceProfilesMock.mockResolvedValue({ profiles: [def, p2], activeProfileId: null });
    getServiceDetailMock.mockImplementation(async (id: string) => {
      if (id === "default") return { profile: def, resolved: makeResolved() };
      return { profile: p2, resolved: makeResolved({ summary: "hi" }) };
    });
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.servicePrompts.tabLabel"));
    await waitFor(() => expect(listServiceProfilesMock).toHaveBeenCalled());
    // Click Alpha row to load its detail
    await waitFor(() => expect(within(view.baseElement).getByText("Alpha")).toBeTruthy());
    const alphaEl = within(view.baseElement).getByText("Alpha");
    await act(async () => { fireEvent.click(alphaEl); });
    await waitFor(() => expect(getServiceDetailMock.mock.calls.some((c) => c[0] === "p2")).toBe(true));
    // Detail shows the service editor: family accordion headings render
    // collapsed by default; opening them reveals the field textareas.
    await waitFor(() => {
      expect(view.baseElement.textContent).toContain("promptManager.servicePrompts.family.assistant");
    });
    const familyButtons = Array.from(view.baseElement.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("promptManager.servicePrompts.family."),
    );
    expect(familyButtons.length).toBeGreaterThan(0);
    for (const btn of familyButtons) {
      await act(async () => { fireEvent.click(btn); });
    }
    await waitFor(() => {
      const tas = view.baseElement.querySelectorAll("textarea");
      expect(tas.length).toBeGreaterThan(0);
    });
  });

  test("images tab stays lazy until switched, then renders template rows without service-profile chrome", async () => {
    listImagePromptTemplatesMock.mockResolvedValue(makeImagePromptTemplates());
    listImagePromptFamiliesMock.mockResolvedValue({ families: imagePromptFamilies });
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );

    expect(listImagePromptProfilesMock).not.toHaveBeenCalled();
    expect(listServiceProfilesMock).not.toHaveBeenCalled();
    fireEvent.click(within(view.baseElement).getByText("promptManager.servicePrompts.tabLabelImages"));
    await waitFor(() => expect(listImagePromptProfilesMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(view.baseElement).getByTestId("image-prompt-template-row-assist")).toBeTruthy());
    expect(listServiceProfilesMock).not.toHaveBeenCalled();
    expect(view.baseElement.querySelectorAll("[data-testid^='image-prompt-template-row-']").length).toBe(10);
    expect(view.baseElement.querySelector("[data-testid^='service-row-']")).toBeNull();
    // The drill-down seam now fires per PROFILE row (the master list) — two
    // profiles here, two drill nodes.
    expect(within(view.baseElement).getAllByText("drill").length).toBe(2);
  });

  test("images tab quality draft participates in the modal close guard", async () => {
    listImagePromptTemplatesMock.mockResolvedValue(makeImagePromptTemplates());
    listImagePromptFamiliesMock.mockResolvedValue({ families: imagePromptFamilies });
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal
        presets={[advancedPreset()]}
        activePresetId="preset-1"
        setActivePresetId={mock()}
        onCreate={mock(async () => null)}
        onUpdate={mock(async () => true)}
        onDelete={mock(async () => true)}
        onReorder={mock(async () => true)}
      />,
    );
    const q = within(view.baseElement);
    fireEvent.click(q.getByText("promptManager.servicePrompts.tabLabelImages"));
    await waitFor(() => expect(q.getByTestId("image-prompt-template-row-portrait")).toBeTruthy());
    const portraitRow = q.getByTestId("image-prompt-template-row-portrait");
    fireEvent.click(portraitRow.querySelector("button")!);
    fireEvent.click(q.getByTestId("image-prompt-template-family-portrait"));
    await waitFor(() => expect(q.getAllByText("imagePromptTemplates.family.pony").length).toBeGreaterThan(0));
    fireEvent.click(q.getAllByText("imagePromptTemplates.family.pony").at(-1)!);
    fireEvent.click(await waitFor(() => q.getByRole("switch", { name: "imagePromptTemplates.customQualityToggle" })));
    fireEvent.click(q.getByText("promptManager.tabPresets"));
    await waitFor(() => expect(q.queryByTestId("image-prompt-template-row-portrait")).toBeNull());

    const closeBtn = q.getAllByText("close")[0]!;
    fireEvent.click(closeBtn);
    await waitFor(() => expect(q.getByText("unsaved_changes_title")).toBeTruthy());
  });
});

