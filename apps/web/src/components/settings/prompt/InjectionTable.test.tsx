/**
 * InjectionTable / PromptOrderCanvas — characterization tests.
 *
 * Pins the current behavior of the prompt-order canvas (reports/
 * INJECTION_TABLE_GOD_OBJECT_AUDIT.md, step 1) so the subsequent refactors
 * (SortableZone extraction, promptOrder-by-id Map index, memoization fix)
 * cannot silently change routing, ordering, or write-path payloads.
 *
 * What is pinned:
 *  - Default zone routing (read-path): built-ins route by DEFAULT_PROMPT_ORDER
 *    via inferSlot (order < chatHistory(100) → before_chat; > 100 → after_chat);
 *    assistantPrefill is pinned & non-draggable; character V3 fields render only
 *    when characterDraft is provided.
 *  - Ordering within a zone (ascending order/defaultOrder).
 *  - in_chat depth routing (depth 4 → depth4 tier; depth 2 → depth2 tier).
 *  - Write-paths: toggle a built-in slot (existing entry flips enabled; absent
 *    entry creates enabled:false); add a custom injection (1:1 injection↔canvas-
 *    entry invariant); remove a custom injection (1:1 drop on both sides).
 *
 * What is NOT pinned here: a live DnD drag-commit (handleDragEnd). Simulating
 * @dnd-kit cross-container pointer drags under happy-dom is fragile, and steps
 * 2–3 do not change commit semantics — the read-path placement tests below pin
 * the commit's OUTPUT (zone placement derived from promptOrder). findZoneAndIndex
 * becomes a literal ZONE_ID_TO_KEY lookup map in step 2, verified structurally.
 *
 * Runner: bun:test + happy-dom.
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { CustomInjection, PromptOrderEntry } from "@vibe-tavern/domain";
import type { CanvasLoreEntrySummary } from "../../../lib/prompt-canvas-lore.js";
import type { CanvasSummaryEntry } from "../../../lib/prompt-canvas-summary.js";
import type { CharacterCanvasDraft } from "./InjectionTable.js";

useDomEnv();

// Identity i18n — assertion strings match keys verbatim. Covers useT in every
// component in the module graph (InjectionTable + all row components + shared
// Tooltip/TokenCounter), since the module mock is keyed by resolved module path.
const realI18nContext = await import("../../../i18n/context.js");
const realTokenizer = await import("../../../utils/tokenizer.js");
const realTooltip = await import("../../shared/Tooltip.js");
const realUseMobile = await import("../../../hooks/use-mobile.js");
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

// countTokens loads a real tiktoken encoding (cl100k_base) — heavy and
// irrelevant to canvas routing. Stub it to keep the test fast + isolated.
mock.module("../../../utils/tokenizer.js", () => ({ ...realTokenizer, countTokens: () => 0 }));

// CustomTooltip (Radix) needs a TooltipProvider context irrelevant to canvas
// routing; passthrough so toggle/delete buttons render unwrapped. Matches the
// convention in LorebookAccordion.test.tsx / LoreEntryEditor.test.tsx.
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// useIsMobile reads window.matchMedia, which happy-dom does not reliably
// implement. Default to desktop; one focused test opts into the mobile
// MobileExpandTextarea boundary.
let isMobile = false;
mock.module("../../../hooks/use-mobile.js", () => ({ ...realUseMobile, useIsMobile: () => isMobile }));

// @dnd-kit/core DndContext wrap-and-capture: the REAL component still renders
// (identical provider machinery for useSortable etc.), but the handler props
// are captured so tests can fire the same onDragStart/onDragEnd calls the
// library itself makes at drag end. This pins the drag-COMMIT write-path
// (handleDragEnd → commitList) without simulating cross-container pointer
// drags, which the file header notes are fragile under happy-dom.
const realDndKit = await import("@dnd-kit/core");
type RealDndContextProps = ComponentProps<typeof realDndKit.DndContext>;
const RealDndContext = realDndKit.DndContext;
let dndHandlers: RealDndContextProps | null = null;
mock.module("@dnd-kit/core", () => ({
  ...realDndKit,
  // Render the real component as a child element (NOT a direct function
  // call — that delegates its hooks into this wrapper and deadlocks React 19
  // under happy-dom, observed as a hang on the first render).
  DndContext: (props: RealDndContextProps) => {
    dndHandlers = props;
    return <RealDndContext {...props} />;
  },
}));

const { render, fireEvent, within, act } = await import("@testing-library/react");

let InjectionTable: typeof import("./InjectionTable.js").InjectionTable;
beforeAll(async () => {
  ({ InjectionTable } = await import("./InjectionTable.js"));
});

// ── Fixture ────────────────────────────────────────────────────────────

type CanvasProps = Partial<Parameters<typeof InjectionTable>[0]>;

const baseDraft = {
  system: "sys",
  jailbreak: "jb",
  prefill: "pre",
  authorsNote: "an",
  authorsNoteDepth: 4,
  authorsNotePosition: "in_chat",
  authorsNoteRole: "system",
  nsfw: "nsfw",
  enhanceDefinitions: "enh",
  mergeConsecutiveRoles: false,
};

const characterDraft: CharacterCanvasDraft = {
  charSystemPrompt: "cs",
  charPostHistory: "cph",
  charDepthPrompt: "cdp",
  charDepthPromptDepth: 4,
  charDepthPromptRole: "system",
  charDescription: "A northern warrior",
  charPersonality: "Brave and loyal",
  scenario: "A tavern at sunset",
  dialogueExamples: "{{char}}: Greetings!",
};

function makeSpies() {
  return {
    onChange: mock(),
    onPromptOrderChange: mock(),
    onUpdateField: mock(),
    onCharacterFieldUpdate: mock(),
    onPersonaDescriptionUpdate: mock(),
  };
}

type Spies = ReturnType<typeof makeSpies>;

function canvasEl(props: CanvasProps & { spies: Spies }): ReactElement {
  return (
    <InjectionTable
      injections={props.injections ?? []}
      onChange={props.spies.onChange}
      draft={props.draft ?? baseDraft}
      onUpdateField={props.onUpdateField ?? props.spies.onUpdateField}
      characterDraft={props.characterDraft ?? null}
      onCharacterFieldUpdate={props.onCharacterFieldUpdate ?? props.spies.onCharacterFieldUpdate}
      personaDescription={props.personaDescription ?? null}
      onPersonaDescriptionUpdate={props.onPersonaDescriptionUpdate ?? props.spies.onPersonaDescriptionUpdate}
      chatDynamicPrompt={props.chatDynamicPrompt ?? null}
      onChatDynamicPromptUpdate={props.onChatDynamicPromptUpdate}
      loreAnchorEntries={props.loreAnchorEntries ?? []}
      loreAnchorLoadState={props.loreAnchorLoadState ?? "idle"}
      summaryEntries={props.summaryEntries}
      summaryLoadState={props.summaryLoadState}
      promptOrder={props.promptOrder ?? []}
      onPromptOrderChange={props.onPromptOrderChange ?? props.spies.onPromptOrderChange}
    />
  );
}

function renderCanvas(props: CanvasProps & { spies?: Spies } = {}) {
  const spies = props.spies ?? makeSpies();
  const { spies: _omit, ...canvasProps } = props;
  const view = render(canvasEl({ ...canvasProps, spies }));
  renderedBase = view.baseElement;
  return { ...view, spies };
}

// ── DOM helpers ────────────────────────────────────────────────────────

let renderedBase: HTMLElement;

function queries() {
  return within(renderedBase);
}

/** Assert `labels` appear in `text` in the given order (ascending document order). */
function expectOrdered(text: string, labels: string[]) {
  let prev = -1;
  for (const label of labels) {
    const idx = text.indexOf(label);
    expect(idx, `expected "${label}" to be present in the canvas`).toBeGreaterThan(-1);
    expect(idx, `expected "${label}" to come after the previous label`).toBeGreaterThan(prev);
    prev = idx;
  }
}

/** Click the accessible enable/disable toggle owned by the card with `label`.
 *  The control is located by semantic state rather than its visual glyph. */
function clickDotToggle(label: string) {
  const labelEl = queries().getByText(label);
  let node: HTMLElement | null = labelEl;
  while (node) {
    const toggle = within(node)
      .queryAllByRole("button")
      .find((button) => {
        const ariaLabel = button.getAttribute("aria-label");
        return ariaLabel === "cc_enabled" || ariaLabel === "cc_disabled";
      });
    if (toggle) {
      fireEvent.click(toggle);
      return;
    }
    node = node.parentElement;
  }
  throw new Error(`no enable/disable toggle found walking up from label "${label}"`);
}

/** Click the trash delete button of a custom-injection row. The CanvasCard
 *  remove button carries aria-label `cc_remove`; identified by that aria-label
 *  while walking up from the row's visible name. */
function clickDelete(rowName: string) {
  const nameEl = queries().getByText(rowName);
  let node: HTMLElement | null = nameEl;
  while (node) {
    const del = within(node)
      .queryAllByRole("button")
      .find((b) => b.getAttribute("aria-label") === "cc_remove");
    if (del) {
      fireEvent.click(del);
      return;
    }
    node = node.parentElement;
  }
  throw new Error(`no delete button found walking up from row name "${rowName}"`);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("PromptOrderCanvas — characterization", () => {
  it("uses geometric drag and toggle indicators without font-glyph coupling", () => {
    const { container } = renderCanvas();
    const card = container.querySelector('[data-canvas-identifier="main"]') as HTMLElement;
    const drag = within(card).getByRole("button", { name: "drag_prompt_item_aria" });
    const toggle = within(card).getByRole("button", { name: "cc_enabled" });

    expect(drag.querySelector("svg")).toBeTruthy();
    expect(toggle.querySelector(".canvas-card-toggle-glyph")).toBeTruthy();
    expect(toggle.textContent).toBe("");
  });

  it("routes built-ins to before_chat/after_chat by default order, pins prefill, hides char fields without characterDraft", () => {
    const { container } = renderCanvas();
    const text = container.textContent!;

    // before_chat tier: defaultOrder < chatHistory (100)
    const beforeLabels = [
      "system_prompt",
      "prompt_slot_world_info_before",
      "prompt_slot_persona",
      "prompt_slot_character_description",
      "prompt_slot_character_personality",
      "scenario",
      "authors_note_label",
      "enhance_definitions",
      "nsfw_prompt",
      "prompt_slot_world_info_after",
      "prompt_slot_dialogue_examples",
    ];
    for (const l of beforeLabels) expect(text).toContain(l);

    // jailbreak (defaultOrder 110 > 100) → after_chat; prefill pinned after it
    expect(text).toContain("post_history_instructions");
    expect(text).toContain("prefill_assistant");

    // character V3 fields absent without characterDraft
		expect(queries().queryByText("character_system_prompt")).toBeNull();
		expect(queries().queryByText("character_post_history")).toBeNull();
		expect(queries().queryByText("character_depth_prompt")).toBeNull();

    // Pale category fills replace both source badges and the old icon legend.
    expect(text).not.toContain("editable_badge");
    expect(text).not.toContain("char_badge");
    expect(text).not.toContain("cc_legend_toggle");

    // whole-canvas order: before items → jailbreak → prefill
    expectOrdered(text, [...beforeLabels, "post_history_instructions", "prefill_assistant"]);
  });

  it("renders character V3 fields only when characterDraft is provided", () => {
    const { rerender, spies } = renderCanvas();
		expect(queries().queryByText("character_system_prompt")).toBeNull();

		rerender(canvasEl({ spies, characterDraft }));
		expect(queries().getByText("character_system_prompt")).toBeTruthy();
		expect(queries().getByText("character_post_history")).toBeTruthy();
    // charDepthPrompt's semantic advanced default is in_chat depth 4, so it
    // lives inside the collapsed chat-history accordion rather than before_chat.
    fireEvent.click(queries().getByRole("button", { name: /prompt_slot_chat_history/ }));
		expect(queries().getByText("character_depth_prompt")).toBeTruthy();
  });

  it("binds character and persona source content to editable CanvasCards", () => {
    const { container, spies } = renderCanvas({
      characterDraft,
      personaDescription: "A wandering scholar",
    });

    const characterCard = container.querySelector<HTMLElement>('[data-canvas-identifier="charDescription"]');
    expect(characterCard).toBeTruthy();
    expect(characterCard!.textContent).not.toContain("char_badge");
    expect(characterCard!.textContent).not.toContain("cc_read_only");
    expect(characterCard!.classList.contains("canvas-card--entity")).toBe(true);
    fireEvent.click(within(characterCard!).getByText("prompt_slot_character_description"));
    const characterTextarea = within(characterCard!).getByRole("textbox") as HTMLTextAreaElement;
    expect(characterTextarea.value).toBe("A northern warrior");
    fireEvent.change(characterTextarea, { target: { value: "An eastern mage" } });
    expect(spies.onCharacterFieldUpdate).toHaveBeenCalledWith("charDescription", "An eastern mage");

    const personaCard = container.querySelector<HTMLElement>('[data-canvas-identifier="personaDescription"]');
    expect(personaCard).toBeTruthy();
    expect(personaCard!.textContent).not.toContain("persona_badge");
    expect(personaCard!.classList.contains("canvas-card--entity")).toBe(true);
    fireEvent.click(within(personaCard!).getByText("prompt_slot_persona"));
    const personaTextarea = within(personaCard!).getByRole("textbox") as HTMLTextAreaElement;
    expect(personaTextarea.value).toBe("A wandering scholar");
    fireEvent.change(personaTextarea, { target: { value: "A retired navigator" } });
    expect(spies.onPersonaDescriptionUpdate).toHaveBeenCalledWith("A retired navigator");
  });

  it("expands lore anchors into position-filtered linked-entry lists", () => {
    const loreAnchorEntries: CanvasLoreEntrySummary[] = [
      {
        id: "before-1",
        lorebookId: "book-1",
        lorebookName: "Character Lore",
        title: "Before Entry",
        position: "before_char",
        priority: 10,
        sortOrder: 0,
      },
      {
        id: "after-1",
        lorebookId: "book-2",
        lorebookName: "Global Lore",
        title: "After Entry",
        position: "after_char",
        priority: 20,
        sortOrder: 0,
      },
    ];
    const { container } = renderCanvas({ loreAnchorEntries, loreAnchorLoadState: "ready" });

    const beforeCard = container.querySelector<HTMLElement>('[data-canvas-identifier="worldInfoBefore"]');
    expect(beforeCard).toBeTruthy();
    fireEvent.click(within(beforeCard!).getByText("prompt_slot_world_info_before"));
    expect(within(beforeCard!).getByText("Before Entry")).toBeTruthy();
    expect(within(beforeCard!).getByText("Character Lore")).toBeTruthy();
    expect(within(beforeCard!).queryByText("After Entry")).toBeNull();

    const afterCard = container.querySelector<HTMLElement>('[data-canvas-identifier="worldInfoAfter"]');
    expect(afterCard).toBeTruthy();
    fireEvent.click(within(afterCard!).getByText("prompt_slot_world_info_after"));
    expect(within(afterCard!).getByText("After Entry")).toBeTruthy();
    expect(within(afterCard!).getByText("Global Lore")).toBeTruthy();
    expect(within(afterCard!).queryByText("Before Entry")).toBeNull();
  });

  it("orders before_chat items by ascending default order", () => {
    const { container } = renderCanvas();
    expectOrdered(container.textContent!, [
      "system_prompt",
      "prompt_slot_world_info_before",
      "prompt_slot_persona",
      "prompt_slot_character_description",
      "prompt_slot_character_personality",
      "scenario",
      "authors_note_label",
      "enhance_definitions",
      "nsfw_prompt",
      "prompt_slot_world_info_after",
      "prompt_slot_dialogue_examples",
    ]);
  });

  it("routes in_chat items to depth tiers by their depth (read-path)", () => {
    const injections: CustomInjection[] = [
      { identifier: "custom_t", name: "TestInj", content: "x", role: "system" },
    ];
    const { rerender, container } = renderCanvas({
      injections,
      promptOrder: [
        { identifier: "custom_t", enabled: true, order: 0, zone: "in_chat", depth: 4, kind: "custom" },
      ],
    });

    // Open the chat-history accordion so the depth tiers render.
		fireEvent.click(queries().getByRole("button", { name: /prompt_slot_chat_history/ }));

    // depth 4 → inside the depth4 tier (after its label, before the depth3 tier label)
    let text = container.textContent!;
    expectOrdered(text, ["depth_zone_4plus", "TestInj"]);
    expect(text.indexOf("TestInj")).toBeLessThan(text.indexOf("depth_zone_3"));

    // Re-render at depth 2 → moves to the depth2 tier. Accordion stays open
    // (rerender preserves component state), so no second click.
    rerender(
      canvasEl({
        spies: makeSpies(),
        injections,
        promptOrder: [
          { identifier: "custom_t", enabled: true, order: 0, zone: "in_chat", depth: 2, kind: "custom" },
        ],
      }),
    );
    text = container.textContent!;
    expectOrdered(text, ["depth_zone_2", "TestInj"]);
    expect(text.indexOf("TestInj")).toBeLessThan(text.indexOf("depth_zone_1"));
  });

  it("stacks the canvas header on mobile and uses the shared tooltip for the merge checkbox", () => {
    const spies = makeSpies();
    renderCanvas({ spies });

    const header = queries().getByTestId("prompt-canvas-header");
    expect(header.className).toContain("flex-col");
    expect(header.className).toContain("sm:flex-row");

    const checkbox = queries().getByRole("checkbox", { name: "merge_consecutive_roles" });
    expect(checkbox.getAttribute("title")).toBeNull();
    fireEvent.click(checkbox);
    expect(spies.onUpdateField).toHaveBeenCalledWith("mergeConsecutiveRoles", true);
  });

  it("renders a custom injection through a syntax-palette-tinted CanvasCard with token counter and working role control", () => {
    const spies = makeSpies();
    const injection: CustomInjection = { identifier: "custom_t", name: "TestInj", content: "x", role: "system" };
    const { container } = renderCanvas({
      spies,
      injections: [injection],
      promptOrder: [
        { identifier: "custom_t", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "custom" },
      ],
    });

    const card = container.querySelector('[data-canvas-identifier="custom_t"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.classList.contains("canvas-card--custom")).toBe(true);
    const removeButton = within(card).getByRole("button", { name: "cc_remove" });
    expect(removeButton.querySelector("svg")).toBeTruthy();
    const headerChildren = Array.from(card.firstElementChild?.children ?? []);
    const chevron = headerChildren.find((child) => child.textContent === "▶");
    expect(chevron).toBeTruthy();
    expect(headerChildren.indexOf(removeButton)).toBeLessThan(headerChildren.indexOf(chevron!));
    expect(card.textContent).toContain("0 tokens_label");
    expect(card.textContent).toContain("system");

    fireEvent.click(within(card).getByText("TestInj"));
    fireEvent.click(within(card).getByRole("radio", { name: "assistant" }));
    expect(spies.onChange).toHaveBeenCalledWith([{ ...injection, role: "assistant" }]);
  });

  it("toggling a built-in slot with an existing canvas entry flips enabled", () => {
    const spies = makeSpies();
    renderCanvas({
      spies,
      promptOrder: [
        { identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
      ],
    });

    clickDotToggle("system_prompt");

		expect(spies.onPromptOrderChange).toHaveBeenCalledTimes(1);
    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "main", enabled: false, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
    ]);
  });

  it("toggling a built-in slot with no canvas entry creates an enabled:false entry at its semantic default", () => {
    const spies = makeSpies();
    renderCanvas({ spies, promptOrder: [] });

    clickDotToggle("prompt_slot_world_info_before"); // worldInfoBefore marker, no entry

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "worldInfoBefore", enabled: false, kind: "built_in", zone: "before_chat", depth: null, order: 10 },
    ]);
  });

  it("changing a built-in field role with no entry creates a semantic PromptOrderEntry", () => {
    const spies = makeSpies();
    renderCanvas({ spies, promptOrder: [] });

    fireEvent.click(queries().getByText("system_prompt"));
    fireEvent.click(queries().getByRole("radio", { name: "user" }));

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "main", enabled: true, kind: "built_in", zone: "before_chat", depth: null, order: 0, role: "user" },
    ]);
  });

  it("adding a custom injection appends the injection and its canvas entry (1:1 invariant)", () => {
    const spies = makeSpies();
    renderCanvas({ spies, injections: [], promptOrder: [] });

		fireEvent.click(queries().getByRole("button", { name: /preset_injection_add/ }));

		expect(spies.onChange).toHaveBeenCalledTimes(1);
    const newInjs = spies.onChange.mock.calls[0][0] as CustomInjection[];
    expect(newInjs).toHaveLength(1);
    expect(newInjs[0].identifier).toMatch(/^custom_/);
    expect(newInjs[0].name).toBe("");
    expect(newInjs[0].content).toBe("");
    expect(newInjs[0].role).toBe("system");

		expect(spies.onPromptOrderChange).toHaveBeenCalledTimes(1);
    const newOrder = spies.onPromptOrderChange.mock.calls[0][0] as PromptOrderEntry[];
    expect(newOrder).toHaveLength(1);
    expect(newOrder[0].identifier).toBe(newInjs[0].identifier);
    expect(newOrder[0]).toMatchObject({
      enabled: true,
      kind: "custom",
      zone: "before_chat",
      depth: null,
      order: 999,
    });
  });

  it("places Add-injection after the before_chat cards and before Chat History", () => {
    // The action moved out of the top toolbar to where add() inserts the new
    // card (last in before_chat at order 999): between the before_chat zone and
    // the Chat History header. The header (merge checkbox) and DnD semantics
    // are unchanged — only the button's location moved.
    const { container } = renderCanvas();
    const text = renderedBase.textContent!;
    const header = container.querySelector('[data-testid="prompt-canvas-header"]') as HTMLElement;
    const addButton = queries().getByRole("button", { name: /preset_injection_add/ });
    const chatHistory = queries().getByRole("button", { name: /prompt_slot_chat_history/ }).parentElement as HTMLElement;
    expectOrdered(text, ["system_prompt", "preset_injection_add", "prompt_slot_chat_history"]);
    expect(header.classList.contains("px-1.5")).toBe(true);
    expect(addButton.classList.contains("mx-1.5")).toBe(true);
    expect(addButton.classList.contains("w-full")).toBe(false);
    expect(chatHistory.classList.contains("mx-1.5")).toBe(true);
  });

  it("removing a custom injection drops the injection and its canvas entry (1:1 invariant)", () => {
    const spies = makeSpies();
    renderCanvas({
      spies,
      injections: [{ identifier: "custom_t", name: "TestInj", content: "x", role: "system" }],
      promptOrder: [
        { identifier: "custom_t", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "custom" },
      ],
    });

    clickDelete("TestInj");

    expect(spies.onChange).toHaveBeenCalledWith([]);
    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([]);
  });

  // ── Wave 6: chatDynamicPrompt canvas card ────────────────────────────

  it("mobile custom injection opens the shared fullscreen textarea and commits through the canvas update path", () => {
    const spies = makeSpies();
    isMobile = true;
    const view = renderCanvas({
      spies,
      injections: [{ identifier: "custom_mobile", name: "Mobile injection", content: "old content", role: "system" }],
      promptOrder: [
        { identifier: "custom_mobile", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "custom" },
      ],
    });

    try {
      const card = view.container.querySelector('[data-canvas-identifier="custom_mobile"]') as HTMLElement;
      fireEvent.click(within(card).getByText("Mobile injection"));
      fireEvent.click(within(card).getByTitle("expand_fullscreen"));
      const overlay = view.baseElement.querySelector(".fixed.inset-0") as HTMLElement;
      const fullscreenEditor = overlay.querySelector("textarea") as HTMLTextAreaElement;
      expect(fullscreenEditor.value).toBe("old content");
      fireEvent.change(fullscreenEditor, { target: { value: "fullscreen content" } });
      fireEvent.click(within(overlay).getByText("done_btn"));
      expect(spies.onChange).toHaveBeenCalledWith([
        { identifier: "custom_mobile", name: "Mobile injection", content: "fullscreen content", role: "system" },
      ]);
    } finally {
      isMobile = false;
      view.unmount();
    }
  });

  it("renders chatDynamicPrompt CanvasCard with editable content and default system role", () => {
    const spies = makeSpies();
    const onChatDynamicPromptUpdate = mock();
    const { container } = renderCanvas({
      spies,
      chatDynamicPrompt: "per-chat prompt",
      onChatDynamicPromptUpdate,
    });

    const card = container.querySelector<HTMLElement>('[data-canvas-identifier="chatDynamicPrompt"]');
    expect(card).toBeTruthy();
    // Should display the content.
    expect(card!.textContent).toContain("prompt_slot_chat_dynamic");
    // Default role is system.
    expect(card!.textContent).toContain("system");
    // Should be editable (has the textarea, not read-only badge).
    fireEvent.click(within(card!).getByText("prompt_slot_chat_dynamic"));
    const textarea = within(card!).getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("per-chat prompt");
    fireEvent.change(textarea, { target: { value: "updated" } });
    expect(onChatDynamicPromptUpdate).toHaveBeenCalledWith("updated");
  });

  it("chatDynamicPrompt CanvasCard toggle creates semantic PromptOrderEntry", () => {
    const spies = makeSpies();
    renderCanvas({
      spies,
      chatDynamicPrompt: "content",
      onChatDynamicPromptUpdate: mock(),
      promptOrder: [],
    });

    clickDotToggle("prompt_slot_chat_dynamic");

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "chatDynamicPrompt", enabled: false, kind: "built_in", zone: "before_chat", depth: null, order: 62 },
    ]);
  });

  it("chatDynamicPrompt CanvasCard role change creates semantic PromptOrderEntry", () => {
    const spies = makeSpies();
    renderCanvas({
      spies,
      chatDynamicPrompt: "content",
      onChatDynamicPromptUpdate: mock(),
      promptOrder: [],
    });

    fireEvent.click(queries().getByText("prompt_slot_chat_dynamic"));
    fireEvent.click(queries().getByRole("radio", { name: "user" }));

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "chatDynamicPrompt", enabled: true, kind: "built_in", zone: "before_chat", depth: null, order: 62, role: "user" },
    ]);
  });

  // ── Wave 6: chatSummary canvas card ──────────────────────────────────

  it("renders chatSummary CanvasCard as read-only with default system role", () => {
    const spies = makeSpies();
    const { container } = renderCanvas({ spies });

    const card = container.querySelector<HTMLElement>('[data-canvas-identifier="chatSummary"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("prompt_slot_chat_summary");
    // Semantic read-only lock affordance (lock glyph + tooltip), not a text badge.
    expect(card!.querySelector('[aria-label="cc_read_only"]')).toBeTruthy();
    // Summary category — system role default.
    expect(card!.textContent).toContain("system");
  });

  it("chatSummary CanvasCard toggle creates semantic PromptOrderEntry", () => {
    const spies = makeSpies();
    renderCanvas({ spies, promptOrder: [] });

    clickDotToggle("prompt_slot_chat_summary");

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "chatSummary", enabled: false, kind: "built_in", zone: "before_chat", depth: null, order: 57 },
    ]);
  });

  it("chatSummary CanvasCard exposes editable depth when routed in-chat", () => {
    const spies = makeSpies();
    const { container } = renderCanvas({
      spies,
      promptOrder: [
        { identifier: "chatSummary", enabled: true, kind: "built_in", zone: "in_chat", depth: 4, order: 57 },
      ],
    });

    // In-chat items live inside the collapsed chat-history accordion.
    fireEvent.click(queries().getByRole("button", { name: /prompt_slot_chat_history/ }));
    const card = container.querySelector<HTMLElement>('[data-canvas-identifier="chatSummary"]');
    expect(card).toBeTruthy();
    if (!card) return;
    const header = card.firstElementChild as HTMLElement | null;
    expect(header).toBeTruthy();
    if (!header) return;
    fireEvent.click(header);
    const depthInput = within(card).getByRole("textbox") as HTMLInputElement;
    fireEvent.change(depthInput, { target: { value: "6" } });
    fireEvent.blur(depthInput);

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "chatSummary", enabled: true, kind: "built_in", zone: "in_chat", depth: 6, order: 57 },
    ]);
  });

  it("expands chatSummary to reveal loaded summary memory blocks", () => {
    const spies = makeSpies();
    const { container } = renderCanvas({
      spies,
      summaryEntries: [
        { id: "s1", label: "Arc 1", content: "The heroes reached the gate.", source: "manual", summarizedFrom: 0, summarizedTo: 12, includeInContext: true },
      ],
      summaryLoadState: "ready",
    });

    const card = container.querySelector<HTMLElement>('[data-canvas-identifier="chatSummary"]');
    expect(card).toBeTruthy();
    // Collapsed: the content is hidden (not rendered until the row itself opens).
    expect(card!.textContent).not.toContain("The heroes reached the gate.");
    // Open the card body.
    fireEvent.click(within(card!).getByText("prompt_slot_chat_summary"));
    // The summary row label is visible.
    expect(within(card!).getByText("Arc 1")).toBeTruthy();
    // Open the summary row to reveal the content.
    fireEvent.click(within(card!).getByRole("button", { name: /Arc 1/ }));
    expect(within(card!).getByText("The heroes reached the gate.")).toBeTruthy();
  });

  it("expands a lore anchor entry to reveal content + activation keys", () => {
    const loreAnchorEntries: CanvasLoreEntrySummary[] = [
      {
        id: "before-1",
        lorebookId: "book-1",
        lorebookName: "Character Lore",
        title: "The Rose Gate",
        position: "before_char",
        priority: 10,
        sortOrder: 0,
        content: "A gate wreathed in roses.",
        keys: ["rose", "gate"],
        secondaryKeys: ["thorn"],
        logic: "AND(any)",
        constant: false,
        probability: 100,
        role: "system",
      },
    ];
    const { container } = renderCanvas({ loreAnchorEntries, loreAnchorLoadState: "ready" });

    const beforeCard = container.querySelector<HTMLElement>('[data-canvas-identifier="worldInfoBefore"]');
    fireEvent.click(within(beforeCard!).getByText("prompt_slot_world_info_before"));
    // Collapsed row hides content.
    expect(beforeCard!.textContent).not.toContain("A gate wreathed in roses.");
    // Expand the entry row.
    fireEvent.click(within(beforeCard!).getByRole("button", { name: /The Rose Gate/ }));
    expect(within(beforeCard!).getByText("A gate wreathed in roses.")).toBeTruthy();
    expect(within(beforeCard!).getByText("rose, gate")).toBeTruthy();
    expect(within(beforeCard!).getByText("thorn")).toBeTruthy();
  });

  // ── Drag-commit write path (regression 09.08.2026) ─────────────────────
  // User report: change a preset inject's role (persona description etc.);
  // then ANY canvas drag resets it to system. handleDragEnd → commitList
  // rebuilds EVERY canvas entry and (before the fix) omitted `role`, so the
  // pipeline fell back to each slot's hardcoded default (system). The DndContext
  // capture mock above lets us fire the exact handler pair the library fires
  // at drag end; `over: null` still exercises the full commit (the reorder
  // block is skipped, but commitList runs for every zone — "ANY drag").
  it("drag-commit preserves existing entry roles (any drag, any item)", async () => {
    const spies = makeSpies();
    const promptOrder: PromptOrderEntry[] = [
      { identifier: "main", enabled: true, kind: "built_in", zone: "before_chat", depth: null, order: 0, role: "user" },
      { identifier: "personaDescription", enabled: true, kind: "built_in", zone: "before_chat", depth: null, order: 20, role: "assistant" },
    ];
    renderCanvas({ promptOrder, spies });

    expect(dndHandlers).toBeTruthy();
    // Minimal drag lifecycle: start freezes the visual zones, end commits
    // every entry. Shapes are the subset handleDragStart/handleDragEnd read
    // ({active:{id}} / {active:{id}, over}) — cast, not `as any`.
    const startEvent = { active: { id: "slot:personaDescription" } } as unknown as Parameters<NonNullable<RealDndContextProps["onDragStart"]>>[0];
    const endEvent = { active: { id: "slot:personaDescription" }, over: null } as unknown as Parameters<NonNullable<RealDndContextProps["onDragEnd"]>>[0];
    act(() => {
      dndHandlers!.onDragStart!(startEvent);
      dndHandlers!.onDragEnd!(endEvent);
    });

    expect(spies.onPromptOrderChange).toHaveBeenCalledTimes(1);
    const next = spies.onPromptOrderChange.mock.calls[0][0] as PromptOrderEntry[];
    const main = next.find((e) => e.identifier === "main");
    const persona = next.find((e) => e.identifier === "personaDescription");
    // The dragged item's role survives the rebuild…
    expect(persona?.role).toBe("assistant");
    // …and so does every other committed entry's (commitList rebuilds ALL).
    expect(main?.role).toBe("user");
  });
});
