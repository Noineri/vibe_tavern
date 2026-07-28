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
import type { DraftData } from "./PromptManagerModal.js";
import { useModalStore } from "../../stores/modal-store.js";

const realI18nContext = await import("../../i18n/context.js");
const realTokenizer = await import("../../utils/tokenizer.js");
const realTooltip = await import("../shared/Tooltip.js");
const realUseMobile = await import("../../hooks/use-mobile.js");
const realPromptCanvasLore = await import("../../lib/prompt-canvas-lore.js");
const loadPromptCanvasLoreEntries = mock(realPromptCanvasLore.loadPromptCanvasLoreEntries);

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

const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");

let PromptManagerModal: typeof import("./PromptManagerModal.js").PromptManagerModal;
let buildDuplicatePayload: typeof import("./PromptManagerModal.js").buildDuplicatePayload;

beforeAll(async () => {
  ({ PromptManagerModal, buildDuplicatePayload } = await import("./PromptManagerModal.js"));
});

afterEach(() => {
  cleanup();
  loadPromptCanvasLoreEntries.mockReset();
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
