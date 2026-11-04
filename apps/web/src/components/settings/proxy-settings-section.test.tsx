import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ProxyRecord } from "../../api/types.js";

useDomEnv({ failOnNetwork: true });
const { render, fireEvent, cleanup, waitFor, act } = await import("@testing-library/react");
const { ProxySettingsTestHost } = await import("../../../test/proxy-settings-host.js");
const { useModalStore } = await import("../../stores/modal-store.js");
// L1: real SettingsModal/section/forms/registry; callback DI is the existing
// server-operation boundary. No paths, network/module mocks, sleeps or DBs.
// Harness restores registration; exact modal state is restored per test/file.
const originalModal = useModalStore.getState();
beforeEach(() => { useModalStore.setState(originalModal, true); useModalStore.getState().openSettings("network"); });
afterEach(() => { cleanup(); useModalStore.setState(originalModal, true); });
afterAll(() => useModalStore.setState(originalModal, true));
const proxy: ProxyRecord = { id: "p1", name: "Office", url: "https://proxy.example:8443", username: "ada", hasStoredPassword: true, sortOrder: 0, createdAt: "0", updatedAt: "0" };

describe("proxy settings list-to-editor", () => {
  test("opens at the list, edits in place, guards Back and closing, and resets on reopening", async () => {
    const view = render(<ProxySettingsTestHost proxies={[proxy]} defaultProxyId="p1" onCreate={async () => proxy} onUpdate={async () => proxy} onDelete={async () => {}} onRefresh={async () => {}} onProvidersChanged={async () => {}} />);
    expect(view.queryByDisplayValue("Office")).toBeNull();
    expect(await view.findByText("proxy_default_badge")).toBeTruthy();
    expect(view.getByText(proxy.url)).toBeTruthy();
    fireEvent.pointerDown(view.getByTestId("proxy-row-p1"));
    fireEvent.change(view.getByLabelText("proxy_name"), { target: { value: "Changed" } });
    expect(view.getByRole("button", { name: "save" }).closest("[data-scroll-area]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "proxies" }));
    expect(view.getByText("unsaved_changes_title")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "keep_editing" }));
    expect(view.getByDisplayValue("Changed")).toBeTruthy();
    fireEvent.click(view.getAllByRole("button", { name: "close" })[0]!);
    expect(useModalStore.getState().isSettingsOpen).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "close_without_saving" }));
    expect(useModalStore.getState().isSettingsOpen).toBe(false);
    act(() => useModalStore.getState().openSettings("network"));
    await waitFor(() => expect(view.getByTestId("proxy-row-p1")).toBeTruthy());
    expect(view.queryByDisplayValue("Changed")).toBeNull();
  });

  test("creates through the same trimmed write contract and preserves the draft on rejected save", async () => {
    let fail = true;
    const writes: unknown[] = [];
    const view = render(<ProxySettingsTestHost proxies={[]} defaultProxyId={null} onCreate={async (input) => { writes.push(input); if (fail) throw new Error("injected write failure"); return { ...proxy, name: input.name, url: input.url }; }} onUpdate={async () => proxy} onDelete={async () => {}} onRefresh={async () => {}} onProvidersChanged={async () => {}} />);
    fireEvent.click(await view.findByRole("button", { name: "proxy_new" }));
    fireEvent.change(view.getByLabelText("proxy_name"), { target: { value: " New " } });
    fireEvent.change(view.getByLabelText("proxy_url"), { target: { value: " https://new.example " } });
    fireEvent.click(view.getByRole("button", { name: "save" }));
    expect(await view.findByRole("alert")).toBeTruthy();
    expect((view.getByLabelText("proxy_name") as HTMLInputElement).value).toBe(" New ");
    expect((view.getByLabelText("proxy_url") as HTMLInputElement).value).toBe(" https://new.example ");
    fail = false;
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await view.findByRole("button", { name: "saved" });
    expect(writes).toEqual([{ name: "New", url: "https://new.example", username: null, password: undefined }, { name: "New", url: "https://new.example", username: null, password: undefined }]);
  });
});
