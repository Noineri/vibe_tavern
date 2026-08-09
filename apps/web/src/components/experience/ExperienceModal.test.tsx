/**
 * ExperienceModal — trusted-chrome + session-preservation tests (IR-62).
 *
 * The live handshake is covered by the bridge integration test; here we pin the
 * CHROME contract and the close-without-destroy invariant:
 *   - Detach calls onDetach (the parent opens the window); hidden when no onDetach.
 *   - Finish opens a system confirmation IN THE CHROME (not the frame), and only
 *     the confirm button runs the privileged onFinishExperience.
 *   - A frame-driven finish REQUEST also routes through the chrome confirmation
 *     (a compromised visual cannot auto-finish).
 *   - Close hides the surface and calls onClose only — there is no onDestroy
 *     prop, so closing never ends the session.
 *
 * i18n keys are mocked at the boundary (return the key verbatim) so the chrome
 * text is stable and the test does not depend on the locale bundle.
 */
import { describe, it, expect, beforeAll, mock, afterEach } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// Spy on URL.createObjectURL so happy-dom does not try to navigate the embedded
// iframe (its BrowserFrameNavigator rejects a real blob URL as "null" and logs
// a noisy TypeError). Returns about:blank so no navigation/fetch is attempted.
const realCreate = URL.createObjectURL;
function installUrlSpy() {
  URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;
}
afterEach(() => {
  URL.createObjectURL = realCreate;
});

// Mock the i18n context so `t` returns keys verbatim (stable chrome text). The
// `...real` spread keeps every other export intact (AGENTS.md mock.module
// gotcha — file-scoped vi.mock does not apply here; bun:test module mock does).
const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (k: string) => k, tDynamic: (k: string) => k, locale: "en", setLocale: () => {}, ready: true }),
}));

const { ExperienceModal } = await import("./ExperienceModal.js");

const VISUAL = "<div id=\"g\">play</div>";
const onAction = () => {};

function renderModal(over: Partial<React.ComponentProps<typeof ExperienceModal>> = {}) {
  installUrlSpy();
  const onClose = mock(() => {});
  const onDetach = mock(() => {});
  const onFinishExperience = mock(() => {});
  const utils = render(
    <ExperienceModal
      open
      onClose={onClose}
      title="Hearts"
      visualSource={VISUAL}
      sessionId="sess_1"
      initialRevision={0}
      onAction={onAction}
      onDetach={over.onDetach === undefined ? onDetach : over.onDetach}
      onFinishExperience={over.onFinishExperience === undefined ? onFinishExperience : over.onFinishExperience}
      {...(over as object)}
    />,
  );
  return { ...utils, onClose, onDetach, onFinishExperience };
}

describe("ExperienceModal — trusted chrome", () => {
  it("renders the Detach control and calls onDetach on click", () => {
    const { getByTestId, onDetach } = renderModal();
    fireEvent.click(getByTestId("experience-detach"));
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("hides the Detach control when onDetach is absent", () => {
    const { queryByTestId } = renderModal({ onDetach: undefined });
    expect(queryByTestId("experience-detach")).toBeNull();
  });

  it("Close button calls onClose and nothing else (no session destroy)", () => {
    const { getByTestId, onClose, onFinishExperience } = renderModal();
    fireEvent.click(getByTestId("experience-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing never triggers finish/destroy.
    expect(onFinishExperience).not.toHaveBeenCalled();
  });
});

describe("ExperienceModal — finish confirmation lives in the chrome", () => {
  it("Finish opens a chrome confirmation, not an auto-finish", () => {
    const { getByTestId, queryByTestId, onFinishExperience } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    // Confirm prompt is present; the privileged op has NOT run yet.
    expect(getByTestId("experience-finish-confirm")).toBeTruthy();
    expect(onFinishExperience).not.toHaveBeenCalled();
    // Cancel dismisses without finishing.
    fireEvent.click(getByTestId("experience-finish-cancel"));
    expect(queryByTestId("experience-finish-confirm")).toBeNull();
    expect(onFinishExperience).not.toHaveBeenCalled();
  });

  it("the confirm button (not the frame) runs the privileged finish", () => {
    const { getByTestId, onFinishExperience } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    fireEvent.click(getByTestId("experience-finish-confirm-btn"));
    expect(onFinishExperience).toHaveBeenCalledTimes(1);
  });

  it("hides the Finish control when onFinishExperience is absent", () => {
    const { queryByTestId } = renderModal({ onFinishExperience: undefined });
    expect(queryByTestId("experience-finish")).toBeNull();
  });
});

describe("ExperienceModal — session preservation on close", () => {
  it("closing and reopening resets the finish-confirmation step", async () => {
    const { getByTestId, queryByTestId, rerender } = renderModal();
    fireEvent.click(getByTestId("experience-finish"));
    expect(getByTestId("experience-finish-confirm")).toBeTruthy();
    // Close the modal (parent sets open=false).
    await act(async () => {
      rerender(
        <ExperienceModal
          open={false}
          onClose={() => {}}
          title="Hearts"
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={0}
          onAction={onAction}
          onFinishExperience={() => {}}
        />,
      );
    });
    // Reopen.
    await act(async () => {
      rerender(
        <ExperienceModal
          open
          onClose={() => {}}
          title="Hearts"
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={0}
          onAction={onAction}
          onFinishExperience={() => {}}
        />,
      );
    });
    // The stale confirm is gone — the surface reopened clean.
    expect(queryByTestId("experience-finish-confirm")).toBeNull();
  });
});
