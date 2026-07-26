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
 * Runner: bun:test (apps/web) with scoped happy-dom.
 */
import { describe, it, expect, mock, beforeAll, beforeEach } from "bun:test";
import type { ReactNode } from "react";
import { render, fireEvent, waitFor, within } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ImportPreviewModalProps } from "./ImportPreviewModal.js";

useDomEnv();

// useT must return a stable t() — the modal builds labels off it. Mocking at
// the module level keeps the test locale-independent and avoids pulling the
// real i18next resource bundle.
const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

let ImportPreviewModal: typeof import("./ImportPreviewModal.js").ImportPreviewModal;
beforeAll(async () => {
	({ ImportPreviewModal } = await import("./ImportPreviewModal.js"));
});

const onClose = mock();
const onConfirm = mock();

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
	// Module-level mock instances — clear call state between tests so each
  // assertion sees only this test's calls.
  onClose.mockClear();
  onConfirm.mockClear();
});

describe("ImportPreviewModal", () => {
	it("renders title, subtitle, preview content, and the caller's confirm label", async () => {
		const view = renderModal();
		await waitFor(() => expect(view.baseElement.textContent).toContain("Preview title"));
		const modal = within(view.baseElement);
    // Title and subtitle appear twice each: once in the visible header, once
    // in the sr-only <Dialog.Title>/<Dialog.Description> that Modal renders
    // from its title/description props for screen-reader announcements.
		expect(modal.getAllByText("Preview title").length).toBe(2);
		expect(modal.getAllByText("Preview subtitle").length).toBe(2);
		expect(modal.getByText("PREVIEW_BODY")).toBeTruthy();
		expect(modal.getByText("Add to library")).toBeTruthy();
		expect(modal.getByText("cancel")).toBeTruthy();
  });

  it("does not render its content when open is false", () => {
    const view = renderModal({ open: false });
    expect(view.queryByText("Preview title")).toBeNull();
    expect(view.queryByText("PREVIEW_BODY")).toBeNull();
  });

	it("fires onClose when the header close button is clicked", async () => {
		const view = renderModal();
		await waitFor(() => expect(view.baseElement.textContent).toContain("Preview title"));
		fireEvent.click(within(view.baseElement).getByLabelText("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

	it("fires onClose when the cancel button is clicked", async () => {
		const view = renderModal();
		await waitFor(() => expect(view.baseElement.textContent).toContain("Preview title"));
		fireEvent.click(within(view.baseElement).getByText("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

	it("fires onConfirm when the confirm button is clicked", async () => {
		const view = renderModal();
		await waitFor(() => expect(view.baseElement.textContent).toContain("Preview title"));
		fireEvent.click(within(view.baseElement).getByText("Add to library"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

	it("disables the confirm button and swaps its label to t('importing') when isImporting is true", async () => {
		const view = renderModal({ isImporting: true });
		await waitFor(() => expect(view.baseElement.textContent).toContain("importing"));
		const modal = within(view.baseElement);
		const confirmBtn = modal.getByText("importing") as HTMLButtonElement;
		expect(confirmBtn.disabled).toBe(true);
		expect(modal.queryByText("Add to library")).toBeNull();
		fireEvent.click(modal.getByText("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
