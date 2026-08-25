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
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type { CustomInjection, PromptOrderEntry, PromptPresetDto } from "@vibe-tavern/domain";
import type { RegexPresetRecord } from "../../api/types.js";
import type { DraftData } from "./PromptManagerModal.js";
import { useModalStore } from "../../stores/modal-store.js";

const realI18nContext = await import("../../i18n/context.js");
const realTokenizer = await import("../../utils/tokenizer.js");
const realTooltip = await import("../shared/Tooltip.js");
const realUseMobile = await import("../../hooks/use-mobile.js");
const realPromptCanvasLore = await import("../../lib/prompt-canvas-lore.js");
const loadPromptCanvasLoreEntries = mock(realPromptCanvasLore.loadPromptCanvasLoreEntries);
const realRegexApi = await import("../../api/regex-api.js");
const listAllRegexPresetsMock = mock(realRegexApi.listAllRegexPresets);
const createRegexPresetMock = mock(realRegexApi.createRegexPreset);
const listAllRegexProfilesMock = mock(async () => [] as unknown as Awaited<ReturnType<typeof realRegexApi.listAllRegexProfiles>>);
const createRegexProfileMock = mock(async (body: unknown) => ({ id: "p_new", name: (body as { name?: string })?.name ?? "new", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 } as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfile>>));
const attachRegexRuleMock = mock(async (_a: unknown, _b: unknown) => null as unknown as Awaited<ReturnType<typeof realRegexApi.attachRegexRule>>);
const getRegexProfileLinksMock = mock(async () => [] as unknown as Awaited<ReturnType<typeof realRegexApi.getRegexProfileLinks>>);
const realDownload = await import("../../lib/download.js");
const downloadTextFileMock = mock(realDownload.downloadTextFile);

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
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
mock.module("../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => false }));
mock.module("../../lib/prompt-canvas-lore.js", () => ({
  ...realPromptCanvasLore,
  loadPromptCanvasLoreEntries,
}));
mock.module("../../api/regex-api.js", () => ({
  ...realRegexApi,
  listAllRegexPresets: listAllRegexPresetsMock,
  createRegexPreset: createRegexPresetMock,
  listAllRegexProfiles: listAllRegexProfilesMock,
  createRegexProfile: createRegexProfileMock,
  attachRegexRule: attachRegexRuleMock,
  getRegexProfileLinks: getRegexProfileLinksMock,
}));
mock.module("../../lib/download.js", () => ({
  ...realDownload,
  downloadTextFile: downloadTextFileMock,
}));

const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");

let PromptManagerModal: typeof import("./PromptManagerModal.js").PromptManagerModal;
let buildDuplicatePayload: typeof import("./PromptManagerModal.js").buildDuplicatePayload;
let importStandaloneRegexText: typeof import("./PromptManagerModal.js").importStandaloneRegexText;

beforeAll(async () => {
  ({ PromptManagerModal, buildDuplicatePayload, importStandaloneRegexText } = await import("./PromptManagerModal.js"));
});

afterEach(() => {
  cleanup();
  loadPromptCanvasLoreEntries.mockReset();
  listAllRegexPresetsMock.mockReset();
  createRegexPresetMock.mockReset();
  listAllRegexProfilesMock.mockReset();
  listAllRegexProfilesMock.mockResolvedValue([]);
  createRegexProfileMock.mockReset();
  createRegexProfileMock.mockResolvedValue({ id: "p_new", name: "new", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 } as unknown as Awaited<ReturnType<typeof realRegexApi.createRegexProfile>>);
  attachRegexRuleMock.mockReset();
  downloadTextFileMock.mockReset();
  useModalStore.setState({ isPromptManagerOpen: false });
});

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
  };
}

function advancedPreset(): PromptPresetDto {
  const draft = baseDraft();
  return {
    ...draft,
    id: "preset-1",
    advancedMode: true,
    aiAssistantPrompts: JSON.stringify(draft.aiAssistantPrompts),
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
 * importStandaloneRegexText — RX-16 UI surface (standalone ST regex JSON).
 *
 * Pure-seam pins (no file input, no DOM): a valid array JSON creates one
 * preset per script with the security gate enforced (disabled: true
 * regardless of the file's claim); garbage yields zero calls and zero
 * created. The injected `create` double is the only boundary under test —
 * the parser itself is pinned in packages/import-export tests.
 */
describe("importStandaloneRegexText (RX-16)", () => {
  test("valid array JSON → create called once per script, all disabled", async () => {
    const calls: Array<unknown> = [];
    const created = await importStandaloneRegexText(
      JSON.stringify([
        { scriptName: "A", findRegex: "/a/g", replaceString: "", disabled: false },
        { scriptName: "B", findRegex: "/b/g", replaceString: "x", disabled: false },
      ]),
      async (body) => {
        calls.push(body);
        return { id: `rx_${calls.length}` } as never;
      },
    );

    expect(created).toBe(2);
    expect(calls).toHaveLength(2);
    expect((calls[0] as { name?: string })?.name).toBe("A");
    expect((calls[1] as { name?: string })?.name).toBe("B");
    // Security gate: never trust the file's `disabled: false`.
    expect(calls.every((c) => (c as { disabled?: boolean }).disabled === true)).toBe(true);
  });

  test("garbage JSON → zero creates, no throw", async () => {
    const calls: unknown[] = [];
    const created = await importStandaloneRegexText("{ not json", async (body) => {
      calls.push(body);
      return { id: "rx_1" } as never;
    });
    expect(created).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("single-object shape (the common ST export) is accepted", async () => {
    const calls: Array<unknown> = [];
    const created = await importStandaloneRegexText(
      JSON.stringify({ scriptName: "Solo", findRegex: "/s/g", replaceString: "" }),
      async (body) => {
        calls.push(body);
        return { id: "rx_1" } as never;
      },
    );
    expect(created).toBe(1);
    expect((calls[0] as { name?: string })?.name).toBe("Solo");
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
      id,
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
      createdAt: 0,
      updatedAt: 0,
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
      id,
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
      createdAt: 0,
      updatedAt: 0,
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
    createRegexPresetMock.mockResolvedValue({ ...fullRecord("rx_2", "copy"), id: "rx_2" });

    const copyBtn = within(view.baseElement).getAllByLabelText("promptManager.regex.copy")[0];
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

    const exportBtn = within(view.baseElement).getAllByLabelText("promptManager.regex.export")[0];
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
  function profileRecord(id: string, name: string, sortOrder = 0) {
    return { id, name, disabled: false, isGlobal: true, sortOrder, createdAt: 0, updatedAt: 0 };
  }
  function regexRecord(id: string, name: string, profileId: string | null = null): RegexPresetRecord {
    return {
      id, name, findRegex: "/x/g", replaceString: "", trimStrings: [], substituteRegex: 0, disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null, placement: [2], isGlobal: false, sortOrder: 0, profileId, createdAt: 0, updatedAt: 0,
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

  test("member rule's status dot reflects the PROFILE gate: enabled-but-unbound profile → red dot on both the profile row and its member (R-13b owner spec)", async () => {
    // Enabled, non-global, zero profile links → applies in NO chat: the
    // profile row dot is red AND the member's dot must be red too (a green
    // member dot would claim the rule fires while the gate keeps it dead).
    const unboundProfile = { id: "pu", name: "UnboundProf", disabled: false, isGlobal: false, sortOrder: 0, createdAt: 0, updatedAt: 0 };
    listAllRegexPresetsMock.mockResolvedValue([regexRecord("m1", "MemRule", "pu")]);
    listAllRegexProfilesMock.mockResolvedValue([unboundProfile]);
    getRegexProfileLinksMock.mockResolvedValue([]);
    useModalStore.setState({ isPromptManagerOpen: true });
    const view = render(
      <PromptManagerModal presets={[advancedPreset()]} activePresetId="preset-1" setActivePresetId={mock()} onCreate={mock(async () => null)} onUpdate={mock(async () => true)} onDelete={mock(async () => true)} onReorder={mock(async () => true)} />,
    );
    fireEvent.click(within(view.baseElement).getByText("promptManager.regex.tabLabel"));
    await waitFor(() => expect(within(view.baseElement).getByText("UnboundProf")).toBeTruthy());
    // Expand the profile so the member row renders.
    fireEvent.click(view.getAllByLabelText("promptManager.regex.expandProfile")[0]);
    await waitFor(() => expect(within(view.baseElement).getByText("MemRule")).toBeTruthy());
    // Both the profile row and the member row carry the red "unbound" dot.
    await waitFor(() => {
      expect(view.getAllByLabelText("promptManager.regex.badgeUnboundReason").length).toBe(2);
    });
  });
});

