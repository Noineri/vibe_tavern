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
 * Runner: vitest (apps/web uses vitest, NOT bun:test). DOM via happy-dom.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, fireEvent, within, screen } from "@testing-library/react";
import type { CustomInjection, PromptOrderEntry } from "@vibe-tavern/domain";
import { InjectionTable, type CharacterCanvasDraft } from "./InjectionTable.js";

// Identity i18n — assertion strings match keys verbatim. Covers useT in every
// component in the module graph (InjectionTable + all row components + shared
// Tooltip/TokenCounter), since vi.mock keys by resolved module path.
vi.mock("../../../i18n/context.js", () => ({
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
vi.mock("../../../utils/tokenizer.js", () => ({ countTokens: () => 0 }));

// CustomTooltip (Radix) needs a TooltipProvider context irrelevant to canvas
// routing; passthrough so toggle/delete buttons render unwrapped. Matches the
// convention in LorebookAccordion.test.tsx / LoreEntryEditor.test.tsx.
vi.mock("../../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// useIsMobile reads window.matchMedia, which happy-dom does not reliably
// implement. Force desktop; the mobile fork is not the test target.
vi.mock("../../../hooks/use-mobile.js", () => ({ useIsMobile: () => false }));

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
};

const characterDraft: CharacterCanvasDraft = {
  charSystemPrompt: "cs",
  charPostHistory: "cph",
  charDepthPrompt: "cdp",
  charDepthPromptDepth: 4,
  charDepthPromptRole: "system",
};

function makeSpies() {
  return {
    onChange: vi.fn(),
    onPromptOrderChange: vi.fn(),
    onUpdateField: vi.fn(),
    onCharacterFieldUpdate: vi.fn(),
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
      promptOrder={props.promptOrder ?? []}
      onPromptOrderChange={props.onPromptOrderChange ?? props.spies.onPromptOrderChange}
    />
  );
}

function renderCanvas(props: CanvasProps & { spies?: Spies } = {}) {
  const spies = props.spies ?? makeSpies();
  const { spies: _omit, ...canvasProps } = props;
  return { ...render(canvasEl({ ...canvasProps, spies })), spies };
}

// ── DOM helpers ────────────────────────────────────────────────────────

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

/** Click the ●/○ enable/disable toggle of the card whose visible label is `label`.
 *  Walks up from the label text to the row header that owns the dot button —
 *  robust to the label being nested inside a CustomTooltip trigger span. */
function clickDotToggle(label: string) {
  const labelEl = screen.getByText(label);
  let node: HTMLElement | null = labelEl;
  while (node) {
    const dot = within(node)
      .queryAllByRole("button")
      .find((b) => b.textContent === "●" || b.textContent === "○");
    if (dot) {
      fireEvent.click(dot);
      return;
    }
    node = node.parentElement;
  }
  throw new Error(`no ●/○ toggle found walking up from label "${label}"`);
}

/** Click the trash delete button of a custom-injection row. Identified as the
 *  header button with empty text and no aria-label (drag handle = "⋮⋮" text;
 *  toggle = "●"/"○"; edit-name button carries an aria-label; delete is SVG-only). */
function clickDelete(rowName: string) {
  const nameEl = screen.getByText(rowName);
  let node: HTMLElement | null = nameEl;
  while (node) {
    const del = within(node)
      .queryAllByRole("button")
      .find((b) => b.textContent?.trim() === "" && !b.getAttribute("aria-label"));
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
    expect(screen.queryByText("character_system_prompt")).toBeNull();
    expect(screen.queryByText("character_post_history")).toBeNull();
    expect(screen.queryByText("character_depth_prompt")).toBeNull();

    // whole-canvas order: before items → jailbreak → prefill
    expectOrdered(text, [...beforeLabels, "post_history_instructions", "prefill_assistant"]);
  });

  it("renders character V3 fields only when characterDraft is provided", () => {
    const { rerender, spies } = renderCanvas();
    expect(screen.queryByText("character_system_prompt")).toBeNull();

    rerender(canvasEl({ spies, characterDraft }));
    expect(screen.getByText("character_system_prompt")).toBeTruthy();
    expect(screen.getByText("character_post_history")).toBeTruthy();
    expect(screen.getByText("character_depth_prompt")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: /prompt_slot_chat_history/ }));

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

  it("toggling a built-in slot with an existing canvas entry flips enabled", () => {
    const spies = makeSpies();
    renderCanvas({
      spies,
      promptOrder: [
        { identifier: "main", enabled: true, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
      ],
    });

    clickDotToggle("system_prompt");

    expect(spies.onPromptOrderChange).toHaveBeenCalledOnce();
    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "main", enabled: false, order: 0, zone: "before_chat", depth: null, kind: "built_in" },
    ]);
  });

  it("toggling a built-in slot with no canvas entry creates an enabled:false entry", () => {
    const spies = makeSpies();
    renderCanvas({ spies, promptOrder: [] });

    clickDotToggle("prompt_slot_world_info_before"); // worldInfoBefore marker, no entry

    expect(spies.onPromptOrderChange).toHaveBeenCalledWith([
      { identifier: "worldInfoBefore", enabled: false, kind: "built_in", zone: "before_chat", depth: null, order: 999 },
    ]);
  });

  it("adding a custom injection appends the injection and its canvas entry (1:1 invariant)", () => {
    const spies = makeSpies();
    renderCanvas({ spies, injections: [], promptOrder: [] });

    fireEvent.click(screen.getByRole("button", { name: /preset_injection_add/ }));

    expect(spies.onChange).toHaveBeenCalledOnce();
    const newInjs = spies.onChange.mock.calls[0][0] as CustomInjection[];
    expect(newInjs).toHaveLength(1);
    expect(newInjs[0].identifier).toMatch(/^custom_/);
    expect(newInjs[0].name).toBe("");
    expect(newInjs[0].content).toBe("");
    expect(newInjs[0].role).toBe("system");

    expect(spies.onPromptOrderChange).toHaveBeenCalledOnce();
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
});
