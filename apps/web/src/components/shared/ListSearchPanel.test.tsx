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
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, describe, it, expect } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

const { render, fireEvent, within } = await import("@testing-library/react");

installI18nContextSeam();

let ListSearchPanel: typeof import("./ListSearchPanel.js").ListSearchPanel;
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
  ({ ListSearchPanel } = await import("./ListSearchPanel.js"));
  ({ default: userEvent } = await import("@testing-library/user-event"));
});

function makeTags(n: number, prefix = "tag"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe("ListSearchPanel suggestions", () => {
  it("renders ALL available tags — no artificial cap", async () => {
		const view = render(
      <ListSearchPanel
        query=""
        onQueryChange={() => {}}
        selectedTags={[]}
        onSelectedTagsChange={() => {}}
        availableTags={makeTags(20)}
      />,
    );
		const panel = within(view.baseElement);
		await userEvent.setup().click(panel.getByPlaceholderText("search_tags_placeholder"));
		// 20 tags, none selected, empty query → all 20 must appear.
		const buttons = await panel.findAllByRole("button");
    expect(buttons).toHaveLength(20);
  });

  it("narrows the pool by substring as you type", async () => {
		const view = render(
      <ListSearchPanel
        query=""
        onQueryChange={() => {}}
        selectedTags={[]}
        onSelectedTagsChange={() => {}}
        availableTags={["apple", "apricot", "banana", "cherry"]}
      />,
    );
		const panel = within(view.baseElement);
		const input = panel.getByPlaceholderText("search_tags_placeholder");
		const user = userEvent.setup();
		await user.click(input);
		await user.type(input, "ap");
		const buttons = await panel.findAllByRole("button");
    expect(buttons).toHaveLength(2); // apple + apricot
  });

  it("renders a distinct secondary combobox with its own placeholder", () => {
		const view = render(
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
		const panel = within(view.baseElement);
		expect(panel.getByPlaceholderText("Primary")).toBeTruthy();
		expect(panel.getByPlaceholderText("Secondary")).toBeTruthy();
    // The sidebar default is not leaked when a custom placeholder is set.
		expect(panel.queryByPlaceholderText("search_tags_placeholder")).toBeNull();
  });

  it("scrolls the suggestion rows on the thin ScrollArea; the popup bounds, the lane scrolls", async () => {
    const view = render(
      <ListSearchPanel
        query=""
        onQueryChange={() => {}}
        selectedTags={[]}
        onSelectedTagsChange={() => {}}
        availableTags={makeTags(20)}
      />,
    );
    const panel = within(view.baseElement);
    await userEvent.setup().click(panel.getByPlaceholderText("search_tags_placeholder"));
    const buttons = await panel.findAllByRole("button");
    expect(buttons).toHaveLength(20);

    // CNR-8f: the rows scroll on the thin ScrollArea lane (3px rest / 5px
    // hover); the 180px cap rides the ScrollArea root, the py-1 row padding
    // rides the content element (padding scrolls with the rows), and the
    // Popover.Content keeps the popup bound with overflow-hidden instead of
    // its own native overflow-y-auto scroller.
    const root = buttons[0]!.closest('[data-scroll-area="thin"]') as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain("max-h-[180px]");
    const content = buttons[0]!.closest("[data-scroll-content]") as HTMLElement;
    expect(content.className).toContain("py-1");
    const popover = buttons[0]!.closest("div.glass-blur") as HTMLElement;
    expect(popover.className).toContain("max-h-[180px]");
    expect(popover.className).toContain("overflow-hidden");
    expect(popover.className).not.toContain("overflow-y-auto");
  });
});
