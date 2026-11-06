import { describe, expect, it } from "bun:test";
import { PROVIDER_QUOTA_KIND, PROVIDER_QUOTA_WINDOW_KIND, type ProviderQuotaSnapshot } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();
installI18nContextSeam({ custom: { t: (key) => key, tDynamic: () => "Localized session" } });

const { render, fireEvent } = await import("@testing-library/react");
const { TooltipProvider } = await import("./Tooltip.js");
const { QuotaSummaryRows } = await import("./QuotaSummaryRows.js");

const rawLabel = "A provider supplied quota window label that differs from its localized display";
const snapshot: ProviderQuotaSnapshot = {
  kind: PROVIDER_QUOTA_KIND.windowed,
  providerProfileId: "provider-1",
  capabilityId: "zai",
  capabilityVersion: 1,
  observedAt: "2026-08-08T12:00:00.000Z",
  windows: [{ kind: PROVIDER_QUOTA_WINDOW_KIND.session, label: rawLabel, usedPercent: 25, resetsAt: null }],
  balances: [],
};

describe("QuotaSummaryRows", () => {
  it("only shows the raw window label as a tooltip when its localized display is clipped", async () => {
    const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    let clipped = false;
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => clipped ? 300 : 100 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
    try {
      const ui = <TooltipProvider delayDuration={0}><div style={{ width: 100 }}><QuotaSummaryRows snapshot={snapshot} lastError={null} now={0} /></div></TooltipProvider>;
      const first = render(ui);
      const visible = first.getByText("Localized session");
      expect(visible.tagName).toBe("SPAN");
      expect(visible.className).toBe("truncate min-w-0 text-t2");
      fireEvent.pointerMove(visible, { pointerType: "mouse" });
      expect(first.queryByRole("tooltip")).toBeNull();
      first.unmount();

      clipped = true;
      const second = render(ui);
      const measured = second.getByText("Localized session");
      expect(measured.className).toBe("truncate min-w-0 text-t2");
      fireEvent.pointerMove(measured, { pointerType: "mouse" });
      expect((await second.findByRole("tooltip")).textContent).toBe(rawLabel);
      second.unmount();
    } finally {
      if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });
});
