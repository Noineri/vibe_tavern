/**
 * ListSearchPanel — suggestion-pool regression coverage.
 *
 * Pins that the tag combobox shows EVERY available tag (minus selected), not a
 * hard-capped slice. A previous revision had `MAX_SUGGESTIONS = 12` which
 * silently hid tags/keys beyond the 12th — harmful for both the lorebook
 * activation-key filter and the sidebar character-tag filter, where the pool
 * routinely exceeds 12. The scrollable Popover.Content (max-h-[180px]
 * overflow-y-auto) bounds the height; a slice was pure harm.
 *
 * Runner: vitest. DOM via happy-dom.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { ListSearchPanel } from "./ListSearchPanel.js";

vi.mock("../../i18n/context.js", () => ({
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

function makeTags(n: number, prefix = "tag"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe("ListSearchPanel suggestions", () => {
  it("renders ALL available tags — no artificial cap", async () => {
    render(
      <ListSearchPanel
        query=""
        onQueryChange={() => {}}
        selectedTags={[]}
        onSelectedTagsChange={() => {}}
        availableTags={makeTags(20)}
      />,
    );
    fireEvent.focus(screen.getByPlaceholderText("search_tags_placeholder"));
    // 20 tags, none selected, empty query → all 20 must appear.
    const buttons = await screen.findAllByRole("button");
    expect(buttons).toHaveLength(20);
  });

  it("narrows the pool by substring as you type", async () => {
    render(
      <ListSearchPanel
        query=""
        onQueryChange={() => {}}
        selectedTags={[]}
        onSelectedTagsChange={() => {}}
        availableTags={["apple", "apricot", "banana", "cherry"]}
      />,
    );
    const input = screen.getByPlaceholderText("search_tags_placeholder");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ap" } });
    const buttons = await screen.findAllByRole("button");
    expect(buttons).toHaveLength(2); // apple + apricot
  });

  it("renders a distinct secondary combobox with its own placeholder", () => {
    render(
      <ListSearchPanel
        query=""
        onQueryChange={() => {}}
        selectedTags={[]}
        onSelectedTagsChange={() => {}}
        availableTags={["a"]}
        tagInputPlaceholder="Primary"
        secondarySelectedTags={[]}
        onSecondarySelectedTagsChange={() => {}}
        secondaryAvailableTags={["b"]}
        secondaryTagInputPlaceholder="Secondary"
      />,
    );
    // Both comboxes render with their own (custom) placeholders → the caller
    // can relabel "tags" to "keys" and run a second, independent pool.
    expect(screen.getByPlaceholderText("Primary")).toBeTruthy();
    expect(screen.getByPlaceholderText("Secondary")).toBeTruthy();
    // The sidebar default is not leaked when a custom placeholder is set.
    expect(screen.queryByPlaceholderText("search_tags_placeholder")).toBeNull();
  });
});
