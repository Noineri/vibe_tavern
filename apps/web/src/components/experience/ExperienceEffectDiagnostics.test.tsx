/**
 * ExperienceEffectDiagnostics — lobby effect diagnostics + retry (pending
 * queue position 1 of EXPERIENCE_ENGINE_LOBBY_REPORT), pure-component tests.
 *
 * Boundary under test: the REAL ExperienceEffectDiagnostics (no store, no API)
 * with typed server-shaped effect rows → DOM observations + onRetry call
 * assertions. This test pins the trusted-chrome contract at the component
 * boundary:
 *   - ONLY failed/cancelled/unknown rows render (pending/running/succeeded
 *     are the header badge's business — never this block);
 *   - each row shows the localized status label + the row's error text and a
 *     retry button addressed to that exact effect id;
 *   - no retryable rows → renders nothing at all;
 *   - no onRetry call without a user click; duplicate-click suppression while
 *     a retry is in flight;
 *   - a rejecting onRetry surfaces the localized fail-closed error WITHOUT
 *     changing the rows (the store resync stays authoritative).
 *
 * Runner: bun:test + happy-dom (useDomEnv). i18n returns keys verbatim. RTL
 * cleanup() runs after every test.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();
const { render: rtlRender, fireEvent, act } = await import("@testing-library/react");
const { TooltipProvider } = await import("../shared/Tooltip.js");
function render(ui: React.ReactNode, options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, { wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider>, ...options });
}

// ─── i18n mock (keys verbatim; interpolation ignored — stable key text) ──────
installI18nContextSeam();

const { ExperienceEffectDiagnostics } = await import("./ExperienceEffectDiagnostics.js");
import type { ExperienceEffectRow } from "../../api/types.js";

function makeEffect(over: Partial<ExperienceEffectRow> = {}): ExperienceEffectRow {
  return {
    id: "eff-1",
    sessionId: "sess-1",
    kind: "model",
    status: "failed",
    originatingRevision: 1,
    requestJson: "{}",
    resultJson: null,
    error: "provider unavailable",
    attemptCount: 0,
    createdAt: "T0",
    updatedAt: "T0",
    ...over,
  } as ExperienceEffectRow;
}

let onRetry: ReturnType<typeof mock>;
let retryImpl: (effectId: string) => Promise<void>;

beforeEach(() => {
  onRetry = mock((_effectId: string) => retryImpl(_effectId));
  retryImpl = async () => {};
});

afterEach(() => {
  // Drain pending microtasks so an in-flight retry never leaks across tests.
});

describe("ExperienceEffectDiagnostics — row filtering", () => {
  it("renders nothing when there are no retryable rows", () => {
    const { container } = render(
      <ExperienceEffectDiagnostics
        effects={[
          makeEffect({ id: "e-p", status: "pending", error: null }),
          makeEffect({ id: "e-r", status: "running", error: null }),
          makeEffect({ id: "e-s", status: "succeeded", error: null }),
        ]}
        onRetry={onRetry as unknown as (effectId: string) => Promise<void>}
      />,
    );
    expect(container.querySelector('[data-testid="experience-effect-diagnostics"]')).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("renders one row per failed/cancelled/unknown effect with status + error + retry", () => {
    const { getByTestId } = render(
      <ExperienceEffectDiagnostics
        effects={[
          makeEffect({ id: "e-p", status: "pending", error: null }),
          makeEffect({ id: "e-f", status: "failed", error: "model timed out" }),
          makeEffect({ id: "e-c", status: "cancelled", error: null }),
          makeEffect({ id: "e-u", status: "unknown", error: "outcome never recorded" }),
        ]}
        onRetry={onRetry as unknown as (effectId: string) => Promise<void>}
      />,
    );
    expect(getByTestId("experience-effect-row-e-f").textContent).toContain("experience_effect_status_failed");
    expect(getByTestId("experience-effect-row-e-f").textContent).toContain("model timed out");
    expect(getByTestId("experience-effect-row-e-c").textContent).toContain("experience_effect_status_cancelled");
    expect(getByTestId("experience-effect-row-e-u").textContent).toContain("experience_effect_status_unknown");
    // Only the retryable rows have retry buttons — the pending row renders no row.
    expect(getByTestId("experience-effect-retry-e-f")).toBeTruthy();
    expect(getByTestId("experience-effect-retry-e-c")).toBeTruthy();
    expect(getByTestId("experience-effect-retry-e-u")).toBeTruthy();
  });

  it("a failed row without error text still renders (status + retry, no error span)", () => {
    const { getByTestId, queryByTestId } = render(
      <ExperienceEffectDiagnostics
        effects={[makeEffect({ id: "e-f", status: "failed", error: null })]}
        onRetry={onRetry as unknown as (effectId: string) => Promise<void>}
      />,
    );
    expect(getByTestId("experience-effect-row-e-f")).toBeTruthy();
    expect(queryByTestId("experience-effect-error")).toBeNull();
  });
});

describe("ExperienceEffectDiagnostics — retry action", () => {
  it("clicking retry calls onRetry with that row's effect id", async () => {
    const { getByTestId } = render(
      <ExperienceEffectDiagnostics
        effects={[makeEffect({ id: "eff-9", status: "failed", error: "boom" })]}
        onRetry={onRetry as unknown as (effectId: string) => Promise<void>}
      />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("experience-effect-retry-eff-9"));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe("eff-9");
  });

  it("suppresses duplicate clicks while a retry is in flight", async () => {
    let release: (() => void) | null = null;
    retryImpl = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    const { getByTestId } = render(
      <ExperienceEffectDiagnostics
        effects={[makeEffect({ id: "eff-9", status: "failed" })]}
        onRetry={onRetry as unknown as (effectId: string) => Promise<void>}
      />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("experience-effect-retry-eff-9"));
    });
    const button = getByTestId("experience-effect-retry-eff-9") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("experience_effect_retrying");
    await act(async () => {
      fireEvent.click(button); // suppressed — onRetry still at 1
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.();
    });
  });

  it("a rejecting onRetry surfaces the localized error and keeps the rows unchanged", async () => {
    retryImpl = async () => {
      throw new Error("store returned null");
    };
    const { getByTestId } = render(
      <ExperienceEffectDiagnostics
        effects={[makeEffect({ id: "eff-9", status: "failed", error: "boom" })]}
        onRetry={onRetry as unknown as (effectId: string) => Promise<void>}
      />,
    );
    await act(async () => {
      fireEvent.click(getByTestId("experience-effect-retry-eff-9"));
    });
    expect(getByTestId("experience-effect-retry-error").textContent).toBe("experience_effect_retry_error");
    // Fail-closed: the row still shows the authoritative failed state.
    expect(getByTestId("experience-effect-row-eff-9").textContent).toContain("experience_effect_status_failed");
    // The button is re-enabled for another attempt.
    expect((getByTestId("experience-effect-retry-eff-9") as HTMLButtonElement).disabled).toBe(false);
  });
});


it("shows only the full error as a hint when the styled error row is clipped", async () => {
  const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  let clipped = false;
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => clipped ? 300 : 100 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
  try {
    const ui = <ExperienceEffectDiagnostics effects={[makeEffect()]} onRetry={async () => {}} />;
    const first = render(ui);
    const label = first.getByText("experience_effect_error_label");
    expect(label.className).toBe("text-t4");
    fireEvent.pointerMove(first.getByTestId("experience-effect-error").parentElement!, { pointerType: "mouse" });
    expect(first.queryByRole("tooltip")).toBeNull();
    first.unmount();
    clipped = true;
    const second = render(ui);
    expect(second.getByText("experience_effect_error_label").className).toBe("text-t4");
    const measured = second.getByTestId("experience-effect-error").parentElement!;
    expect(measured.className).toBe("truncate min-w-0 flex-1 text-t3");
    fireEvent.pointerMove(measured, { pointerType: "mouse" });
    expect((await second.findByRole("tooltip")).textContent).toBe("provider unavailable");
    second.unmount();
  } finally {
    if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
});
