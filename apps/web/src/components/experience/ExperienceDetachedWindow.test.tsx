/**
 * ExperienceDetachedWindow — window.open mechanism + trusted-host tests (IR-62).
 *
 * The live handshake is covered elsewhere; here we pin the SURFACE contract:
 *   - openExperienceDetachedWindow stashes the descriptor and opens a same-origin
 *     hash URL (`#experience=<sessionId>`) with the detached features;
 *   - a blocked popup returns null and the caller is expected to handle it
 *     (we assert the null is surfaced, not papered over);
 *   - readDetachedDescriptor reads the stashed descriptor back from the opener
 *     and rejects a malformed one;
 *   - ExperienceDetachedHost renders trusted chrome + the SAME sandboxed frame
 *     (the user visual is never the top-level document), and shows the
 *     unavailable fallback when there is no descriptor.
 *
 * The bridge functions take an injectable `win` (production defaults to
 * globalThis); tests pass a fake so they never touch the readonly happy-dom
 * window.location/opener.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { render } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { DetachWindow } from "./ExperienceDetachedWindow.js";

useDomEnv();

// URL spy so the embedded ExperienceFrame does not make happy-dom navigate.
const realCreate = URL.createObjectURL;
function installUrlSpy() {
  URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;
}
afterEach(() => {
  URL.createObjectURL = realCreate;
});

// Mock the Experience store so the detached host's setScope/rehydrate/reads do
// not make real API calls. The host uses the descriptor bootstrap before the
// rehydrate settles, so a null store session is the normal initial state.
const realStore = await import("../../stores/experience-store.js");
const storeMocks = {
  setScope: mock(),
  submitAction: mock(),
  runEffect: mock(),
};
mock.module("../../stores/experience-store.js", () => ({
  ...realStore,
  useExperienceSession: () => null,
  useExperienceEffects: () => [],
  useExperienceStore: {
    getState: () => ({
      setScope: storeMocks.setScope,
      submitAction: storeMocks.submitAction,
      runEffect: storeMocks.runEffect,
    }),
  },
}));

const {
  openExperienceDetachedWindow,
  readDetachedDescriptor,
  isDetachedExperienceWindow,
  ExperienceDetachedHost,
  DETACHED_WINDOW_FEATURES,
} = await import("./ExperienceDetachedWindow.js");

const DESCRIPTOR = {
  chatId: "chat_1",
  branchId: "branch_1",
  sessionId: "sess_42",
  title: "Hearts",
  visualSource: "<div>play</div>",
  initialRevision: 3,
};

/** A minimal fake opener window with a controllable location + open() result. */
function fakeOpener(props: { pathname?: string; search?: string; open?: Window | null }): DetachWindow {
  return {
    location: { pathname: props.pathname ?? "/app", search: props.search ?? "", hash: "" },
    opener: null,
    // Pass through exactly — `null` means "popup blocked". (Do NOT coalesce,
    // which would turn null into {}.)
    open: () => props.open as Window | null,
  } as unknown as DetachWindow;
}

/** A minimal fake popup window whose `opener` points at the given descriptor. */
function fakePopup(openerDesc?: unknown): DetachWindow {
  return {
    location: { pathname: "/app", search: "", hash: openerDesc ? "#experience=sess_42" : "" },
    opener: openerDesc ? ({ __experienceDetachDescriptor: openerDesc } as unknown as DetachWindow["opener"]) : null,
    open: () => null,
  } as unknown as DetachWindow;
}

describe("openExperienceDetachedWindow — mechanism + popup-blocked fallback", () => {
  it("opens a same-origin hash URL and stashes the descriptor on the opener", () => {
    let openedUrl = "";
    let openedFeatures = "";
    const handle = {} as Window;
    const opener = {
      location: { pathname: "/app", search: "?x=1", hash: "" },
      opener: null,
      open: (url?: string, _t?: string, features?: string) => {
        openedUrl = url ?? "";
        openedFeatures = features ?? "";
        return handle;
      },
    } as unknown as DetachWindow;

    const result = openExperienceDetachedWindow(DESCRIPTOR, opener);

    expect(result).toBe(handle);
    expect(openedUrl).toBe("/app?x=1#experience=sess_42");
    expect(openedFeatures).toBe(DETACHED_WINDOW_FEATURES);
    // Descriptor stashed on the opener for the popup to read via window.opener.
    expect(opener.__experienceDetachDescriptor).toEqual(DESCRIPTOR);
  });

  it("surfaces a blocked popup as null (does not pretend success)", () => {
    const opener = fakeOpener({ open: null });
    expect(openExperienceDetachedWindow(DESCRIPTOR, opener)).toBeNull();
  });
});

describe("readDetachedDescriptor — opener handoff", () => {
  it("returns null when there is no opener descriptor", () => {
    expect(readDetachedDescriptor(fakePopup(null))).toBeNull();
  });

  it("reads a valid descriptor from the opener", () => {
    expect(readDetachedDescriptor(fakePopup(DESCRIPTOR))).toEqual(DESCRIPTOR);
  });

  it("rejects a malformed descriptor (no visualSource)", () => {
    expect(readDetachedDescriptor(fakePopup({ sessionId: "x" }))).toBeNull();
  });

  it("rejects a descriptor missing the scope fields (chatId/branchId)", () => {
    expect(
      readDetachedDescriptor(
        fakePopup({ sessionId: "s", title: "T", visualSource: "<div/>", initialRevision: 0 }),
      ),
    ).toBeNull();
  });
});

describe("isDetachedExperienceWindow", () => {
  it("detects the #experience hash", () => {
    const withHash = { location: { hash: "#experience=sess_42" } } as Pick<DetachWindow, "location">;
    const without = { location: { hash: "" } } as Pick<DetachWindow, "location">;
    expect(isDetachedExperienceWindow(withHash)).toBe(true);
    expect(isDetachedExperienceWindow(without)).toBe(false);
  });
});

describe("ExperienceDetachedHost — trusted wrapper", () => {
  it("renders trusted chrome + the sandboxed frame from an explicit descriptor", () => {
    installUrlSpy();
    const { getByText, container, queryByTestId } = render(
      <ExperienceDetachedHost descriptor={DESCRIPTOR} />,
    );
    // Trusted title in chrome.
    expect(getByText("Hearts")).toBeTruthy();
    // The detached close-self control is present (trusted chrome).
    expect(queryByTestId("experience-detached-close")).not.toBeNull();
    // The user visual is inside an iframe (sandboxed), NOT the top-level doc.
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");
    // The host set the store scope for the exact chat/branch (reconnect).
    expect(storeMocks.setScope).toHaveBeenCalledWith("chat_1", "branch_1");
  });

  it("shows the unavailable fallback when there is no descriptor", () => {
    installUrlSpy();
    // readDetachedDescriptor() (default window) returns null under happy-dom
    // (no opener), so the host falls back.
    const { container, queryByTestId } = render(<ExperienceDetachedHost />);
    expect(queryByTestId("experience-detached-close")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
