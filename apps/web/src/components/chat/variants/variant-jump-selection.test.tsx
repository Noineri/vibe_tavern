/**
 * MAE-53 variant jump browser — selection + immutable-ID starring.
 *
 * Pins the dual-action contract layered onto the existing `> 6` variant jump
 * browser (desktop Popover + mobile BottomSheet):
 *
 *   - The `> 6` GATE is unchanged: VariantControls renders the plain counter
 *     for ≤ 6 variants; the jump browser appears only above that threshold.
 *   - Row selection still jumps (onSelect fires with the index) AND closes the
 *     surface (Popover/Sheet) — the pre-existing jump behavior is preserved.
 *   - The star toggle is INDEPENDENT of selection: tapping it fires toggleStar
 *     on the ephemeral store keyed by the immutable variantId; it does NOT
 *     fire onSelect and does NOT close the surface — the user can star several
 *     variants in one open.
 *   - The selected checkmark (data-selected) and the starred glyph
 *     (data-variant-star + aria-pressed) are distinct DOM nodes with distinct
 *     testids — a variant can be starred-without-selected and vice versa.
 *   - Stars are IMMUTABLE-ID-keyed: after a variant deletion + index
 *     recompaction + pruneStaleStars, the star stays attached to the surviving
 *     variant's ID, not to its (now-shifted) display index.
 *   - Model + preset metadata render per row on both surfaces.
 *
 * The store (useMessageAiEditorStore) is the REAL store — the toggleStar +
 * pruneStaleStars behavior is exercised end-to-end, not mocked. Only useT is
 * mocked (returns the raw key string) so aria-labels assert against stable keys.
 */
import { describe, test, expect, beforeAll, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { brandId, type MessageId, type MessageVariantId } from "@vibe-tavern/domain";
import { useMessageAiEditorStore } from "../../../stores/message-ai-editor-store.js";
import { VariantControls } from "./variant-controls.js";
import { VariantJump } from "./variant-jump.js";

const NOOP = () => {};

vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: NOOP,
    ready: true,
  }),
}));

beforeAll(() => {
  if (typeof window !== "undefined") {
    if (!window.matchMedia) {
      window.matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: NOOP, removeEventListener: NOOP,
        addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    }
    if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      (window as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  }
});

const MESSAGE_ID_RAW = "msg-1";
const MESSAGE_ID = brandId<MessageId>(MESSAGE_ID_RAW);

function variant(raw: string): MessageVariantId {
  return brandId<MessageVariantId>(raw);
}

/** Builds N picker items with stable IDs v-0..v-(N-1), model "model-N", preset
 *  "preset-N". Mirrors the shape MessageBlock derives for `pickerItems`. */
function buildItems(n: number, opts?: { ids?: string[]; models?: string[]; presets?: (string | null)[] }) {
  const ids = opts?.ids ?? Array.from({ length: n }, (_, i) => `v-${i}`);
  return ids.map((id, i) => ({
    variantId: variant(id),
    displayIndex: i + 1,
    modelLabel: opts?.models?.[i] ?? `model-${i}`,
    presetName: opts?.presets?.[i] ?? `preset-${i}`,
  }));
}

function currentStars(): MessageVariantId[] {
  return useMessageAiEditorStore.getState().starredVariantIdsByMessage[MESSAGE_ID] ?? [];
}

beforeEach(() => {
  useMessageAiEditorStore.setState({ target: null, starredVariantIdsByMessage: {} });
});

afterEach(() => {
  cleanup();
  useMessageAiEditorStore.setState({ target: null, starredVariantIdsByMessage: {} });
});

describe("MAE-53 variant jump browser — > 6 gate (unchanged)", () => {
  test("VariantControls with <= 6 variants renders the counter, NOT the jump browser", () => {
    const { container } = render(
      <VariantControls
        isBusy={false}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={6}
        items={buildItems(6)}
        onSelectVariant={NOOP}
      />,
    );
    expect(container.textContent).toContain("1/6");
    expect(container.querySelector(`[data-testid="variant-select-1"]`)).toBeNull();
  });

  test("VariantControls with > 6 variants renders the jump trigger, NOT the counter", () => {
    const items = buildItems(7);
    const { container } = render(
      <VariantControls
        isBusy={false}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        items={items}
        onSelectVariant={NOOP}
      />,
    );
    expect(container.textContent).toContain("1/7");
    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`);
    expect(trigger, "jump trigger must be rendered above the > 6 threshold").not.toBeNull();
  });
});

describe("MAE-53 desktop Popover — row select jumps; star toggle is independent", () => {
  test("row click fires onSelect(index) and closes the popover", async () => {
    const items = buildItems(7);
    const onSelect = vi.fn();
    const { container } = render(
      <VariantJump
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={onSelect}
      />,
    );

    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });
    const row3 = await waitForRowSelect(3);
    await act(async () => { fireEvent.click(row3); });

    expect(onSelect).toHaveBeenCalledWith(2);
    // Popover closed: row buttons are no longer in the document.
    expect(document.querySelector(`[data-testid="variant-select-3"]`)).toBeNull();
  });

  test("star click fires toggleStar and does NOT fire onSelect; popover stays open", async () => {
    const items = buildItems(7);
    const onSelect = vi.fn();
    const { container } = render(
      <VariantJump
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={onSelect}
      />,
    );

    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });

    const star3 = await waitForStarButton(3);
    expect(star3.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { fireEvent.click(star3); });

    expect(currentStars()).toEqual([variant("v-2")]);
    expect(onSelect).not.toHaveBeenCalled();
    // Popover STILL open: row-select buttons remain in the document.
    expect(document.querySelector(`[data-testid="variant-select-3"]`)).not.toBeNull();
    // Star reflected: aria-pressed flipped to true.
    expect(star3.getAttribute("aria-pressed")).toBe("true");
  });

  test("model and preset metadata render per row", async () => {
    const items = buildItems(7, {
      ids: ["v-0", "v-1", "v-2", "v-3", "v-4", "v-5", "v-6"],
      models: ["gpt-4o", "claude-sonnet", "gemini-pro", "llama-3", "mistral", "qwen", "phi"],
      presets: ["chat", null, "roleplay", "chat", "roleplay", "chat", "roleplay"],
    });
    const { container } = render(
      <VariantJump
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={NOOP}
      />,
    );
    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });

    const row2 = await waitForRowSelect(2);
    expect(row2.textContent).toContain("claude-sonnet");
    expect(row2.textContent).toContain("#2");

    const row3 = await waitForRowSelect(3);
    expect(row3.textContent).toContain("gemini-pro");
    // preset is null on row 3 — no "· preset-" string.
    expect(row3.textContent).not.toContain("· null");
  });

  test("selected checkmark and starred glyph are DISTINCT DOM nodes — a variant can be starred without being selected", async () => {
    const items = buildItems(7);
    const { container } = render(
      <VariantJump
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0} // row 1 selected
        variantCount={7}
        onSelect={NOOP}
      />,
    );
    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });

    // Row 3 (displayIndex=3): NOT selected, NOT starred initially.
    const select3 = await waitForRowSelect(3);
    const star3 = await waitForStarButton(3);
    expect(select3.getAttribute("data-selected")).toBe("false");
    expect(star3.getAttribute("aria-pressed")).toBe("false");
    expect(select3).not.toBe(star3);

    // Star row 3 — it becomes starred but NOT selected.
    await act(async () => { fireEvent.click(star3); });
    expect(star3.getAttribute("aria-pressed")).toBe("true");
    expect(select3.getAttribute("data-selected")).toBe("false");
    // The currently-selected row 1 (displayIndex=1) shows its check, not star.
    const select1 = document.querySelector(`[data-testid="variant-select-1"]`) as HTMLElement;
    expect(select1.getAttribute("data-selected")).toBe("true");
    const star1 = document.querySelector(`[data-testid="variant-star-1"]`) as HTMLElement;
    expect(star1.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("MAE-53 mobile BottomSheet — row tap jumps; star tap is independent", () => {
  test("row tap fires onSelect(index) and closes the sheet", async () => {
    const items = buildItems(7);
    const onSelect = vi.fn();
    const { container } = render(
      <VariantJump
        mobile
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={onSelect}
      />,
    );

    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });
    const row4 = await waitForRowSelect(4);
    await act(async () => { fireEvent.click(row4); });

    expect(onSelect).toHaveBeenCalledWith(3);
    expect(document.querySelector(`[data-testid="variant-select-4"]`)).toBeNull();
  });

  test("star tap fires toggleStar and does NOT fire onSelect; sheet stays open", async () => {
    const items = buildItems(7);
    const onSelect = vi.fn();
    const { container } = render(
      <VariantJump
        mobile
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={onSelect}
      />,
    );

    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });

    const star5 = await waitForStarButton(5);
    expect(star5.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { fireEvent.click(star5); });

    expect(currentStars()).toEqual([variant("v-4")]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector(`[data-testid="variant-select-5"]`)).not.toBeNull();
    expect(star5.getAttribute("aria-pressed")).toBe("true");
  });

  test("mobile star target is the 44px touch size (h-11 w-11)", async () => {
    const items = buildItems(7);
    const { container } = render(
      <VariantJump
        mobile
        items={items}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={NOOP}
      />,
    );
    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });
    const star2 = await waitForStarButton(2);
    expect(star2.className).toContain("h-11");
    expect(star2.className).toContain("w-11");
  });
});

describe("MAE-53 immutable-ID starring — survives index recompaction via pruneStaleStars", () => {
  test("star a variant by ID; after deletion + index compaction the star follows the ID, not the old index", async () => {
    // Initial: 7 variants v-0..v-6. Star variant v-2 (displayIndex=3).
    const initialItems = buildItems(7);
    const { container, rerender } = render(
      <VariantJump
        items={initialItems}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={7}
        onSelect={NOOP}
      />,
    );

    const trigger = container.querySelector(`[aria-label="Variant 1 of 7"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(trigger); });

    const starAtDisplay3 = await waitForStarButton(3);
    expect(starAtDisplay3.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { fireEvent.click(starAtDisplay3); });
    expect(currentStars()).toEqual([variant("v-2")]);

    // Close the popover before simulating the deletion + re-render.
    await act(async () => { fireEvent.keyDown(document.body, { key: "Escape" }); });

    // Simulate variant deletion: v-0 was deleted, the index compacted so the
    // surviving 6 variants are v-1..v-6 (each now sits at displayIndex-1).
    // The star store still holds v-2; pruneStaleStars is called with the
    // surviving IDs (mirrors what deleteVariantAction would do at the boundary).
    const survivingIds = ["v-1", "v-2", "v-3", "v-4", "v-5", "v-6"];
    act(() => {
      useMessageAiEditorStore.getState().pruneStaleStars(MESSAGE_ID, survivingIds.map(variant));
    });
    expect(currentStars()).toEqual([variant("v-2")]);

    const compactedItems = buildItems(6, { ids: survivingIds });
    rerender(
      <VariantJump
        items={compactedItems}
        messageId={MESSAGE_ID_RAW}
        selectedVariantIndex={0}
        variantCount={6}
        onSelect={NOOP}
      />,
    );

    const triggerAfter = container.querySelector(`[aria-label="Variant 1 of 6"]`) as HTMLButtonElement;
    await act(async () => { fireEvent.click(triggerAfter); });

    // v-2 now sits at displayIndex=2 (it was at displayIndex=3 before compaction).
    const starAtDisplay2 = await waitForStarButton(2);
    expect(starAtDisplay2.getAttribute("aria-pressed")).toBe("true");
    // The OLD displayIndex=3 now belongs to v-3, which was NEVER starred.
    const starAtDisplay3After = document.querySelector(`[data-testid="variant-star-3"]`) as HTMLElement;
    expect(starAtDisplay3After.getAttribute("aria-pressed")).toBe("false");
  });
});

// ─── helpers ──────────────────────────────────────────────────────────

/** Polls the document for the row-select button at `displayIndex`; Radix
 *  Popover portals its content into document.body asynchronously after the
 *  trigger click, so the assertion must wait for the portal to commit. */
async function waitForRowSelect(displayIndex: number): Promise<HTMLElement> {
  return waitForNode(`[data-testid="variant-select-${displayIndex}"]`);
}

async function waitForStarButton(displayIndex: number): Promise<HTMLElement> {
  return waitForNode(`[data-testid="variant-star-${displayIndex}"]`);
}

async function waitForNode(selector: string): Promise<HTMLElement> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${selector}`);
}
