import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ExperienceMessageReport } from "@vibe-tavern/domain";
import type { MessageMetaContext } from "../../../lib/message-meta-registry.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv({ failOnNetwork: true });
installI18nContextSeam({ interpolateKeys: ["experience_report_event_count", "experience_report_recent_events"] });
const { render: rtlRender, fireEvent, act } = await import("@testing-library/react");
const { ExperienceReportChip, ExperienceReportDetail, experienceReportMetaDescriptor } = await import("./experience-report.js");

const { TooltipProvider } = await import("../../shared/Tooltip.js");
function render(node: React.ReactNode) {
  return rtlRender(node, { wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider> });
}

const originalWidth = window.innerWidth;
beforeEach(() => { window.innerWidth = 1200; });
afterAll(() => { window.innerWidth = originalWidth; });

function report(over: Partial<ExperienceMessageReport> = {}): ExperienceMessageReport {
  return { title: "Cards", eventCount: 3, participants: [{ id: "p1", label: "Player" }], events: [
    { type: "move", participantId: "p1", detail: "played a red six" },
    { type: "old", detail: { n: 2 } }, { type: "end", detail: "The match ended." },
  ], ...over };
}

function context(reports?: ExperienceMessageReport[]): MessageMetaContext {
  return { chatId: "chat", messageId: "msg", messageRole: "user", variant: null, variantIndex: 0,
    isStreaming: false, isCoauthorTurn: false, presetName: null, tokenCount: 2,
    createdAt: "2026-10-27T12:00:00Z", diceRolls: [], experienceReports: reports };
}

describe("experience report message chip (ERX-8)", () => {
  it("is user-only, absent without reports, and preserves message ownership", () => {
    expect(experienceReportMetaDescriptor.roles).toEqual(["user"]);
    // Visibility depends only on this optional message field, not live session/config state.
    const visible = experienceReportMetaDescriptor.visible;
    if (!visible) throw new Error("expected a visibility gate");
    expect(visible(context([]))).toBe(false);
    expect(visible(context())).toBe(false);
    expect(visible(context([report()]))).toBe(true);
    const view = render(<><ExperienceReportChip report={report()} /><ExperienceReportChip report={report({ title: "Chess" })} /></>);
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(2);
    expect(view.queryByTestId("experience-report-chip-detail")).toBeNull();
  });

  it("shows title and total count, opens the real desktop popover with shared-renderer lines", async () => {
    const view = render(<ExperienceReportChip report={report()} />);
    const trigger = view.getByTestId("experience-report-chip");
    expect(trigger.textContent).toContain("Cards");
    expect(trigger.textContent).toContain("3 events");
    await act(async () => { fireEvent.click(trigger); });
    const detail = view.getByTestId("experience-report-chip-detail");
    expect(detail.closest('[data-radix-popper-content-wrapper]')).not.toBeNull();
    expect(detail.textContent).toContain("Player: played a red six");
    expect(detail.textContent).toContain('old: {"n":2}');
    expect(detail.textContent).toContain("The match ended.");
    expect(detail.textContent).not.toContain("revision");
  });

  it("opens the real mobile BottomSheet, not a desktop popover", async () => {
    window.innerWidth = 375;
    const view = render(<ExperienceReportChip report={report()} />);
    await act(async () => { fireEvent.click(view.getByTestId("experience-report-chip")); });
    const detail = view.getByTestId("experience-report-chip-detail");
    expect(detail.closest(".bs-popup")).not.toBeNull();
    expect(detail.closest('[data-radix-popper-content-wrapper]')).toBeNull();
    expect(detail.textContent).toContain("Player: played a red six");
  });

  it("keeps legacy actor fallback and signals bounded history without truncating the title in detail", () => {
    const title = "A very long captured app title ".repeat(8);
    const view = render(<ExperienceReportDetail report={report({ title, participants: undefined, eventCount: 105 })} />);
    expect(view.getByRole("heading").textContent).toBe(title);
    expect(view.container.textContent).toContain("p1: played a red six");
    expect(view.container.textContent).toContain("Showing the last 3 of 105 events.");
    expect(view.container.textContent).toContain('old: {"n":2}');
  });

  it("rides the shared thin scroll lane with the 70vh cap on the root (CNR-8p)", () => {
    const view = render(<ExperienceReportDetail report={report()} />);
    const lane = view.container.querySelector('[data-scroll-area="thin"]');
    expect(lane).toBeTruthy();
    expect((lane as HTMLElement).classList.contains("max-h-[70vh]")).toBe(true);
    // The frozen lines ride inside the lane's viewport; this one body serves
    // the desktop popover and the mobile sheet alike (the lane chrome hides
    // on phones per the CNR-7g policy; native scrolling continues).
    expect(lane!.querySelector("[data-scroll-viewport]")?.textContent).toContain("The match ended.");
  });
});

it("exposes clipped full text in the button through a measured themed hint", async () => {
  const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
  try {
    const title = "A long report title";
    const view = render(<ExperienceReportChip report={report({ title })} />);
    const text = view.getByText(title);
    expect(text.tagName).toBe("SPAN");
    expect(text.className).toBe("truncate min-w-0 max-w-[12rem]");
    fireEvent.pointerMove(text, { pointerType: "mouse" });
    expect((await view.findByRole("tooltip")).textContent).toBe(title);
    view.unmount();
  } finally {
    if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
});
