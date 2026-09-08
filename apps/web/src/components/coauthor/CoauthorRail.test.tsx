/**
 * CoauthorRail — provider entry routing (E3, MOBILE_DEFECTS_ROUND_2).
 *
 * The co-author surface has its OWN provider modal (CoauthorProviderModal —
 * tool-filtered model list, co-author binding, mobile MasterDetail shell).
 * The rail's plug button used to open the shared RP ProviderModal instead,
 * so "provider settings" inside a co-author chat showed the RP chat's
 * provider — the reported defect. Pins BOTH rail surfaces (collapsed strip
 * Ico + expanded drawer NavRow): the plug must raise the co-author modal
 * flag and must NOT raise the RP one.
 *
 * Stores render with real defaults (empty bootstrap → empty lists, no
 * network); useT and CustomTooltip are mocked at their module boundary with
 * the `...real` spread (keys verbatim so title/label queries work; the
 * Radix tooltip needs a provider the isolated render lacks).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();
const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");

const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// Radix Tooltip (ListSortToggle and friends inside the drawer) needs a
// TooltipProvider ancestor the isolated render lacks — passthrough stub,
// same pattern as CoauthorTopBar.test.tsx.
const realTooltip = await import("../shared/Tooltip.js");
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const { CoauthorRail } = await import("./CoauthorRail.js");
const { useModalStore, useNavigationStore } = await import("../../stores/index.js");

const resetModals = () =>
  useModalStore.setState({ isCoauthorProviderModalOpen: false, isProviderModalOpen: false, isCoauthorModuleModalOpen: false, isCoauthorSkillModalOpen: false });

describe("CoauthorRail — plug routes to the co-author provider modal (E3)", () => {
  beforeEach(resetModals);

  it("collapsed strip: Ico plug opens the co-author modal, not the RP one", () => {
    const { getByTitle } = render(createElement(CoauthorRail));
    fireEvent.click(getByTitle("provider_settings_tooltip"));
    expect(useModalStore.getState().isCoauthorProviderModalOpen).toBe(true);
    expect(useModalStore.getState().isProviderModalOpen).toBe(false);
  });

  it("expanded drawer: NavRow plug opens the co-author modal, not the RP one", async () => {
    const { findByText } = render(createElement(CoauthorRail));
    // Open the drawer the way TopBar's hamburger does — bump the nav store's
    // force-open counter; the rail's effect sets `expanded` for us. Flush via
    // act so the effect + Base UI portal mount before we query.
    act(() => {
      useNavigationStore.setState({ railForceOpen: (useNavigationStore.getState().railForceOpen ?? 0) + 1 });
    });
    // The drawer popup renders the NavRow cluster (portalled); the NavRow's
    // label is a text node (the collapsed-strip Ico carries a title ATTRIBUTE,
    // so a text query is unambiguous for the drawer row).
    const label = await findByText("provider_settings_tooltip");
    const row = label.closest("div.cursor-pointer") as HTMLElement | null;
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(useModalStore.getState().isCoauthorProviderModalOpen).toBe(true);
    expect(useModalStore.getState().isProviderModalOpen).toBe(false);
  });
});
