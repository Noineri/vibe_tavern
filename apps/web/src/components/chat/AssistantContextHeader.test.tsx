import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { render, fireEvent } from "@testing-library/react";
import {
  AssistantContextHeader,
  type AssistantContextHeaderProps,
} from "./AssistantContextHeader.js";
import {
  registerMessageSlot,
  type MessageSlotDescriptor,
  type MessageSlotContext,
} from "../../lib/message-slot-registry.js";
import type { MessageShellAuthorInfo } from "./MessageShell.js";
import {
  useHeaderZoneExpansionStore,
  useHeaderZoneOpen,
} from "../../stores/header-zone-expansion.js";

/**
 * AssistantContextHeader — adaptive-layout + fallback + isolation tests.
 *
 * The Objective/Scene zones are supplied by INSIGHTS_PLAN (not landed). These
 * tests exercise the HOST with a mock `assistant_header_zone` descriptor so the
 * adaptive mechanism (resolve → layout by count + anyExpanded → avatar grow +
 * separators → render-isolation) is proven independently of the real content.
 * The 0-zone fallback (the only path active in prod until INS-6 lands) is
 * asserted to render identity-only.
 */

// ────────────────────────────────────────────────────────────────────────────
// Mock Objective zone — mirrors the contract INS-6 will implement: registers
// at `assistant_header_zone`, toggles `objectiveOpen` in the expansion store,
// and shows a collapsed summary vs expanded content.
// ────────────────────────────────────────────────────────────────────────────

function MockObjectiveContent({ messageId }: { messageId: string }) {
  const open = useHeaderZoneOpen(messageId, "objectiveOpen");
  const toggle = useHeaderZoneExpansionStore((s) => s.toggle);
  return (
    <div data-testid="obj-zone">
      <button data-testid="obj-toggle" onClick={() => toggle(messageId, "objectiveOpen")}>
        {open ? "collapse" : "expand"}
      </button>
      {open ? (
        <div data-testid="obj-expanded">expanded route content</div>
      ) : (
        <div data-testid="obj-collapsed">● active task</div>
      )}
    </div>
  );
}

const MOCK_OBJECTIVE_DESCRIPTOR: MessageSlotDescriptor = {
  id: "test-objective",
  slot: "assistant_header_zone",
  roles: ["assistant"],
  order: 1,
  render: (ctx: MessageSlotContext) => <MockObjectiveContent messageId={ctx.messageId} />,
};

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function makeAuthor(name = "Aria", avatarSrc: string | null = "/a.png"): MessageShellAuthorInfo {
  return { name, avatarAssetId: null, avatarCropJson: null, avatarSrc, avatarNode: undefined };
}

function makeSlotCtx(messageId = "m1"): MessageSlotContext {
  return {
    chatId: "chat-1",
    messageId,
    messageRole: "assistant",
    variantIndex: 0,
    isStreaming: false,
    extras: {},
  };
}

function makeProps(overrides: Partial<AssistantContextHeaderProps> = {}): AssistantContextHeaderProps {
  return {
    author: makeAuthor(),
    slotCtx: makeSlotCtx(),
    isMobile: false,
    isEditing: false,
    isGenerating: false,
    onToggleMobileMenu: () => {},
    ...overrides,
  };
}

/** Find the persistent avatar element (its className always carries `font-body`). */
function avatarEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[class*="font-body"]');
  if (!el) throw new Error("avatar element not found");
  return el as HTMLElement;
}

let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  useHeaderZoneExpansionStore.setState({ open: {} });
});

afterEach(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("AssistantContextHeader — 0-zone fallback (identity-only)", () => {
  test("renders avatar + name and NO zone DOM / separators (visually identical to today)", () => {
    const { container } = render(<AssistantContextHeader {...makeProps()} />);

    // Avatar present, compact size.
    const avatar = avatarEl(container);
    expect(avatar.className).toContain("h-11");
    expect(avatar.className).toContain("rounded-full");

    // Name present.
    expect(container.textContent).toContain("Aria");

    // No zone content, no separators.
    expect(container.querySelector('[data-testid="obj-zone"]')).toBeNull();
    expect(container.querySelector('[class*="bg-border"]')).toBeNull();
  });

  test("avatar-less (initials) character: compact initials, no portrait growth path triggered", () => {
    const { container } = render(<AssistantContextHeader {...makeProps({ author: makeAuthor("Aria", null) })} />);
    const avatar = avatarEl(container);
    expect(avatar.className).toContain("h-11");
    expect(avatar.textContent).toContain("A"); // initials fallback
  });
});

describe("AssistantContextHeader — ≥1 zone adaptive (mock objective zone)", () => {
  test("collapsed: zone summary + a separator render; avatar stays compact", () => {
    unsubscribe = registerMessageSlot(MOCK_OBJECTIVE_DESCRIPTOR);
    const { container } = render(<AssistantContextHeader {...makeProps()} />);

    // Zone collapsed summary present.
    expect(container.querySelector('[data-testid="obj-collapsed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="obj-expanded"]')).toBeNull();

    // Separator present (ZoneDivider).
    expect(container.querySelector('[class*="bg-border"]')).not.toBeNull();

    // Avatar still compact.
    expect(avatarEl(container).className).toContain("h-11");
  });

  test("expand → avatar grows to portrait + expanded zone content appears", () => {
    unsubscribe = registerMessageSlot(MOCK_OBJECTIVE_DESCRIPTOR);
    const { container } = render(<AssistantContextHeader {...makeProps()} />);
    const avatar = avatarEl(container);

    // Start compact.
    expect(avatar.className).toContain("h-11");
    expect(avatar.className).not.toContain("h-28");

    // Expand the zone.
    fireEvent.click(container.querySelector('[data-testid="obj-toggle"]')!);

    // Avatar transitioned to portrait.
    expect(avatar.className).toContain("h-28");
    expect(avatar.className).toContain("rounded-2xl");
    expect(avatar.className).not.toContain("rounded-full");

    // Expanded content now visible; collapsed summary gone.
    expect(container.querySelector('[data-testid="obj-expanded"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="obj-collapsed"]')).toBeNull();
  });

  test("collapse → avatar shrinks back to compact", () => {
    unsubscribe = registerMessageSlot(MOCK_OBJECTIVE_DESCRIPTOR);
    const { container } = render(<AssistantContextHeader {...makeProps()} />);
    const avatar = avatarEl(container);
    const toggle = container.querySelector('[data-testid="obj-toggle"]')!;

    fireEvent.click(toggle); // expand
    expect(avatar.className).toContain("h-28");

    fireEvent.click(toggle); // collapse
    expect(avatar.className).toContain("h-11");
    expect(avatar.className).toContain("rounded-full");
  });

  test("avatar-less character: expanding a zone does NOT grow the avatar (no empty portrait column)", () => {
    unsubscribe = registerMessageSlot(MOCK_OBJECTIVE_DESCRIPTOR);
    const { container } = render(<AssistantContextHeader {...makeProps({ author: makeAuthor("Aria", null) })} />);
    const avatar = avatarEl(container);

    fireEvent.click(container.querySelector('[data-testid="obj-toggle"]')!);

    // Expanded content shows, but avatar stayed compact (initials).
    expect(container.querySelector('[data-testid="obj-expanded"]')).not.toBeNull();
    expect(avatar.className).toContain("h-11");
    expect(avatar.className).not.toContain("h-28");
  });

  test("mobile: zones stack vertically (horizontal divider), avatar never grows", () => {
    unsubscribe = registerMessageSlot(MOCK_OBJECTIVE_DESCRIPTOR);
    const { container } = render(<AssistantContextHeader {...makeProps({ isMobile: true })} />);
    const avatar = avatarEl(container);

    // Mobile divider is horizontal (h-px), not vertical (w-px).
    const divider = container.querySelector('[class*="bg-border"]')!;
    expect(divider.className).toContain("h-px");
    expect(divider.className).not.toContain("w-px");

    // Expand → avatar stays compact on mobile.
    fireEvent.click(container.querySelector('[data-testid="obj-toggle"]')!);
    expect(avatar.className).toContain("h-11");
    expect(avatar.className).not.toContain("h-28");
  });
});

describe("AssistantContextHeader — render-isolation", () => {
  test("toggling m2's zone does NOT re-render m1's header", () => {
    unsubscribe = registerMessageSlot(MOCK_OBJECTIVE_DESCRIPTOR);

    let m1Commits = 0;
    const onRender: ProfilerOnRenderCallback = () => { m1Commits++; };

    const { container } = render(
      <>
        <Profiler id="m1" onRender={onRender}>
          <AssistantContextHeader {...makeProps({ slotCtx: makeSlotCtx("m1") })} />
        </Profiler>
        <AssistantContextHeader {...makeProps({ slotCtx: makeSlotCtx("m2") })} />
      </>,
    );

    // Two toggle buttons in document order: m1's, then m2's.
    const toggles = container.querySelectorAll('[data-testid="obj-toggle"]');
    expect(toggles.length).toBe(2);

    // Reset after mount; m1 has committed once (mount).
    expect(m1Commits).toBe(1);
    m1Commits = 0;

    // Toggle m2's zone — m1 must not re-render.
    fireEvent.click(toggles[1]!);
    expect(m1Commits).toBe(0);

    // POSITIVE CONTROL: toggle m1's own zone — m1 re-renders (avatar grows).
    fireEvent.click(toggles[0]!);
    expect(m1Commits).toBeGreaterThan(0);
  });
});
