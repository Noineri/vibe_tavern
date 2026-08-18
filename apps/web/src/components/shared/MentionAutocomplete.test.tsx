import { beforeAll, describe, it, expect, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// Mock react-i18next (safe pattern: capture the real module first, spread it,
// override only useTranslation — mock.module is process-global under bun:test).
const realReactI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
  ...realReactI18next,
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "copilot_mention_no_matches") return `no matches for ${options?.query}`;
      if (key === "copilot_mention_empty") return "nothing to mention";
      if (key === "copilot_mention_picker_label") return "Mention picker";
      if (key === "copilot_mention_type_character") return "Character";
      if (key === "copilot_mention_type_persona") return "Persona";
      if (key === "copilot_mention_type_lorebook") return "Lorebook";
      if (key === "copilot_mention_type_script") return "Script";
      if (key === "copilot_mention_type_skill") return "Skill";
      return key;
    },
  }),
}));

let MentionAutocomplete: typeof import("./MentionAutocomplete.js").MentionAutocomplete;
beforeAll(async () => {
  ({ MentionAutocomplete } = await import("./MentionAutocomplete.js"));
});

const ITEMS = [
  { targetType: "character", id: "char_1", label: "Alice", hint: "wanderer" },
  { targetType: "skill", id: "my-skill", label: "My Skill" },
  { targetType: "unknown-kind", id: "x", label: "Fallback Row" },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof MentionAutocomplete>> = {}) {
  const onSelect = mock(() => {});
  const onHover = mock(() => {});
  const utils = render(
    <MentionAutocomplete
      items={ITEMS}
      activeIndex={0}
      onSelect={onSelect}
      onHover={onHover}
      anchorEl={document.body}
      query=""
      {...overrides}
    />,
  );
  return { ...utils, onSelect, onHover };
}

function options(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('[role="option"]'));
}

describe("MentionAutocomplete (CX-5)", () => {
  it("renders rows with label, optional hint, and the localized type chip", () => {
    renderPicker();
    const opts = options();
    expect(opts).toHaveLength(3);
    expect(opts[0].textContent).toContain("Alice");
    expect(opts[0].textContent).toContain("wanderer"); // hint line
    expect(opts[0].textContent).toContain("Character"); // localized chip
    expect(opts[1].textContent).toContain("My Skill");
    expect(opts[1].textContent).toContain("Skill");
    // Unknown target kind falls back to the raw string instead of an i18n key.
    expect(opts[2].textContent).toContain("unknown-kind");
  });

  it("marks the active row and only it (aria + data-active)", () => {
    renderPicker({ activeIndex: 1 });
    const opts = options();
    expect(opts[0].getAttribute("aria-selected")).toBe("false");
    expect(opts[1].getAttribute("aria-selected")).toBe("true");
    expect(opts[1].hasAttribute("data-active")).toBe(true);
    expect(opts[0].hasAttribute("data-active")).toBe(false);
  });

  it("click fires onSelect with the FULL item (targetType+id for the pin)", () => {
    const { onSelect } = renderPicker();
    fireEvent.click(options()[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("hover fires onHover with the index", () => {
    const { onHover } = renderPicker();
    fireEvent.mouseEnter(options()[2]);
    expect(onHover).toHaveBeenCalledWith(2);
  });

  it("renders the query-aware empty state when the filtered list is empty", () => {
    const { getByText } = renderPicker({ items: [], query: "zzz" });
    expect(getByText("no matches for zzz")).toBeTruthy();
  });

  it("renders the catalog-empty state (no query) when nothing exists to mention", () => {
    const { getByText } = renderPicker({ items: [], query: "" });
    expect(getByText("nothing to mention")).toBeTruthy();
  });

  it("exposes a labeled listbox and never steals focus on mousedown", () => {
    const { container } = renderPicker();
    const listbox = container.ownerDocument.body.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Mention picker");
    // mousedown inside the popup is suppressed so the anchor keeps DOM focus.
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    listbox!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
