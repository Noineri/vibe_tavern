import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { DetachedWindowAPI } from "happy-dom";

useDomEnv({ failOnNetwork: true });

const { render, fireEvent, waitFor } = await import("@testing-library/react");
const { AboutSettingsSection, registerAboutSettingsSection } = await import("./about-settings-section.js");
const { __resetAboutCheckStateForTests } = await import("./about-update-block.js");
const { __resetUpdateFlowForTests } = await import("../../hooks/use-update-flow.js");
const { SettingsModal } = await import("../modals/SettingsModal.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { useModalStore } = await import("../../stores/modal-store.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
const { wireUiSettings } = await import("../../../test/wire-fixtures.js");
const { getSettingsSections, registerSettingsSection } = await import("../../lib/settings-section-registry.js");
type Descriptor = import("../../lib/settings-section-registry.js").SettingsSectionDescriptor;
type RuntimeUpdateCheck = import("../../api/runtime-api.js").RuntimeUpdateCheck;
type BootstrapData = import("../../stores/api-actions/bootstrap-actions.js").BootstrapData;

// L1: no paths/DBs or module doubles; real section/shell/store/registry and
// the real update-flow hook. Fetch is the only external boundary (restored
// per test and after the file); assertions wait for resolved states; no
// OS/order assumptions. Registry, store, viewport and the version-check
// localStorage cache are restored.

const originalFetch = globalThis.fetch;
const initialStore = useModalStore.getState();
const initialBootstrap = useBootstrapStore.getState();
const openSpy = spyOn(window, "open").mockImplementation(() => null);
const initialSections = getSettingsSections();
const initialWidth = window.innerWidth;
// The happy-dom global registered by useDomEnv(): lib.dom's Window type
// cannot express the test driver's happyDOM member, so the view is a
// documented narrowing (the registered window really carries it).
type HappyDomTestWindow = typeof window & { happyDOM: DetachedWindowAPI };
const browser = window as HappyDomTestWindow;
const UPDATE_CACHE_KEY = "vibe-tavern.update-check.v3";
const disposers: Array<() => void> = [];

const INFO = { currentVersion: "1.5.1", canSelfUpdate: true, installKind: "standalone" as const };

function verdict(overrides: Partial<RuntimeUpdateCheck>): RuntimeUpdateCheck {
  return {
    currentVersion: "1.5.1",
    latestVersion: "2.0.0",
    latestTag: "v2.0.0",
    releaseUrl: "https://github.com/Noineri/vibe_tavern/releases/tag/v2.0.0",
    releaseNotes: "Plain release notes",
    canSelfUpdate: true,
    installKind: "standalone",
    available: true,
    reason: "update-available",
    ...overrides,
  };
}

let requests: string[];
let routes: {
  info: () => unknown;
  check: () => unknown;
  trigger: () => unknown;
  status: () => unknown;
  github: () => unknown;
  openDataDir: () => unknown;
  diagManifest: () => unknown;
};
let statusCalls: number;

const DIAG_MANIFEST = {
  entries: [
    { path: "vt-info.json", bytes: 512 },
    { path: "server-log.txt", bytes: 2048 },
    { path: "provider-profiles.json", bytes: 128 },
    { path: "data-sizes.json", bytes: 96 },
  ],
};

beforeEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.removeItem(UPDATE_CACHE_KEY);
  useModalStore.setState(initialStore, true);
  useBootstrapStore.setState(initialBootstrap, true);
  openSpy.mockClear();
  setWidth(1280);
  // The update screen's state is module-scoped (survives section remounts);
  // every test starts from the fresh-open state the old component-local
  // state used to give for free.
  __resetAboutCheckStateForTests();
  __resetUpdateFlowForTests();
  requests = [];
  statusCalls = 0;
  routes = {
    info: () => INFO,
    check: () => verdict({}),
    trigger: () => ({ accepted: true }),
    status: () => ({ phase: "downloading-archive", startedAt: 0, currentVersion: "1.5.1", targetVersion: "2.0.0", downloadProgress: { receivedBytes: 5, totalBytes: 10 }, error: null }),
    github: () => new Response("{}", { status: 404 }),
    openDataDir: () => ({ opened: true }),
    diagManifest: () => DIAG_MANIFEST,
  };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    // happy-dom reports a "null" page origin, so runtime URLs arrive as
    // "null/api/…"; match on substrings, with reset before the update POST.
    const reply = (payload: unknown) => (payload instanceof Response ? payload : Response.json(payload));
    if (url.includes("api.github.com")) return reply(routes.github());
    if (method === "POST" && url.includes("/api/runtime/update/reset")) return Response.json({ ok: true });
    if (url.includes("/api/runtime/update/check")) return reply(routes.check());
    if (url.includes("/api/runtime/update/status")) { statusCalls++; return reply(routes.status()); }
    if (method === "POST" && url.includes("/api/runtime/update")) return reply(routes.trigger());
    if (method === "POST" && url.includes("/api/fs/open-data-dir")) return reply(routes.openDataDir());
    if (url.includes("/api/diagnostics")) {
      if (method === "POST") return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { "Content-Type": "application/zip" } });
      return reply(routes.diagManifest());
    }
    if (method === "PATCH" && url.includes("/api/settings/ui")) {
      // Echo the patch like the server's merged record would come back.
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      return reply({ ...wireUiSettings(), ...body });
    }
    if (url.includes("/api/runtime/info")) return reply(routes.info());
    throw new Error(`Unexpected request: ${method} ${url}`);
  }, { preconnect: () => {} });
});

afterEach(() => {
  cleanupSections();
  localStorage.removeItem(UPDATE_CACHE_KEY);
  useModalStore.setState(initialStore, true);
  useBootstrapStore.setState(initialBootstrap, true);
  setWidth(initialWidth);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  openSpy.mockRestore();
  __resetAboutCheckStateForTests();
  __resetUpdateFlowForTests();
  localStorage.removeItem(UPDATE_CACHE_KEY);
  useModalStore.setState(initialStore, true);
  useBootstrapStore.setState(initialBootstrap, true);
  setWidth(initialWidth);
  cleanupSections();
});

function setWidth(width: number) {
  browser.happyDOM.setWindowSize({ width });
}

function cleanupSections() {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const section of initialSections) registerSettingsSection(section);
}

function addStubSection(id: Descriptor["id"]) {
  disposers.push(registerSettingsSection({
    id,
    icon: <span aria-hidden="true">*</span>,
    labelKey: `settings_section_${id}`,
    render: () => <div>{`${id} body`}</div>,
  }));
}

function seedBootstrap(githubStarred: boolean): void {
  const data: BootstrapData = {
    initialChatId: null,
    snapshot: null,
    isFirstRun: false,
    allCharacters: [],
    promptPresets: [],
    uiSettings: { ...wireUiSettings(), githubStarred },
    agentKindSettings: {},
    isArmServer: false,
  };
  useBootstrapStore.setState({ data });
}

describe("about section body", () => {
  test("shows the runtime identity header and starts at the check button", async () => {
    const view = render(<AboutSettingsSection />);
    expect(await view.findByText("Vibe Tavern 1.5.1")).toBeTruthy();
    expect(view.getByText(/settings_about_install_standalone/)).toBeTruthy();
    expect(view.getByRole("button", { name: /settings_about_check_updates/ })).toBeTruthy();
    expect(view.queryByText("update_modal_release_header")).toBeNull();
    // Only the identity fetch and the silent boot badge check leave the section.
    const own = requests.filter((entry) => !entry.includes("api.github.com"));
    expect(own.length).toBe(1);
    expect(own[0]!.endsWith("/api/runtime/info")).toBe(true);
  });

  test("a pressed update-available verdict opens the release view with notes and the gated install action", async () => {
    const view = render(<AboutSettingsSection />);
    fireEvent.click(view.getByRole("button", { name: /settings_about_check_updates/ }));
    expect(await view.findByText("update_modal_release_header")).toBeTruthy();
    expect(view.getByText("Plain release notes")).toBeTruthy();
    expect(view.getByRole("button", { name: "update_modal_update_button" })).toBeTruthy();
    expect(view.queryByText("update_modal_self_update_unavailable")).toBeNull();
    // Views share one document; unmount so the next render's queries are its own.
    // A real reopen goes through the leave guard, which resets the pressed
    // check (old-modal state-per-open); a bare unmount+render models the
    // guard-less remount, so the reopen reset is applied explicitly here.
    view.unmount();
    __resetAboutCheckStateForTests();
    routes.check = () => verdict({ canSelfUpdate: false });
    const second = render(<AboutSettingsSection />);
    fireEvent.click(second.getByRole("button", { name: /settings_about_check_updates/ }));
    expect(await second.findByText("update_modal_self_update_unavailable")).toBeTruthy();
    expect(second.getByRole("button", { name: "update_modal_open_release_page" })).toBeTruthy();
    expect(second.queryByRole("button", { name: "update_modal_update_button" })).toBeNull();
  });

  test("no-asset, up-to-date, offline and failed checks render their verdict rows without install actions", async () => {
    routes.check = () => verdict({ available: false, reason: "no-asset-for-platform", canSelfUpdate: true });
    const noAsset = render(<AboutSettingsSection />);
    fireEvent.click(noAsset.getByRole("button", { name: /settings_about_check_updates/ }));
    expect(await noAsset.findByText("update_modal_release_header")).toBeTruthy();
    expect(noAsset.getByRole("button", { name: "update_modal_open_release_page" })).toBeTruthy();
    expect(noAsset.queryByRole("button", { name: "update_modal_update_button" })).toBeNull();
    noAsset.unmount();

    // Each verdict models a fresh open (the guard resets the pressed check on
    // a real leave); the bare remount between renders keeps it, hence the
    // explicit resets.
    __resetAboutCheckStateForTests();
    routes.check = () => verdict({ available: false, reason: "up-to-date", latestVersion: null, latestTag: null, releaseNotes: "" });
    const current = render(<AboutSettingsSection />);
    fireEvent.click(current.getByRole("button", { name: /settings_about_check_updates/ }));
    expect(await current.findByText("settings_about_up_to_date")).toBeTruthy();
    expect(current.queryByText("update_modal_release_header")).toBeNull();
    current.unmount();

    __resetAboutCheckStateForTests();
    routes.check = () => verdict({ available: false, reason: "offline", latestVersion: null, latestTag: null, releaseNotes: "" });
    const offline = render(<AboutSettingsSection />);
    fireEvent.click(offline.getByRole("button", { name: /settings_about_check_updates/ }));
    expect(await offline.findByText("settings_about_check_failed")).toBeTruthy();
    expect(offline.getByRole("button", { name: /settings_about_check_updates/ })).toBeTruthy();
    offline.unmount();

    routes.check = () => new Response("nope", { status: 500 });
    const failed = render(<AboutSettingsSection />);
    fireEvent.click(failed.getByRole("button", { name: /settings_about_check_updates/ }));
    expect(await failed.findByText("settings_about_check_failed")).toBeTruthy();
    expect(failed.queryByText("update_modal_release_header")).toBeNull();
  });

  test("a boot-known update opens the release view without a pressed check", async () => {
    routes.github = () => ({ tag_name: "v3.0.0", html_url: "https://github.com/Noineri/vibe_tavern/releases/tag/v3.0.0", body: "Boot notes" });
    const view = render(<AboutSettingsSection />);
    expect(await view.findByText("update_modal_release_header")).toBeTruthy();
    expect(view.getByText("Boot notes")).toBeTruthy();
    // The install gate needs the identity fetch; wait for the resolved frame.
    expect(await view.findByRole("button", { name: "update_modal_update_button" })).toBeTruthy();
    expect(requests.some((entry) => entry.endsWith("/api/runtime/update/check"))).toBe(false);
  });
});

describe("about update flow in the settings modal", () => {
  test("running and complete states stay non-dismissable across close and section changes", async () => {
    addStubSection("interface");
    disposers.push(registerAboutSettingsSection());
    useModalStore.getState().openSettings("about");
    const view = render(<TooltipProvider><SettingsModal /></TooltipProvider>);
    fireEvent.click(await view.findByRole("button", { name: /settings_about_check_updates/ }));
    fireEvent.click(await view.findByRole("button", { name: "update_modal_update_button" }));
    expect(await view.findByText("update_modal_phase_downloading_archive…")).toBeTruthy();

    // "running" — the swap is in flight; close and section change must not leave.
    fireEvent.click(view.getByRole("button", { name: "close" }));
    expect(useModalStore.getState().isSettingsOpen).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "settings_section_interface" }));
    expect(view.getByText("update_modal_phase_downloading_archive…")).toBeTruthy();
    expect(view.queryByText("interface body")).toBeNull();

    // Next poll completes the swap; the server is gone and the modal stays up.
    routes.status = () => ({ phase: "done", startedAt: 0, currentVersion: "1.5.1", targetVersion: "2.0.0", downloadProgress: null, error: null });
    expect(await view.findByText("update_modal_complete", { exact: false })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "close" }));
    expect(useModalStore.getState().isSettingsOpen).toBe(true);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  test("a viewport-cross remount keeps the running update screen and its guard (defect 2026-11-04)", async () => {
    addStubSection("interface");
    disposers.push(registerAboutSettingsSection());
    useModalStore.getState().openSettings("about");
    const view = render(<TooltipProvider><SettingsModal /></TooltipProvider>);
    fireEvent.click(await view.findByRole("button", { name: /settings_about_check_updates/ }));
    fireEvent.click(await view.findByRole("button", { name: "update_modal_update_button" }));
    expect(await view.findByText("update_modal_phase_downloading_archive…")).toBeTruthy();

    // Desktop → mobile: the modal swaps its layout tree and REMOUNTS the
    // section. The old component-local state snapped back to idle — progress
    // vanished and closing was allowed again while the server kept swapping.
    view.unmount();
    setWidth(390);
    const remounted = render(<TooltipProvider><SettingsModal /></TooltipProvider>);
    expect(await remounted.findByText("update_modal_phase_downloading_archive…")).toBeTruthy();
    expect(remounted.queryByRole("button", { name: /settings_about_check_updates/ })).toBeNull();

    // The non-dismissable law holds for the remounted view too.
    fireEvent.click(remounted.getByRole("button", { name: "close" }));
    expect(useModalStore.getState().isSettingsOpen).toBe(true);
    remounted.unmount();
  });

  test("an error state resets the orchestrator on dismiss and on modal close", async () => {
    addStubSection("interface");
    disposers.push(registerAboutSettingsSection());
    routes.status = () => ({ phase: "error", startedAt: 0, currentVersion: "1.5.1", targetVersion: "2.0.0", downloadProgress: null, error: { kind: "soft", message: "boom", phase: "verifying", stack: null, raw: null } });
    useModalStore.getState().openSettings("about");
    const view = render(<TooltipProvider><SettingsModal /></TooltipProvider>);
    fireEvent.click(await view.findByRole("button", { name: /settings_about_check_updates/ }));
    fireEvent.click(await view.findByRole("button", { name: "update_modal_update_button" }));
    expect(await view.findByText("boom")).toBeTruthy();
    expect(view.getByRole("button", { name: "update_modal_retry" })).toBeTruthy();

    // Dismiss returns to the release view and clears the server orchestrator.
    fireEvent.click(view.getByRole("button", { name: "update_modal_dismiss" }));
    expect(await view.findByText("update_modal_release_header")).toBeTruthy();
    const resetPosts = () => requests.filter((entry) => entry.startsWith("POST") && entry.endsWith("/api/runtime/update/reset")).length;
    expect(resetPosts()).toBe(1);

    // Leaving in the error state (the old modal's close-in-error reset) posts reset again.
    fireEvent.click(view.getByRole("button", { name: "update_modal_update_button" }));
    expect(await view.findByText("boom")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "close" }));
    expect(useModalStore.getState().isSettingsOpen).toBe(false);
    expect(resetPosts()).toBe(2);
  });
});

describe("about project block", () => {
  test("starring opens the repo, persists githubStarred and flips to the starred state", async () => {
    seedBootstrap(false);
    const view = render(<AboutSettingsSection />);
    expect(view.getByRole("button", { name: "settings_about_star" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "settings_about_star" }));
    expect(openSpy).toHaveBeenCalledWith("https://github.com/Noineri/vibe_tavern", "_blank", "noopener,noreferrer");
    expect(await view.findByText("settings_about_starred")).toBeTruthy();
    expect(requests.some((entry) => entry.startsWith("PATCH") && entry.endsWith("/api/settings/ui"))).toBe(true);
    // The starred state keeps the button usable (re-open the repo) without a second write.
    openSpy.mockClear();
    fireEvent.click(view.getByRole("button", { name: "settings_about_starred" }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(requests.filter((entry) => entry.startsWith("PATCH")).length).toBe(1);
  });

  test("the issue button opens the new-issue page in a new tab", () => {
    const view = render(<AboutSettingsSection />);
    fireEvent.click(view.getByRole("button", { name: "settings_about_issue" }));
    expect(openSpy).toHaveBeenCalledWith("https://github.com/Noineri/vibe_tavern/issues/new", "_blank", "noopener,noreferrer");
  });

  test("open data folder posts the route on desktop and hides on mobile", () => {
    const view = render(<AboutSettingsSection />);
    fireEvent.click(view.getByRole("button", { name: "settings_about_open_data_dir" }));
    expect(requests.some((entry) => entry.startsWith("POST") && entry.endsWith("/api/fs/open-data-dir"))).toBe(true);
    view.unmount();
    setWidth(390);
    const phone = render(<AboutSettingsSection />);
    expect(phone.queryByRole("button", { name: "settings_about_open_data_dir" })).toBeNull();
    expect(phone.getByRole("button", { name: "settings_about_star" })).toBeTruthy();
    expect(phone.getByRole("button", { name: "settings_about_issue" })).toBeTruthy();
  });

  test("diagnostics shows the item list before downloading, then returns to idle", async () => {
    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => { const url = `blob:diag-${createdUrls.length}`; createdUrls.push(url); return url; };
    URL.revokeObjectURL = (url: string) => { revokedUrls.push(url); };
    try {
      const view = render(<AboutSettingsSection />);
      fireEvent.click(view.getByRole("button", { name: "settings_about_diagnostics" }));
      // The list comes from the manifest and names every entry BEFORE the download.
      expect(await view.findByText("settings_about_diag_info")).toBeTruthy();
      expect(view.getByText("settings_about_diag_log")).toBeTruthy();
      expect(view.getByText("settings_about_diag_providers")).toBeTruthy();
      expect(view.getByText("settings_about_diag_sizes")).toBeTruthy();
      expect(view.getByText("512 Bytes")).toBeTruthy();
      expect(view.getByText("2 KB")).toBeTruthy();
      expect(requests.some((entry) => entry.startsWith("GET") && entry.endsWith("/api/diagnostics"))).toBe(true);
      expect(requests.some((entry) => entry.startsWith("POST") && entry.endsWith("/api/diagnostics"))).toBe(false);

      fireEvent.click(view.getByRole("button", { name: "settings_about_diag_download" }));
      await waitFor(() => {
        expect(createdUrls.length).toBe(1);
        expect(revokedUrls).toEqual(createdUrls);
      });
      expect(requests.some((entry) => entry.startsWith("POST") && entry.endsWith("/api/diagnostics"))).toBe(true);
      expect(view.queryByText("settings_about_diag_download")).toBeNull();

      // Cancel returns to idle without a download request.
      fireEvent.click(view.getByRole("button", { name: "settings_about_diagnostics" }));
      await view.findByText("settings_about_diag_info");
      fireEvent.click(view.getByRole("button", { name: "settings_about_diag_cancel" }));
      expect(view.queryByText("settings_about_diag_info")).toBeNull();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
