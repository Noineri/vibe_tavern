import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GenerationBatchSummary } from "../../stores/generation-queue-store.js";
import { useDomEnv } from "../../../test/dom-env.js";
import ru from "../../i18n/locales/ru.json";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let LocaleProvider: typeof import("../../i18n/context.js").LocaleProvider;
let QueueChip: typeof import("./queue-chip.js").QueueChip;
let i18next: typeof import("../../i18n/i18n.js").i18next;
let initI18n: typeof import("../../i18n/i18n.js").initI18n;

beforeAll(async () => {
  ({ render, act } = await import("@testing-library/react"));
  ({ LocaleProvider } = await import("../../i18n/context.js"));
  ({ QueueChip } = await import("./queue-chip.js"));
  ({ i18next, initI18n } = await import("../../i18n/i18n.js"));
  initI18n("en");
});

afterAll(async () => {
  await act(async () => {
    await i18next.changeLanguage("en");
  });
});

function renderChip(summary: GenerationBatchSummary, mobile = false, locale: "en" | "ru" = "en") {
  return render(
    <LocaleProvider initialLocale={locale}>
      <QueueChip summary={summary} mobile={mobile} />
    </LocaleProvider>,
  );
}

function interpolateResource(resource: string, values: Record<string, number>): string {
  return resource.replace(/\{(\w+)\}/g, (_placeholder, name: string) => String(values[name]));
}

function getDasharray(circle: Element): [number, number] {
  const dasharray = circle.getAttribute("stroke-dasharray");
  expect(dasharray).not.toBeNull();

  const segments = dasharray!.split(" ").map(Number);
  expect(segments).toHaveLength(2);
  return [segments[0]!, segments[1]!];
}

function expectApproximately(actual: number, expected: number, tolerance = 0.1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function expectRingSegments(
  ring: Element,
  doneArc: Element,
  failedArc: Element,
  expectedDoneLength: number,
  expectedFailedOffset = -expectedDoneLength,
): void {
  const track = ring.querySelector("circle.stroke-border");
  expect(track).not.toBeNull();
  expect(track!.getAttribute("class")).toBe("stroke-border");
  expect(doneArc.getAttribute("class")).toBe("stroke-accent");
  expect(failedArc.getAttribute("class")).toBe("stroke-danger-text");

  const [doneLength, doneCircumference] = getDasharray(doneArc);
  const [failedLength, failedCircumference] = getDasharray(failedArc);
  expectApproximately(doneLength, expectedDoneLength);
  expectApproximately(doneCircumference, 44);
  expectApproximately(failedLength, 5.5);
  expectApproximately(failedCircumference, 44);
  expectApproximately(Number(failedArc.getAttribute("stroke-dashoffset")), expectedFailedOffset);
}

describe("QueueChip", () => {
  test("renders the active progress ring without a failure suffix or check", () => {
    const { getByRole, getByTestId, queryByTestId } = renderChip({ done: 5, failed: 1, running: 1, pending: 1, total: 8 });

    const button = getByRole("button", { name: /Generation queue/ });
    expect(button.textContent).toContain("5 of 8");
    expect(button.getAttribute("aria-label")).toBe("Generation queue: 5 of 8 · 1 error");
    expect(queryByTestId("queue-chip-failures")).toBeNull();
    expect(queryByTestId("queue-chip-check")).toBeNull();
    expect(queryByTestId("queue-chip-ring")?.getAttribute("class")).toContain("animate-spin-slow");
    expectRingSegments(
      getByTestId("queue-chip-ring"),
      getByTestId("queue-chip-done-arc"),
      getByTestId("queue-chip-failed-arc"),
      14,
      -27.5,
    );
  });

  test("does not spin for pending-only work", () => {
    const { getByTestId } = renderChip({ done: 5, failed: 0, running: 0, pending: 1, total: 6 });

    expect(getByTestId("queue-chip-ring").getAttribute("class") ?? "").not.toContain("animate-spin-slow");
  });

  test("shows a check only for all-success settled work", () => {
    const { getByRole, getByTestId, queryByTestId } = renderChip({ done: 8, failed: 0, running: 0, pending: 0, total: 8 });

    const button = getByRole("button", { name: /Generation queue/ });
    expect(button.textContent).toContain("8 of 8");
    expect(button.getAttribute("aria-label")).toBe("Generation queue: 8 of 8");
    expect(getByTestId("queue-chip-check")).not.toBeNull();
    expect(queryByTestId("queue-chip-failures")).toBeNull();
  });

  test("shows settled failures without a check", () => {
    const { getByRole, getByTestId, queryByTestId } = renderChip({ done: 7, failed: 1, running: 0, pending: 0, total: 8 });

    const button = getByRole("button", { name: /Generation queue/ });
    expect(button.textContent).toContain("7 of 8");
    expect(button.getAttribute("aria-label")).toBe("Generation queue: 7 of 8 · 1 error");
    expect(getByTestId("queue-chip-failures").textContent).toBe("· 1 error");
    expectRingSegments(
      getByTestId("queue-chip-ring"),
      getByTestId("queue-chip-done-arc"),
      getByTestId("queue-chip-failed-arc"),
      38.5,
    );
    expect(queryByTestId("queue-chip-check")).toBeNull();
  });

  test("uses CLDR failure forms and the responsive footprints", async () => {
    const en = renderChip({ done: 6, failed: 2, running: 0, pending: 0, total: 8 });
    expect(en.getByTestId("queue-chip-failures").textContent).toBe("· 2 errors");
    expect(en.getByRole("button").getAttribute("class")).toBe("glass-blur flex items-center rounded-full border border-border2 bg-glass-bg font-ui font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1 h-[26px] gap-1.5 px-2.5 text-[calc(var(--ui-fs)-2px)]");
    expect(en.getByTestId("queue-chip-ring").getAttribute("class")).toBe("h-4 w-4");
    en.unmount();

    await act(async () => {
      await i18next.changeLanguage("ru");
    });
    const ruOne = renderChip({ done: 7, failed: 1, running: 0, pending: 0, total: 8 }, true, "ru");
    const ruOneFailure = interpolateResource(ru.queue_chip_failures_one, { count: 1 });
    expect(ruOne.getByTestId("queue-chip-failures").textContent).toBe(ruOneFailure);
    expect(ruOne.getByRole("button").textContent).toContain(interpolateResource(ru.queue_chip_progress, { done: 7, total: 8 }));
    expect(ruOne.getByRole("button").getAttribute("aria-label")).toBe(`${interpolateResource(ru.queue_chip_aria, { done: 7, total: 8 })} ${ruOneFailure}`);
    expect(ruOne.getByRole("button").getAttribute("class")).toBe("glass-blur flex items-center rounded-full border border-border2 bg-glass-bg font-ui font-medium text-t2 shadow-sm transition-colors hover:bg-s3 hover:text-t1 h-9 gap-2 px-3.5 text-[calc(var(--ui-fs))]");
    expect(ruOne.getByTestId("queue-chip-ring").getAttribute("class")).toBe("h-5 w-5");
    ruOne.unmount();

    const ruFew = renderChip({ done: 6, failed: 2, running: 0, pending: 0, total: 8 }, true, "ru");
    expect(ruFew.getByTestId("queue-chip-failures").textContent).toBe(interpolateResource(ru.queue_chip_failures_few, { count: 2 }));
    ruFew.unmount();
    const ruMany = renderChip({ done: 3, failed: 5, running: 0, pending: 0, total: 8 }, true, "ru");
    expect(ruMany.getByTestId("queue-chip-failures").textContent).toBe(interpolateResource(ru.queue_chip_failures_many, { count: 5 }));
  });
});
