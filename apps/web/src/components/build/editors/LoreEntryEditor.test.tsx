/**
 * LoreEntryEditor — react-hook-form field-binding characterization.
 *
 * Pins that the editor's migrated fields bind DIRECTLY to the lifted RHF form
 * (register / Controller), not to the `entry` prop + `updateAct` round-trip:
 * editing a migrated field updates `form.getValues` + `formState.isDirty` and
 * does NOT call `updateAct` (the form is the direct input; the form→entries
 * mirror in useLorebookEditorState keeps the master list live). Extended per
 * field group as the Step 4 migration proceeds (scalars → numbers/selects →
 * toggles → arrays); once every field is bound, `updateAct` is removed.
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
  const updateAct = vi.fn();
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
          entry={entry}
          entryId={entry.id}
          lorebookId={entry.lorebookId}
          updateAct={updateAct}
          onDeleted={vi.fn()}
          isMobile={false}
          t={(k: string) => k}
          existingGroups={[]}
        />
      </FormProvider>
    );
  }
  const result = render(<Harness />);
  return { form: formHolder.current!, updateAct, ...result };
}

describe("LoreEntryEditor (RHF field binding)", () => {
  it("title binds to the form via register (not updateAct)", () => {
    const { form, updateAct, container } = renderEditor(makeEntry());
    const title = container.querySelector<HTMLInputElement>('input[name="title"]')!;
    // register seeds the input from the form defaultValues (uncontrolled via ref).
    expect(title.value).toBe("Goblin");
    fireEvent.change(title, { target: { value: "Hobgoblin" } });
    expect(form.getValues("title")).toBe("Hobgoblin");
    expect(form.formState.isDirty).toBe(true);
    // migrated field: the form is the direct input, updateAct is NOT called.
    expect(updateAct).not.toHaveBeenCalled();
  });

  it("groupName binds to the form via register (advanced settings)", () => {
    const { form, updateAct, getByText, container } = renderEditor(
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
    expect(updateAct).not.toHaveBeenCalled();
  });
});
