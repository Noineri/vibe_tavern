/**
 * LoreEntryEditor — react-hook-form field-binding characterization.
 *
 * Pins that the editor's fields bind DIRECTLY to the lifted RHF form
 * (register / ControlledField): editing a field updates `form.getValues` +
 * `formState.isDirty`. The form→entries mirror in useLorebookEditorState keeps
 * the master list live + re-arms the debounced autosave. There is no `entry`
 * prop or `updateAct` bridge — the form is the direct input.
 *
 * Runner: vitest (apps/web — see vitest.config.ts; vi.mock is file-scoped).
 * Heavy subtrees (ActivationTestPanel, CharacterFilterPicker, LoreKeysAiPill,
 * AiAssistantModal) are stubbed — this test targets the editor's own field
 * binding, not the children's rendering.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, fireEvent } from "@testing-library/react";
import { useForm, FormProvider, type UseFormReturn } from "react-hook-form";
import { LoreEntryEditor } from "./LoreEntryEditor.js";
import type { LoreEntryRecord } from "../../../app-client.js";

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
vi.mock("../../../stores/snapshot-store.js", () => ({
  useActiveCharacter: () => null,
  useActivePersona: () => null,
}));
// CustomTooltip (Radix) needs a TooltipProvider context irrelevant here.
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ActivationTestPanel.js", () => ({
  ActivationTestPanel: () => null,
}));
vi.mock("./character-filter-picker.js", () => ({
  CharacterFilterPicker: () => null,
}));
vi.mock("./lore-keys-ai-pill.js", () => ({
  LoreKeysAiPill: () => null,
}));
vi.mock("../../shared/AiAssistantModal.js", () => ({
  AiAssistantModal: () => null,
}));

function makeEntry(overrides: Partial<LoreEntryRecord> = {}): LoreEntryRecord {
  return {
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
    delayWindow: 0,
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
  const formHolder: { current: UseFormReturn<LoreEntryRecord> | null } = {
    current: null,
  };
  function Harness() {
    const form = useForm<LoreEntryRecord>({ defaultValues: entry });
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
          onDeleted={vi.fn()}
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

describe("LoreEntryEditor (RHF field binding)", () => {
  it("title binds to the form via register", () => {
    const { form, container } = renderEditor(makeEntry());
    const title = container.querySelector<HTMLInputElement>('input[name="title"]')!;
    // register seeds the input from the form defaultValues (uncontrolled via ref).
    expect(title.value).toBe("Goblin");
    fireEvent.change(title, { target: { value: "Hobgoblin" } });
    expect(form.getValues("title")).toBe("Hobgoblin");
    expect(form.formState.isDirty).toBe(true);
  });

  it("groupName binds to the form via register (advanced settings)", () => {
    const { form, getByText, container } = renderEditor(
      makeEntry({ groupName: "foes" }),
    );
    // open the advanced-settings disclosure (t identity → label is the i18n key)
    fireEvent.click(getByText(/lore_advanced_settings/));
    const groupName = container.querySelector<HTMLInputElement>(
      'input[name="groupName"]',
    )!;
    expect(groupName.value).toBe("foes");
    fireEvent.change(groupName, { target: { value: "bosses" } });
    expect(form.getValues("groupName")).toBe("bosses");
    expect(form.formState.isDirty).toBe(true);
  });

  it("constant checkbox binds via ControlledField", () => {
    const { form, getByText } = renderEditor(makeEntry({ constant: false }));
    fireEvent.click(getByText("lore_constant"));
    expect(form.getValues("constant")).toBe(true);
    expect(form.formState.isDirty).toBe(true);
  });

  it("priority number binds via ControlledField", () => {
    const { form, getByText } = renderEditor(makeEntry({ priority: 0 }));
    fireEvent.click(getByText(/lore_advanced_settings/)); // open advanced
    // NumberInput commits on blur; scope its input via the priority FieldLabel.
    const priorityInput = getByText("lore_priority_label").parentElement!.querySelector("input")!;
    fireEvent.change(priorityInput, { target: { value: "5" } });
    fireEvent.blur(priorityInput);
    expect(form.getValues("priority")).toBe(5);
    expect(form.formState.isDirty).toBe(true);
  });

  it("keys chip-input binds via ControlledField (add on Enter)", () => {
    const { form, getByText } = renderEditor(makeEntry({ keys: ["goblin"] }));
    // The keys FieldLabel scopes the chip-input's text <input>.
    const keysInput = getByText("lore_entry_keys").parentElement!.querySelector("input")!;
    fireEvent.change(keysInput, { target: { value: "ghost" } });
    fireEvent.keyDown(keysInput, { key: "Enter" });
    expect(form.getValues("keys")).toEqual(["goblin", "ghost"]);
    expect(form.formState.isDirty).toBe(true);
  });
});
