/**
 * ExperienceGalleryCard — presentation + menu-wiring tests.
 *
 * Pins the owner 2026-10-18 option-A card menu boundary: on desktop the "..."
 * trigger opens a Radix DropdownMenu holding Export / Duplicate / Delete
 * (delete in danger styling); on mobile (isMobile) the same trigger opens an
 * ActionSheet titled with the mini-app name holding the same three items.
 * Delete targets the card's first existing bound visual (the shared helper);
 * a draft card renders no footer and no menu. i18n is stubbed (key-echo
 * translator); every callback is asserted through the component's explicit
 * props.
 *
 * The desktop menu is opened via keyboard (focus + Enter): Radix menu content
 * does not open on mouse clicks under happy-dom (pointer-event gap, same
 * family as the limitation documented in RichChatRow.test.tsx) — the same
 * Root/Content/Item tree production mouse users get.
 *
 * L1 checklist: repo-relative imports only; no process-global state (mocked
 * i18n/Tooltip are module mocks, no fetch/env/registry/i18n-real patches, so
 * no afterAll restore); no sleeps (findBy queries); no platform assumptions;
 * mock.module only with the ...real spread; every assertion pins a mounted
 * state.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import { wireScript } from "../../../../test/wire-fixtures.js";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";

useDomEnv();

const realTooltip = await import("../../shared/Tooltip.js");

installI18nContextSeam();

mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
const { ExperienceGalleryCard, firstExistingBoundVisual } = await import("./experience-gallery-card.js");
({ render, fireEvent } = await import("@testing-library/react"));

function makeVisual(overrides: Partial<ExperienceVisualRow> = {}): ExperienceVisualRow {
  return {
    id: "vis_1",
    name: "Card Visual",
    source: "<!doctype html><html><body>visual</body></html>",
    sourceHash: "abc123def4567890",
    apiVersion: 1,
    compatibleManifestIds: ["board"],
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function makeScript(overrides: Partial<ScriptRecord> = {}): ScriptRecord {
  return {
    ...wireScript(),
    id: "srv_1",
    name: "Test Mini-App",
    description: "A test mini-app",
    scriptKind: "interactive",
    enabled: false,
    ...overrides,
  };
}

interface CardCalls {
  opened: string[];
  toggles: Array<[string, boolean]>;
  exports: number;
  duplicates: number;
  deletes: Array<{ scriptId: string; visualId: string | null }>;
}

function renderCard(overrides: {
  script?: ScriptRecord;
  isDraft?: boolean;
  bound?: ExperienceVisualRow[];
  available?: ExperienceVisualRow[];
  isMobile?: boolean;
} = {}) {
  const script = overrides.script ?? makeScript();
  const calls: CardCalls = { opened: [], toggles: [], exports: 0, duplicates: 0, deletes: [] };
  const result = render(
    <ExperienceGalleryCard
      script={script}
      display={{ ...script }}
      isDraft={overrides.isDraft ?? false}
      statusKey="experience_editor_disabled"
      dotClass="bg-t4"
      bound={overrides.bound ?? []}
      available={overrides.available ?? []}
      isMobile={overrides.isMobile ?? false}
      onOpen={(scriptId) => { calls.opened.push(scriptId); }}
      onToggleVisual={(visualId, bind) => { calls.toggles.push([visualId, bind]); }}
      onExport={() => { calls.exports += 1; }}
      onDuplicate={() => { calls.duplicates += 1; }}
      onDelete={(target) => { calls.deletes.push(target); }}
    />,
  );
  return { ...result, calls };
}

/** Open the desktop dropdown via keyboard (see the header note). */
async function openDesktopMenu(
  findByTestId: (testId: string) => Promise<HTMLElement>,
): Promise<void> {
  const menu = await findByTestId("experience_card_menu");
  menu.focus();
  fireEvent.keyDown(menu, { key: "Enter", code: "Enter" });
  await findByTestId("experience_card_export");
}

describe("ExperienceGalleryCard", () => {
  it("desktop: the trigger carries the more-actions label and touch-sized classes, menu closed", () => {
    const { getByTestId, queryByTestId } = renderCard();
    const menu = getByTestId("experience_card_menu");
    expect(menu.getAttribute("aria-label")).toBe("management_more_actions");
    expect(menu.className).toContain("max-md:h-9");
    expect(menu.className).toContain("max-md:w-9");
    // Closed: no dropdown items mounted; the card body is unchanged.
    expect(queryByTestId("experience_card_export")).toBeNull();
    expect(queryByTestId("experience_card_duplicate")).toBeNull();
    expect(queryByTestId("experience_card_delete")).toBeNull();
  });

  it("desktop: keyboard opens Export / Duplicate / Delete, delete in danger styling", async () => {
    const { findByTestId, getByTestId } = renderCard();
    await openDesktopMenu(findByTestId);
    expect(getByTestId("experience_card_export").textContent).toContain("experience_card_export");
    expect(getByTestId("experience_card_duplicate").textContent).toContain("duplicate");
    const del = getByTestId("experience_card_delete");
    expect(del.textContent).toContain("delete");
    expect(del.className).toContain("text-danger-text");
  });

  it("desktop: Export and Duplicate fire their callbacks", async () => {
    const { findByTestId, getByTestId, calls } = renderCard();
    await openDesktopMenu(findByTestId);
    fireEvent.click(getByTestId("experience_card_export"));
    expect(calls.exports).toBe(1);
    expect(calls.duplicates).toBe(0);
    await openDesktopMenu(findByTestId);
    fireEvent.click(getByTestId("experience_card_duplicate"));
    expect(calls.duplicates).toBe(1);
  });

  it("desktop: Delete targets the card script with no visual when nothing is bound", async () => {
    const { findByTestId, getByTestId, calls } = renderCard();
    await openDesktopMenu(findByTestId);
    fireEvent.click(getByTestId("experience_card_delete"));
    expect(calls.deletes).toEqual([{ scriptId: "srv_1", visualId: null }]);
  });

  it("desktop: Delete targets the first existing bound visual", async () => {
    const stale = makeVisual({ id: "vis_gone", name: "Gone Visual" });
    const live = makeVisual({ id: "vis_live", name: "Live Visual" });
    const { findByTestId, getByTestId, calls } = renderCard({
      bound: [stale, live],
      available: [live, makeVisual({ id: "vis_other", name: "Other" })],
    });
    await openDesktopMenu(findByTestId);
    fireEvent.click(getByTestId("experience_card_delete"));
    // The stale binding (missing from available) is skipped, like openScript.
    expect(calls.deletes).toEqual([{ scriptId: "srv_1", visualId: "vis_live" }]);
  });

  it("mobile: the trigger opens the ActionSheet titled with the mini-app name", () => {
    const { getByTestId, getAllByText, getByText } = renderCard({ isMobile: true });
    fireEvent.click(getByTestId("experience_card_menu"));
    // The name renders twice: once on the card, once as the sheet title.
    expect(getAllByText("Test Mini-App")).toHaveLength(2);
    getByText("experience_card_export");
    getByText("duplicate");
    const del = getByText("delete");
    expect((del.closest("button")?.getAttribute("class") ?? "")).toContain("text-danger-text");
  });

  it("mobile: sheet items fire the same callbacks, delete with the same target", () => {
    const live = makeVisual({ id: "vis_live", name: "Live Visual" });
    const { getByTestId, getByText, calls } = renderCard({
      isMobile: true,
      bound: [live],
      available: [live],
    });
    fireEvent.click(getByTestId("experience_card_menu"));
    fireEvent.click(getByText("experience_card_export"));
    expect(calls.exports).toBe(1);
    fireEvent.click(getByTestId("experience_card_menu"));
    fireEvent.click(getByText("duplicate"));
    expect(calls.duplicates).toBe(1);
    fireEvent.click(getByTestId("experience_card_menu"));
    fireEvent.click(getByText("delete"));
    expect(calls.deletes).toEqual([{ scriptId: "srv_1", visualId: "vis_live" }]);
  });

  it("a draft card has no menu and no footer", () => {
    const { queryByTestId, getByText, container } = renderCard({ isDraft: true });
    expect(queryByTestId("experience_card_menu")).toBeNull();
    // The card body still renders; the binding strip (footer-only) does not.
    getByText("Test Mini-App");
    expect(container.querySelector(".border-t.border-border")).toBeNull();
  });

  it("a published card footer grows to fill the card while a draft renders no footer", () => {
    const published = renderCard();
    const footer = published.container.querySelector(".border-t.border-border");
    expect(footer).not.toBeNull();
    // Token match (not substring): the pin survives class-name reordering.
    expect((footer?.getAttribute("class") ?? "").split(/\s+/)).toContain("flex-1");
    const draft = renderCard({ isDraft: true });
    expect(draft.container.querySelector('[data-testid="experience_card_menu"]')).toBeNull();
    expect(draft.container.querySelector(".border-t.border-border")).toBeNull();
  });

  it("firstExistingBoundVisual skips bound visuals missing from available", () => {
    const stale = makeVisual({ id: "vis_gone" });
    const live = makeVisual({ id: "vis_live" });
    expect(firstExistingBoundVisual([stale, live], [live])?.id).toBe("vis_live");
    expect(firstExistingBoundVisual([stale], [live])).toBeUndefined();
    expect(firstExistingBoundVisual([], [live])).toBeUndefined();
  });
});
