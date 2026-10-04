/**
 * LoreEntryEditor — react-hook-form field-binding characterization.
 *
 * Pins that the editor's fields bind DIRECTLY to the lifted RHF form
 * (register / ControlledField): editing a field updates `form.getValues` +
 * `formState.isDirty`. The form→entries mirror in useLorebookEditorState keeps
 * the master list live + re-arms the debounced autosave. There is no `entry`
 * prop or `updateAct` bridge — the form is the direct input.
 *
 * Runner: bun:test with scoped happy-dom.
 * Heavy subtrees (ActivationTestPanel, CharacterFilterPicker, LoreKeysAiPill,
 * AiAssistantModal) are stubbed — this test targets the editor's own field
 * binding, not the children's rendering.
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { wireLoreEntry } from "../../../../test/wire-fixtures.js";
import type { ReactNode } from "react";
import { useForm, FormProvider, type UseFormReturn } from "react-hook-form";
import type { LoreEntryRecord } from "../../../api/types.js";
import type { LoreEntryDraft } from "./use-lorebook-editor-state.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realSnapshotStore = await import("../../../stores/snapshot-store.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realActivationTestPanel = await import("./activation-test-panel.js");
const realCharacterFilterPicker = await import("./character-filter-picker.js");
const realLoreKeysAiPill = await import("./lore-keys-ai-pill.js");
const realAiAssistantModal = await import("../../shared/AiAssistantModal.js");

describe("parseGeneratedLoreKeys", () => {
  it("accepts only string arrays and ignores case-forms metadata", () => {
    expect(realLoreKeysAiPill.parseGeneratedLoreKeys('{"keys":["dragon",{"key":"dragon","caseForms":true}],"secondaryKeys":["cave"],"caseFormsKeys":["dragon"]}'))
      .toEqual({ keys: ["dragon"], secondaryKeys: ["cave"] });
  });
});

mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../../stores/snapshot-store.js", () => ({
	...realSnapshotStore,
  useActiveCharacter: () => null,
  useActivePersona: () => null,
}));
// CustomTooltip (Radix) needs a TooltipProvider context irrelevant here.
mock.module("../../shared/Tooltip.js", () => ({
	...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
}));
mock.module("./activation-test-panel.js", () => ({
	...realActivationTestPanel,
  ActivationTestPanel: () => null,
}));
mock.module("./character-filter-picker.js", () => ({
	...realCharacterFilterPicker,
  CharacterFilterPicker: () => null,
}));
mock.module("./lore-keys-ai-pill.js", () => ({
	...realLoreKeysAiPill,
  LoreKeysAiPill: () => null,
}));
mock.module("../../shared/AiAssistantModal.js", () => ({
	...realAiAssistantModal,
  AiAssistantModal: () => null,
}));

let LoreEntryEditor: typeof import("./LoreEntryEditor.js").LoreEntryEditor;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
	({ render, fireEvent } = await import("@testing-library/react"));
	({ default: userEvent } = await import("@testing-library/user-event"));
	({ LoreEntryEditor } = await import("./LoreEntryEditor.js"));
});

function makeEntry(overrides: Partial<LoreEntryRecord> = {}): LoreEntryRecord {
  return {
    ...wireLoreEntry(),
    id: "e1",
    lorebookId: "lb1",
    title: "Goblin",
    content: "A sneaky goblin.",
    keys: ["goblin"],
    secondaryKeys: [],
    logic: "AND_ANY",
    position: "before_char",
    depth: 0,
    priority: 0,
    stickyWindow: 0,
    cooldownWindow: 0,
    minChatMessages: 0,
    enabled: true,
    constant: false,
    probability: 100,
    ignoreBudget: false,
    role: "system",
    groupName: "",
    groupWeight: 100,
    prioritizeInclusion: false,
    useGroupScoring: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    recursionLevel: 0,
    scanDepthOverride: null,
    caseSensitive: false,
    matchWholeWords: false,
    characterFilter: [],
    characterFilterExclude: false,
    matchSources: [],
    sortOrder: 0,
    ...overrides,
  };
}

function renderEditor(entry: LoreEntryRecord) {
  // useForm is a hook — it must run inside a component. The harness creates
  // the form, provides it, and captures it via a holder so the test can read
  // getValues / formState after render.
  const formHolder: { current: UseFormReturn<LoreEntryDraft> | null } = {
    current: null,
  };
  function Harness() {
    const form = useForm<LoreEntryDraft>({ defaultValues: entry });
    formHolder.current = form;
    // RHF's formState is a proxy that only tracks/updates properties accessed
    // during render. Read isDirty here so the post-change assertion sees the
    // updated value — the real editor subscribes the same way (the autosave
    // indicator reads form.formState.isDirty each render).
    void form.formState.isDirty;
    return (
      <FormProvider {...form}>
        <LoreEntryEditor
          entryId={entry.id}
          lorebookId={entry.lorebookId}
          onDeleted={mock()}
          onDuplicate={mock()}
          isMobile={false}
          t={(k: string) => k}
          existingGroups={[]}
        />
      </FormProvider>
    );
  }
  const result = render(<Harness />);
  return { form: formHolder.current!, ...result };
}

// Several tri-state SegmentedControls (case / whole-words / group scoring)
// render identical option captions ("lore_tri_*"), so a plain
// getByText(caption) is ambiguous. Scope the click to the control whose
// FieldLabel is given: captions are looked up inside that control's wrapper.
async function clickSegment(
  getByText: (text: string) => HTMLElement,
  labelText: string,
  caption: string,
): Promise<void> {
  const scope = getByText(labelText).closest("div") as HTMLElement;
  const target = [...scope.querySelectorAll("*")].find(
    (el) => el.textContent === caption && el.children.length === 0,
  );
  if (!target) throw new Error(`segment "${caption}" not found near "${labelText}"`);
  await userEvent.setup().click(target as HTMLElement);
}

describe("LoreEntryEditor (RHF field binding)", () => {
  it("title binds to the form via register", async () => {
    const { form, container } = renderEditor(makeEntry());
    const title = container.querySelector<HTMLInputElement>('input[name="title"]')!;
    // register seeds the input from the form defaultValues (uncontrolled via ref).
    expect(title.value).toBe("Goblin");
    const user = userEvent.setup();
    await user.clear(title);
    await user.type(title, "Hobgoblin");
    expect(form.getValues("title")).toBe("Hobgoblin");
    expect(form.formState.isDirty).toBe(true);
  });

  it("groupName binds to the form via register (advanced settings)", async () => {
    const { form, getByText, container } = renderEditor(
      makeEntry({ groupName: "foes" }),
    );
    // open the advanced-settings disclosure (t identity → label is the i18n key)
    fireEvent.click(getByText(/lore_advanced_settings/));
    const groupName = container.querySelector<HTMLInputElement>(
      'input[name="groupName"]',
    )!;
    expect(groupName.value).toBe("foes");
    const user = userEvent.setup();
    await user.clear(groupName);
    await user.type(groupName, "bosses");
    expect(form.getValues("groupName")).toBe("bosses");
    expect(form.formState.isDirty).toBe(true);
  });

  it("group scoring is tri-state: inherit ↔ on ↔ off binds to the form (LG-7)", async () => {
    const { form, getByText } = renderEditor(makeEntry({ useGroupScoring: null }));
    fireEvent.click(getByText(/lore_advanced_settings/)); // open advanced
    // Inherit is the default for null — clicking through the cycle writes
    // true / false / null back into the form (the DB boundary is boolean|null).
    await clickSegment(getByText, "lore_use_group_scoring", "lore_tri_on");
    expect(form.getValues("useGroupScoring")).toBe(true);
    expect(form.formState.isDirty).toBe(true); // null → true is a real change
    await clickSegment(getByText, "lore_use_group_scoring", "lore_tri_off");
    expect(form.getValues("useGroupScoring")).toBe(false);
    // Cycling back to null returns to defaultValues — RHF rightly sees the
    // form as clean again (the DB write already happened via the autosave).
    await clickSegment(getByText, "lore_use_group_scoring", "lore_tri_inherit");
    expect(form.getValues("useGroupScoring")).toBe(null);
  });

  it("matching flags are tri-state: inherit ↔ on ↔ off binds to the form (D2)", async () => {
    const { form, getByText } = renderEditor(makeEntry({ caseSensitive: null, matchWholeWords: null }));
    // The controls live in the always-visible activation-flags row.
    await clickSegment(getByText, "lore_case_sensitive", "lore_tri_on");
    expect(form.getValues("caseSensitive")).toBe(true);
    await clickSegment(getByText, "lore_case_sensitive", "lore_tri_off");
    expect(form.getValues("caseSensitive")).toBe(false);
    await clickSegment(getByText, "lore_case_sensitive", "lore_tri_inherit");
    expect(form.getValues("caseSensitive")).toBe(null);
    expect(form.getValues("matchWholeWords")).toBe(null); // untouched sibling
  });

  it("derives match-source chips from their scanned fields and keeps the final source selected", () => {
    const { form, getByText } = renderEditor(makeEntry({ matchSources: ["chat_messages"] }));
    fireEvent.click(getByText(/lore_advanced_settings/));
    expect(getByText("match_src_chat_messages")).toBeTruthy();
    expect(getByText("char_desc_label")).toBeTruthy();
    expect(getByText("char_personality_label")).toBeTruthy();
    expect(getByText("character_depth_prompt")).toBeTruthy();
    expect(getByText("persona_desc_placeholder")).toBeTruthy();
    expect(getByText("scenario")).toBeTruthy();
    expect(getByText("creator_notes")).toBeTruthy();
    expect(getByText("authors_note_label")).toBeTruthy();
    expect(getByText("memory_tab_summary")).toBeTruthy();
    expect(getByText("match_src_character_alt_greetings")).toBeTruthy();
    expect(getByText("match_src_chat_dynamic_prompt")).toBeTruthy();
    expect(getByText("match_src_chat_summary")).toBeTruthy();
    fireEvent.click(getByText("match_src_chat_messages"));
    expect(form.getValues("matchSources")).toEqual(["chat_messages"]);
  });

  it("groups positions by anchor and binds the selected position to the form", () => {
    const { form, getByText } = renderEditor(makeEntry());
    fireEvent.click(getByText(/lore_advanced_settings/));
    expect(getByText("lore_position_anchor_char")).toBeTruthy();
    expect(getByText("lore_position_anchor_persona")).toBeTruthy();
    expect(getByText("lore_position_anchor_examples")).toBeTruthy();
    expect(getByText("lore_position_anchor_authors_note")).toBeTruthy();
    expect(getByText("pos_at_depth")).toBeTruthy();
    expect(getByText("pos_outlet")).toBeTruthy();
    fireEvent.click(getByText("pos_after_persona"));
    expect(form.getValues("position")).toBe("after_persona");
    expect(form.formState.isDirty).toBe(true);
    fireEvent.click(getByText("pos_at_depth"));
    expect(getByText("lore_depth_label")).toBeTruthy();
    fireEvent.click(getByText("pos_outlet"));
    expect(() => getByText("lore_depth_label")).toThrow();
  });

  it("constant checkbox binds via ControlledField", () => {
    const { form, getByText } = renderEditor(makeEntry({ constant: false }));
    fireEvent.click(getByText("lore_constant"));
    expect(form.getValues("constant")).toBe(true);
    expect(form.formState.isDirty).toBe(true);
  });

  it("priority number binds via ControlledField", async () => {
    const { form, getByText } = renderEditor(makeEntry({ priority: 0 }));
    fireEvent.click(getByText(/lore_advanced_settings/)); // open advanced
    // NumberInput commits on blur; scope its input via the priority FieldLabel.
    const priorityInput = getByText("lore_priority_label").parentElement!.querySelector("input")!;
    const user = userEvent.setup();
    await user.clear(priorityInput);
    await user.type(priorityInput, "5");
    fireEvent.blur(priorityInput);
    expect(form.getValues("priority")).toBe(5);
    expect(form.formState.isDirty).toBe(true);
  });

  it("keys chip-input binds via ControlledField (add on Enter)", async () => {
    const { form, getByText } = renderEditor(makeEntry({ keys: ["goblin"] }));
    // The keys FieldLabel scopes the chip-input's text <input>.
    const keysInput = getByText("lore_entry_keys").parentElement!.querySelector("input")!;
    await userEvent.setup().type(keysInput, "ghost{Enter}");
    expect(form.getValues("keys")).toEqual(["goblin", "ghost"]);
    expect(form.formState.isDirty).toBe(true);
  });

  it("renders a case-forms chip on each key and toggles its persisted flag", () => {
    const { form, getByRole } = renderEditor(makeEntry({ keys: ["dragon"], caseFormsKeys: [] }));
    const caseForms = getByRole("checkbox", { name: "lore_case_forms" });
    expect(caseForms.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(caseForms);
    expect(form.getValues("caseFormsKeys")).toEqual(["dragon"]);
    expect(caseForms.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(getByRole("button", { name: "remove_aria" }));
    expect(form.getValues("keys")).toEqual([]);
    expect(form.getValues("caseFormsKeys")).toEqual([]);
  });
});
