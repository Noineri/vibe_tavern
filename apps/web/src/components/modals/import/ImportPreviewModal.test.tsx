/**
 * Behavior pin for `<ImportPreviewModal>` (plan unit IF-4).
 *
 * The component is a presentational Modal wrapper with no caller until IF-5.
 * Per the Manual QA Gate ("Library / SDK / module — write a minimal driver
 * script that imports the new code and executes it end-to-end"), this is the
 * verification artifact. Pins the structural + behavioral contract IF-5 will
 * rely on:
 *   • renders the caller-supplied title, subtitle, and preview content;
 *   • the `open` prop defaults to true and gates visibility when explicit false;
 *   • the close button (header) fires `onClose`;
 *   • the cancel button (footer) fires `onClose`;
 *   • the confirm button fires `onConfirm` and renders the caller's label;
 *   • `isImporting` swaps the confirm label for `t("importing")` and disables
 *     the button.
 *
 * `useT` is mocked to `(key) => key` so assertions are locale-independent
 * (same pattern as `CoauthorProviderModal.test.tsx`). The `cancel` / `close` /
 * `importing` keys map verbatim to those strings; the caller-provided
 * `confirmLabel` and `title` / `subtitle` / preview text are passed through
 * untranslated, exactly as the production component uses them.
 *
 * Runner: vitest (apps/web) under happy-dom.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";

// useT must return a stable t() — the modal builds labels off it. Mocking at
// the module level keeps the test locale-independent and avoids pulling the
// real i18next resource bundle.
vi.mock("../../../i18n/context.js", () => ({
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

import { ImportPreviewModal, type ImportPreviewModalProps } from "./ImportPreviewModal.js";

const onClose = vi.fn();
const onConfirm = vi.fn();

const STATIC_PROPS = {
  title: "Preview title",
  subtitle: "Preview subtitle",
  preview: "PREVIEW_BODY" as ReactNode,
  confirmLabel: "Add to library",
} satisfies Pick<ImportPreviewModalProps, "title" | "subtitle" | "preview" | "confirmLabel">;

function renderModal(overrides: Partial<ImportPreviewModalProps> = {}): ReturnType<typeof render> {
  return render(
    <ImportPreviewModal
      {...STATIC_PROPS}
      isImporting={false}
      onClose={onClose}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  // Module-level vi.fn instances — clear call state between tests so each
  // assertion sees only this test's calls.
  onClose.mockClear();
  onConfirm.mockClear();
});

describe("ImportPreviewModal", () => {
  it("renders title, subtitle, preview content, and the caller's confirm label", () => {
    const view = renderModal();
    // Title and subtitle appear twice each: once in the visible header, once
    // in the sr-only <Dialog.Title>/<Dialog.Description> that Modal renders
    // from its title/description props for screen-reader announcements.
    expect(view.getAllByText("Preview title").length).toBe(2);
    expect(view.getAllByText("Preview subtitle").length).toBe(2);
    expect(view.getByText("PREVIEW_BODY")).toBeTruthy();
    expect(view.getByText("Add to library")).toBeTruthy();
    expect(view.getByText("cancel")).toBeTruthy();
    cleanup();
  });

  it("does not render its content when open is false", () => {
    const view = renderModal({ open: false });
    expect(view.queryByText("Preview title")).toBeNull();
    expect(view.queryByText("PREVIEW_BODY")).toBeNull();
    cleanup();
  });

  it("fires onClose when the header close button is clicked", () => {
    const view = renderModal();
    fireEvent.click(view.getByLabelText("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    cleanup();
  });

  it("fires onClose when the cancel button is clicked", () => {
    const view = renderModal();
    fireEvent.click(view.getByText("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    cleanup();
  });

  it("fires onConfirm when the confirm button is clicked", () => {
    const view = renderModal();
    fireEvent.click(view.getByText("Add to library"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });

  it("disables the confirm button and swaps its label to t('importing') when isImporting is true", () => {
    const view = renderModal({ isImporting: true });
    const confirmBtn = view.getByText("importing") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(view.queryByText("Add to library")).toBeNull();
    fireEvent.click(view.getByText("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
