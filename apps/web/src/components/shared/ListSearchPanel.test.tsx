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
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { render, fireEvent, within } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

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
});
