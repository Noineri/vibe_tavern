import { beforeAll, describe, expect, it } from "bun:test";
import {
  LOREBOOK_REVIEW_SETTING_FIELDS,
  LORE_ENTRY_REVIEW_SETTING_FIELDS,
  type CoauthorLoreBundle,
  type LoreEntryReviewSettingField,
  type LorebookReviewSettingField,
} from "@vibe-tavern/api-contracts";
import { normalizeTrackerTemplate } from "@vibe-tavern/domain";
import type { CoauthorTrackerTemplateReviewLabels } from "./CoauthorTrackerTemplateReview.js";
import type { CoauthorLoreReviewLabels } from "./CoauthorLoreReview.js";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let buildLineDiff: typeof import("../shared/TextDiffPreview.js").buildLineDiff;
let groupHunks: typeof import("../../lib/coauthor-hunk-merge.js").groupHunks;
let CoauthorReviewingOverlay: typeof import("./CoauthorReviewingOverlay.js").CoauthorReviewingOverlay;

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ buildLineDiff } = await import("../shared/TextDiffPreview.js"));
  ({ groupHunks } = await import("../../lib/coauthor-hunk-merge.js"));
  ({ CoauthorReviewingOverlay } = await import("./CoauthorReviewingOverlay.js"));
});

function labelMap<T extends string>(keys: readonly T[]): Record<T, string> {
  const map: Partial<Record<T, string>> = {};
  for (const key of keys) map[key] = key;
  return map as Record<T, string>;
}

const labels = {
  title: "Proposed changes",
  tooLarge: "Too large to diff",
  noChanges: "No changes",
  apply: "Apply",
  reject: "Reject",
  applying: "Applying…",
  selectAll: "All",
  selectNone: "None",
  applyingCount: "Applying {selected} of {total}",
  hunkN: "Hunk {n}",
  skipped: "Skipped",
};

const trackerTemplateLabels: CoauthorTrackerTemplateReviewLabels = {
  title: "Tracker template",
  defaults: "Differences from default settings",
  current: "Current",
  noCurrent: "No template",
  scene: (count) => `Scene — ${count} fields`,
  objectives: (mode, count) => `Objectives — ${mode}, ${count}`,
  settings: {
    autoMode: "Auto mode", contextWindow: "Context window", continuityLastN: "Scene continuity",
    injectionDepth: "Injection depth", injectLastN: "Scene memory", promptFormat: "Prompt format",
    generatePrompt: "Generation prompt", injectPrompt: "Injection prompt", rulesPrompt: "Scene rules",
  },
  types: { string: "string", number: "number", boolean: "boolean", object: "object", array: "list" },
  enabled: "Enabled",
  disabled: "Disabled",
};

const loreLabels: CoauthorLoreReviewLabels = {
  title: "Lore",
  lorebook: "Lorebook",
  keys: "Keys",
  secondaryKeys: "Secondary",
  constant: "Constant",
  editing: "Editing",
  existingLorebook: "Existing lorebook",
  entriesOne: "entry",
  entriesFew: "entries",
  entriesMany: "entries",
  scopeEntity: "Character",
  scopeGlobal: "Global",
  scopeChat: "Chat",
  noContent: "No content",
  valueOn: "On",
  valueOff: "Off",
  valueInherit: "Inherit",
  lorebookSettingLabels: labelMap<LorebookReviewSettingField>(LOREBOOK_REVIEW_SETTING_FIELDS),
  entrySettingLabels: labelMap<LoreEntryReviewSettingField>(LORE_ENTRY_REVIEW_SETTING_FIELDS),
};

function translate(key: string): string {
  return key;
}

function trackerTemplate() {
  const template = normalizeTrackerTemplate({
    version: 1,
    scene: { enabled: true, config: { schema: { location: { $type: "string" } } } },
  });
  if (!template) throw new Error("Expected fixture tracker template to normalize");
  return template;
}

function loreBundle(): CoauthorLoreBundle {
  return {
    lorebooks: [{ id: "lb1", name: "World Lore", description: "", scopeType: "global", enabled: true }],
    entries: [{
      id: "e1", lorebookId: "lb1", title: "Eldoria", content: "An old forest.",
      keys: ["forest"], secondaryKeys: [], constant: false, position: "before_char", depth: 4, enabled: true,
    }],
  };
}

function baseProps() {
  return {
    summary: "Review summary",
    t: translate,
    hunks: [] as ReturnType<typeof groupHunks>,
    selectedHunkIds: new Set<number>(),
    onToggleHunk: () => {},
    onSelectAll: () => {},
    onSelectNone: () => {},
    applying: false,
    onApply: () => {},
    onReject: () => {},
    currentTrackerTemplate: null,
    trackerTemplateSelected: true,
    onToggleTrackerTemplate: () => {},
    selectedLorebookIds: new Set<string>(["lb1"]),
    selectedEntryIds: new Set<string>(["e1"]),
    onToggleLorebook: () => {},
    onToggleEntry: () => {},
    trackerTemplateLabels,
    loreLabels,
    labels,
  };
}

/** Root child order: every named section must precede the pinned footer. */
function expectFooterLast(root: HTMLElement, sections: HTMLElement[], footer: HTMLElement): void {
  const order = Array.from(root.children);
  for (const section of sections) {
    expect(order.indexOf(section)).toBeGreaterThanOrEqual(0);
    expect(section.contains(footer)).toBe(false);
    expect(footer.contains(section)).toBe(false);
    expect(order.indexOf(section)).toBeLessThan(order.indexOf(footer));
  }
}

describe("CoauthorReviewingOverlay — tracker section scroll (owner follow-up 2026-10-24)", () => {
  it("tracker-only: the section is a bounded scroll container and the footer stays outside it", () => {
    const { container, getByTestId, getByText } = render(
      <CoauthorReviewingOverlay
        {...baseProps()}
        diff={null}
        hunks={[]}
        trackerTemplate={trackerTemplate()}
        trackerTemplateSummary="Drafted trackers."
        loreBundle={undefined}
      />,
    );
    // The review card itself is unchanged — its content still renders.
    expect(getByText("Tracker template")).toBeTruthy();
    expect(getByText("Drafted trackers.")).toBeTruthy();

    const section = getByTestId("coauthor-tracker-section");
    // Bounded: participates in the column's flex distribution and can shrink
    // under long content (jsdom has no layout — pin the structure, not pixels).
    expect(section.className).toContain("min-h-0");
    expect(section.className).toContain("flex-1");
    // Scrolls internally: the inner scroller owns the overflow.
    const scroller = section.firstElementChild as HTMLElement;
    expect(scroller.className).toContain("min-h-0");
    expect(scroller.className).toContain("flex-1");
    expect(scroller.className).toContain("overflow-y-auto");

    const footer = getByTestId("coauthor-review-footer");
    expect(footer.className).toContain("shrink-0");
    expect(getByText("Apply")).toBeTruthy();
    expect(getByText("Reject")).toBeTruthy();
    expectFooterLast(container.firstElementChild as HTMLElement, [section], footer);
  });

  it("mixed tracker + diff with hunks: both sections share the column and scroll on their own", () => {
    const diff = buildLineDiff("line one\nline two\n", "line one\nline TWO\n");
    const hunks = groupHunks(diff);
    expect(hunks.length).toBeGreaterThan(0);
    const { container, getByTestId } = render(
      <CoauthorReviewingOverlay
        {...baseProps()}
        diff={diff}
        hunks={hunks}
        selectedHunkIds={new Set(hunks.map((hunk) => hunk.id))}
        trackerTemplate={trackerTemplate()}
        trackerTemplateSummary="Drafted trackers."
        loreBundle={undefined}
      />,
    );

    const diffSection = getByTestId("coauthor-diff-section");
    expect(diffSection.className).toContain("min-h-0");
    expect(diffSection.className).toContain("flex-1");
    // The diff scrolls inside its own pre block (HunkSelectionDiff internals).
    const pre = diffSection.querySelector("pre") as HTMLElement | null;
    expect(pre).toBeTruthy();
    expect(pre?.className ?? "").toContain("overflow-y-auto");

    const trackerSection = getByTestId("coauthor-tracker-section");
    expect(trackerSection.className).toContain("min-h-0");
    expect(trackerSection.className).toContain("flex-1");
    expect((trackerSection.firstElementChild as HTMLElement).className).toContain("overflow-y-auto");

    const footer = getByTestId("coauthor-review-footer");
    expectFooterLast(container.firstElementChild as HTMLElement, [diffSection, trackerSection], footer);
  });

  it("mixed tracker + lore: both sections share the column, footer outside both", () => {
    const { container, getByTestId, getByText } = render(
      <CoauthorReviewingOverlay
        {...baseProps()}
        diff={null}
        hunks={[]}
        trackerTemplate={trackerTemplate()}
        trackerTemplateSummary="Drafted trackers."
        loreBundle={loreBundle()}
      />,
    );
    expect(getByText("Eldoria")).toBeTruthy();

    const trackerSection = getByTestId("coauthor-tracker-section");
    expect(trackerSection.className).toContain("min-h-0");
    expect(trackerSection.className).toContain("flex-1");

    const loreSection = getByTestId("coauthor-lore-section");
    expect(loreSection.className).toContain("min-h-0");
    expect(loreSection.className).toContain("flex-1");

    const footer = getByTestId("coauthor-review-footer");
    expectFooterLast(container.firstElementChild as HTMLElement, [trackerSection, loreSection], footer);
  });

  it("empty diff keeps the shrink-0 rule so it never steals the column from the tracker", () => {
    const diff = buildLineDiff("same\n", "same\n");
    const hunks = groupHunks(diff);
    expect(hunks.length).toBe(0);
    const { getByTestId, getByText } = render(
      <CoauthorReviewingOverlay
        {...baseProps()}
        diff={diff}
        hunks={hunks}
        trackerTemplate={trackerTemplate()}
        trackerTemplateSummary="Drafted trackers."
        loreBundle={undefined}
      />,
    );
    // The one-line "no changes" message takes natural height only.
    expect(getByText("No changes")).toBeTruthy();
    const diffSection = getByTestId("coauthor-diff-section");
    expect(diffSection.className).toContain("shrink-0");
    expect(diffSection.className).not.toContain("flex-1");

    const trackerSection = getByTestId("coauthor-tracker-section");
    expect(trackerSection.className).toContain("flex-1");
  });
});
