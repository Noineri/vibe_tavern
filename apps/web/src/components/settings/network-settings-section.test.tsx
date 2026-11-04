import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Window as HappyWindow } from "happy-dom";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ProxyRecord } from "../../api/types.js";

useDomEnv({ failOnNetwork: true });
const { render, fireEvent, act, cleanup, waitFor } = await import("@testing-library/react");
const { NetworkSettingsProvider, registerNetworkSettingsSection, openNetworkSettings } = await import("./network-settings-section.js");
const { getNetworkSettingsBlocks, registerNetworkSettingsBlock, NETWORK_SETTINGS_ORDER } = await import("../../lib/network-settings-registry.js");
const { getSettingsSections, registerSettingsSection } = await import("../../lib/settings-section-registry.js");
const { SettingsModal } = await import("../modals/SettingsModal.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { useModalStore } = await import("../../stores/modal-store.js");

// L1: no paths/DBs/module doubles/i18n changes; real registry/context/modal/bodies.
// Existing proxy callbacks are DI; only mobile GET is doubled at fetch.
// All registry/global/store/viewport mutations are restored; resolved-state
// waits only, with no OS or execution-order assumptions.
const originalFetch = globalThis.fetch;
const originalModal = useModalStore.getState();
const originalSections = getSettingsSections();
const originalBlocks = getNetworkSettingsBlocks();
const width = window.innerWidth;
const browser = window as unknown as HappyWindow;
const disposers: Array<() => void> = [];
let requests: string[];
beforeEach(() => {
  globalThis.fetch = originalFetch;
  useModalStore.setState(originalModal, true);
  browser.happyDOM.setWindowSize({ width: 1280 });
  requests = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    if (String(input) === "/api/settings/mobile-access") return Response.json({ ips: [], port: 8787, token: null, tlsEnabled: false });
    throw new Error(`Unexpected fetch: ${String(input)}`);
  }, { preconnect: () => {} });
  disposers.push(registerNetworkSettingsSection());
});
function restore() {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const block of originalBlocks) registerNetworkSettingsBlock(block);
  for (const section of originalSections) registerSettingsSection(section);
  globalThis.fetch = originalFetch;
  useModalStore.setState(originalModal, true);
  browser.happyDOM.setWindowSize({ width });
}
afterEach(() => { cleanup(); restore(); });
afterAll(restore);
const proxy: ProxyRecord = { id: "office", name: "Office", url: "https://proxy.example", username: "", hasStoredPassword: false, sortOrder: 0, createdAt: "0", updatedAt: "0" };
const operations = { onCreate: async () => proxy, onUpdate: async () => proxy, onDelete: async () => {}, onRefresh: async () => {}, onProvidersChanged: async () => {} };
function Host({ proxies = [proxy] }: { proxies?: ProxyRecord[] }) {
  return <NetworkSettingsProvider value={{ proxies, defaultProxyId: "office", ...operations }}><TooltipProvider><SettingsModal /></TooltipProvider></NetworkSettingsProvider>;
}
function blockOrder(view: ReturnType<typeof render>) {
  return Array.from(view.baseElement.querySelectorAll("[data-network-settings-block]"), (element) => element.getAttribute("data-network-settings-block"));
}

describe("Network settings integration", () => {
  test("registers only real blocks, opens atomically, and keeps proxy data/drafts tied to the supplied owner", async () => {
    expect(getNetworkSettingsBlocks().map((block) => block.id)).toEqual(["proxies", "mobile-access"]);
    useModalStore.getState().setTweaksOpen(true);
    openNetworkSettings();
    expect(useModalStore.getState()).toMatchObject({ isSettingsOpen: true, settingsSection: "network", tweaksOpen: false });
    const view = render(<Host />);
    await view.findByRole("button", { name: "mobile_access_enable" });
    expect(blockOrder(view)).toEqual(["proxies", "mobile-access"]);
    expect(view.getAllByRole("dialog")).toHaveLength(1);
    expect(view.getByText("proxy_default_badge")).toBeTruthy();
    fireEvent.pointerDown(view.getByTestId("proxy-row-office"));
    fireEvent.change(view.getByLabelText("proxy_name"), { target: { value: "Local draft" } });
    view.rerender(<Host proxies={[{ ...proxy, name: "Parent refresh" }]} />);
    expect(view.getByDisplayValue("Local draft")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "proxies" }));
    fireEvent.click(view.getByRole("button", { name: "close_without_saving" }));
    expect(view.getByText("Parent refresh")).toBeTruthy();
    expect(requests).toEqual(["/api/settings/mobile-access"]);
  });

  test("a late catalog block lands between proxies and access without resetting an active editor", async () => {
    openNetworkSettings();
    const view = render(<Host />);
    await view.findByRole("button", { name: "mobile_access_enable" });
    fireEvent.pointerDown(view.getByTestId("proxy-row-office"));
    fireEvent.change(view.getByLabelText("proxy_name"), { target: { value: "Unsaved" } });
    act(() => { disposers.push(registerNetworkSettingsBlock({ id: "model-catalog", order: NETWORK_SETTINGS_ORDER.modelCatalog, render: () => <div>external catalog</div> })); });
    expect(blockOrder(view)).toEqual(["proxies", "model-catalog", "mobile-access"]);
    expect(view.getByDisplayValue("Unsaved")).toBeTruthy();
    expect(view.getByText("external catalog")).toBeTruthy();
    const snapshot = getNetworkSettingsBlocks();
    expect(getNetworkSettingsBlocks()).toBe(snapshot);
    let oldDispose!: () => void;
    act(() => { oldDispose = registerNetworkSettingsBlock({ id: "model-catalog", order: NETWORK_SETTINGS_ORDER.modelCatalog, render: () => <div>old catalog</div> }); disposers.push(oldDispose); });
    act(() => { disposers.push(registerNetworkSettingsBlock({ id: "model-catalog", order: NETWORK_SETTINGS_ORDER.modelCatalog, render: () => <div>current catalog</div> })); oldDispose(); });
    expect(view.getByText("current catalog")).toBeTruthy();
  });

  test("phone Network keeps proxy editing and never mounts or fetches the desktop access block", async () => {
    browser.happyDOM.setWindowSize({ width: 390 });
    openNetworkSettings();
    const view = render(<Host />);
    await waitFor(() => expect(view.getByTestId("proxy-row-office")).toBeTruthy());
    expect(blockOrder(view)).toEqual(["proxies"]);
    expect(view.queryByText("mobile_access")).toBeNull();
    expect(requests).toEqual([]);
    fireEvent.pointerDown(view.getByTestId("proxy-row-office"));
    expect(view.getByLabelText("proxy_password")).toBeTruthy();
    expect(view.getByRole("button", { name: "save" }).closest("[data-scroll-area]")).toBeNull();
  });
});
