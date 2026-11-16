import type { Window as HappyWindow } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();
installI18nContextSeam();

let FloatingImageViewer: typeof import("./GalleryViewer.js").FloatingImageViewer;
let TooltipProvider: typeof import("../../shared/Tooltip.js").TooltipProvider;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ TooltipProvider } = await import("../../shared/Tooltip.js"));
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ FloatingImageViewer } = await import("./GalleryViewer.js"));
});

const browser = window as unknown as HappyWindow;
const originalWidth = window.innerWidth;
afterEach(() => browser.happyDOM.setWindowSize({ width: originalWidth }));
afterAll(() => browser.happyDOM.setWindowSize({ width: originalWidth }));

describe("FloatingImageViewer desktop frame", () => {
  it("keeps wheel handling, dragging and close on the image frame", () => {
    const onClose = mock(() => {});
    const view = render(<TooltipProvider><FloatingImageViewer src="image.png" alt="image" onClose={onClose} /></TooltipProvider>);
    const frame = view.getByAltText("image").parentElement!;
    const wheel = new WheelEvent("wheel", { deltaY: 20, bubbles: true, cancelable: true });
    fireEvent(frame, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    const left = frame.style.left;
    fireEvent.mouseDown(frame, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 50, clientY: 40 });
    fireEvent.mouseUp(window);
    expect(frame.style.left).not.toBe(left);
    fireEvent.click(view.getByLabelText("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FloatingImageViewer mobile", () => {
  it("keeps image taps separate from close and Escape", () => {
    browser.happyDOM.setWindowSize({ width: 390 });
    const onClose = mock(() => {});
    const view = render(<TooltipProvider delayDuration={0}><FloatingImageViewer src="image.png" alt="image" onClose={onClose} /></TooltipProvider>);
    fireEvent.click(view.getByAltText("image"));
    expect(onClose).toHaveBeenCalledTimes(0);
    fireEvent.click(view.getByLabelText("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
