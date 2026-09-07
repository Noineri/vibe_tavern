/**
 * RootErrorBoundary — the last-resort crash screen.
 *
 * Pins that a throwing child renders the themed fallback (title + body +
 * reload action) instead of an unmounted tree, and that healthy children pass
 * through untouched.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ReactNode } from "react";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let LocaleProvider: typeof import("../../i18n/context.js").LocaleProvider;
let RootErrorBoundary: typeof import("./RootErrorBoundary.js").RootErrorBoundary;
let i18next: typeof import("../../i18n/i18n.js").i18next;
let initI18n: typeof import("../../i18n/i18n.js").initI18n;

beforeAll(async () => {
  ({ render, act } = await import("@testing-library/react"));
  ({ LocaleProvider } = await import("../../i18n/context.js"));
  ({ RootErrorBoundary } = await import("./RootErrorBoundary.js"));
  ({ i18next, initI18n } = await import("../../i18n/i18n.js"));
  // i18next initializes ONCE per process (initI18n early-returns afterwards),
  // so pin the baseline locale here; the RU test switches explicitly.
  initI18n("en");
});

function Thrower(): ReactNode {
  throw new Error("boom");
}

function renderWithLocale(ui: ReactNode, initialLocale: "en" | "ru") {
  return render(
    <LocaleProvider initialLocale={initialLocale}>
      <RootErrorBoundary>{ui}</RootErrorBoundary>
    </LocaleProvider>,
  );
}

/** React logs the caught error via console.error — capture and silence it. */
function silenceConsoleError(): { restore: () => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return { restore: () => { console.error = original; }, calls };
}

describe("RootErrorBoundary", () => {
  test("renders the themed fallback when a child throws, and surfaces the error to the console", () => {
    const { restore, calls } = silenceConsoleError();
    try {
      const { getByText, queryByText } = renderWithLocale(<Thrower />, "en");
      expect(queryByText("boom")).toBeNull();
      expect(getByText("Something went wrong")).not.toBeNull();
      expect(getByText("The page ran into a problem. Reloading usually restores it.")).not.toBeNull();
      expect(getByText("Reload page")).not.toBeNull();
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test("fallback is translated (RU)", async () => {
    const { restore } = silenceConsoleError();
    try {
      await act(async () => {
        await i18next.changeLanguage("ru");
      });
      const { getByText } = renderWithLocale(<Thrower />, "ru");
      expect(getByText("Что-то пошло не так")).not.toBeNull();
      expect(getByText("Перезагрузить страницу")).not.toBeNull();
    } finally {
      await act(async () => {
        await i18next.changeLanguage("en");
      });
      restore();
    }
  });

  test("healthy children render untouched", () => {
    const { getByText, queryByText } = renderWithLocale(<div>fine</div>, "en");
    expect(getByText("fine")).not.toBeNull();
    expect(queryByText("Something went wrong")).toBeNull();
  });
});
