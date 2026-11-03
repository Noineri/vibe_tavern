import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { Window as HappyWindow } from "happy-dom";

useDomEnv({ failOnNetwork: true });

const { render, fireEvent, act, cleanup } = await import("@testing-library/react");
const { SettingsModal } = await import("./SettingsModal.js");
const { useModalStore } = await import("../../stores/modal-store.js");
const { getSettingsSections, registerSettingsSection, subscribeSettingsSections } = await import("../../lib/settings-section-registry.js");
type Descriptor = import("../../lib/settings-section-registry.js").SettingsSectionDescriptor;

// L1: no disk paths, no module doubles or timers, real shell/store/registry,
// stable DOM assertions, no DB setup. Registry, viewport and store are restored.
const initialStore = useModalStore.getState();
const initialSections = getSettingsSections();
const initialWidth = window.innerWidth;
const browser = window as unknown as HappyWindow;
const disposers: Array<() => void> = [];

function addSection(id: Descriptor["id"], platform?: Descriptor["platform"]) {
  const descriptor: Descriptor = {
    id,
    icon: <span aria-hidden="true">*</span>,
    labelKey: `settings_section_${id}`,
    render: () => <div>{`${id} body`}</div>,
    platform,
  };
  const dispose = registerSettingsSection(descriptor);
  disposers.push(dispose);
  return dispose;
}

function setWidth(width: number) {
  browser.happyDOM.setWindowSize({ width });
}

beforeEach(() => {
  useModalStore.setState(initialStore, true);
  setWidth(1280);
});

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const section of initialSections) registerSettingsSection(section);
  useModalStore.setState(initialStore, true);
  setWidth(initialWidth);
});

afterAll(() => {
  useModalStore.setState(initialStore, true);
  setWidth(initialWidth);
  for (const section of initialSections) registerSettingsSection(section);
});

describe("settings section registry", () => {
  test("keeps stable immutable snapshots, notifying on registration and disposal", () => {
    const before = getSettingsSections();
    let calls = 0;
    const unsubscribe = subscribeSettingsSections(() => { calls++; });
    disposers.push(unsubscribe);
    const remove = addSection("interface");
    expect(getSettingsSections()).not.toBe(before);
    expect(getSettingsSections()).toBe(getSettingsSections());
    expect(before).toEqual(initialSections);
    expect(calls).toBe(1);
    remove();
    expect(calls).toBe(2);
    remove();
    expect(calls).toBe(2);
    unsubscribe();
    addSection("about");
    expect(calls).toBe(2);
  });

  test("orders late registrations by section id, without registering a data placeholder", () => {
    addSection("about");
    addSection("network");
    addSection("sound");
    addSection("interface");
    expect(getSettingsSections().map((s) => s.id)).toEqual(["interface", "sound", "network", "about"]);
    addSection("data");
    expect(getSettingsSections().map((s) => s.id)).toEqual(["interface", "sound", "data", "network", "about"]);
  });

  test("replaces one id without duplicates; an old disposer cannot remove its replacement", () => {
    const removeOld = addSection("interface");
    addSection("interface");
    const replacement = getSettingsSections()[0];
    removeOld();
    expect(getSettingsSections()).toEqual([replacement!]);
  });
});

describe("settings modal", () => {
  test("is absent while closed and renders no unregistered placeholders", () => {
    const view = render(<SettingsModal />);
    expect(view.queryByRole("dialog")).toBeNull();
    act(() => useModalStore.getState().openSettings());
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.queryByText("settings_section_data")).toBeNull();
    expect(view.queryByText("interface body")).toBeNull();
  });

  test("defaults to the first registered section, selects rows, and closes through the store", () => {
    addSection("about");
    addSection("interface");
    useModalStore.getState().openSettings();
    const view = render(<SettingsModal />);
    expect(view.getByText("interface body")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "settings_section_about" }));
    expect(view.getByText("about body")).toBeTruthy();
    expect(view.queryByText("interface body")).toBeNull();
    expect(view.getByRole("button", { name: "settings_section_about" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: "close" }));
    expect(useModalStore.getState().isSettingsOpen).toBe(false);
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("reacts to late registrations and falls back when the selected section is removed", () => {
    const remove = addSection("about");
    useModalStore.getState().openSettings("about");
    const view = render(<SettingsModal />);
    act(() => { addSection("interface"); });
    expect(view.getAllByRole("button", { name: /^settings_section_/ }).map((el) => el.textContent)).toEqual(["*settings_section_interface", "*settings_section_about"]);
    act(remove);
    expect(view.getByText("interface body")).toBeTruthy();
    expect(view.queryByText("about body")).toBeNull();
  });

  test("mobile starts at the list; tapping a section drills down and back restores the list", () => {
    setWidth(390);
    addSection("interface");
    addSection("sound");
    useModalStore.getState().openSettings();
    const view = render(<SettingsModal />);
    expect(view.queryByText("interface body")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "settings_section_sound" }));
    expect(view.getByText("sound body")).toBeTruthy();
    expect(view.queryByRole("button", { name: "settings_section_interface" })).toBeNull();
    const back = view.getAllByRole("button").find((el) => !el.getAttribute("aria-label"));
    expect(back).toBeTruthy();
    fireEvent.click(back!);
    expect(view.getByRole("button", { name: "settings_section_interface" })).toBeTruthy();
    expect(view.queryByText("sound body")).toBeNull();
  });

  test("mobile deep links drill down, allow back, and support requesting the same section again", () => {
    setWidth(390);
    addSection("about");
    useModalStore.getState().openSettings("about");
    const view = render(<SettingsModal />);
    expect(view.getByText("about body")).toBeTruthy();
    const back = view.getAllByRole("button").find((el) => !el.getAttribute("aria-label"));
    fireEvent.click(back!);
    expect(view.queryByText("about body")).toBeNull();
    act(() => useModalStore.getState().openSettings("about"));
    expect(view.getByText("about body")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "close" }));
    act(() => useModalStore.getState().openSettings());
    expect(view.getByRole("button", { name: "settings_section_about" })).toBeTruthy();
    expect(view.queryByText("about body")).toBeNull();
  });

  test("an unavailable deep link falls back on desktop and waits at the list on mobile", () => {
    addSection("interface");
    useModalStore.getState().openSettings("data");
    const desktop = render(<SettingsModal />);
    expect(desktop.getByText("interface body")).toBeTruthy();
    desktop.unmount();
    setWidth(390);
    const phone = render(<SettingsModal />);
    expect(phone.queryByText("interface body")).toBeNull();
    act(() => { addSection("data"); });
    expect(phone.getByText("data body")).toBeTruthy();
  });

  test("platform gates filter the rows and prevent deep links into hidden sections", () => {
    addSection("interface");
    addSection("network", "desktop");
    addSection("sound", "mobile");
    useModalStore.getState().openSettings("sound");
    const desktop = render(<SettingsModal />);
    expect(desktop.queryByRole("button", { name: "settings_section_sound" })).toBeNull();
    expect(desktop.getByText("interface body")).toBeTruthy();
    desktop.unmount();
    setWidth(390);
    useModalStore.getState().openSettings("network");
    const phone = render(<SettingsModal />);
    expect(phone.queryByRole("button", { name: "settings_section_network" })).toBeNull();
    expect(phone.getByRole("button", { name: "settings_section_sound" })).toBeTruthy();
    expect(phone.queryByText("network body")).toBeNull();
  });
});
