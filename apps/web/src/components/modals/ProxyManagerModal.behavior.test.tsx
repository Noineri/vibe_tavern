import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { ProxyRecord } from "../../api/types.js";

useDomEnv();

let ProxyManagerModal: typeof import("./ProxyManagerModal.js").ProxyManagerModal;
let TooltipProvider: typeof import("../shared/Tooltip.js").TooltipProvider;
let useModalStore: typeof import("../../stores/modal-store.js").useModalStore;

beforeAll(async () => {
  ({ ProxyManagerModal } = await import("./ProxyManagerModal.js"));
  ({ TooltipProvider } = await import("../shared/Tooltip.js"));
  ({ useModalStore } = await import("../../stores/modal-store.js"));
});

afterAll(() => useModalStore.setState({ isProxyManagerOpen: false }));

const storedProxy: ProxyRecord = {
  id: "proxy_1",
  name: "Office",
  url: "https://proxy.example:8443",
  username: "ada",
  hasStoredPassword: true,
  sortOrder: 0,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

describe("ProxyManagerModal behavior", () => {
  beforeEach(() => useModalStore.setState({ isProxyManagerOpen: true }));

  test("preserves, explicitly clears, and deletes a write-only password through the real modal boundary", async () => {
    const updates: Array<{ id: string; password?: string | null }> = [];
    const deleted: string[] = [];
    let refreshes = 0;
    let providerRefreshes = 0;
    let releaseFirstUpdate: () => void = () => { throw new Error("Update gate was not initialized"); };
    const firstUpdateGate = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
    let waitForFirstUpdate = true;

    const view = render(
      <TooltipProvider>
        <ProxyManagerModal
          proxies={[storedProxy]}
          defaultProxyId="proxy_1"
          onCreate={async () => storedProxy}
          onUpdate={async (id, patch) => {
            updates.push({ id, password: patch.password });
            if (waitForFirstUpdate) {
              waitForFirstUpdate = false;
              await firstUpdateGate;
            }
            return { ...storedProxy, hasStoredPassword: patch.password !== null };
          }}
          onDelete={async (id) => { deleted.push(id); }}
          onRefresh={async () => { refreshes += 1; }}
          onProvidersChanged={async () => { providerRefreshes += 1; }}
        />
      </TooltipProvider>,
    );

    await waitFor(() => expect(view.getByDisplayValue("Office")).toBeTruthy());
    const proxyInputs = Array.from(view.baseElement.querySelectorAll("input"));
    expect(proxyInputs).toHaveLength(4);
    for (const input of proxyInputs) expect(input.classList.contains("field-input-pad")).toBe(true);

    const saveButton = view.getByRole("button", { name: "save" }) as HTMLButtonElement;
    expect(saveButton.classList.contains("min-w-[124px]")).toBe(true);
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(view.getByText("proxy_password_clear"));
    await waitFor(() => expect((view.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByText("cancel"));
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await waitFor(() => expect(view.getByRole("button", { name: "saving" })).toBeTruthy());
    releaseFirstUpdate();
    await waitFor(() => expect(updates).toHaveLength(1));
    await waitFor(() => expect(view.getByRole("button", { name: "saved" })).toBeTruthy());
    expect(saveButton.disabled).toBe(true);
    expect(updates[0]).toEqual({ id: "proxy_1", password: undefined });

    fireEvent.click(view.getByText("proxy_password_clear"));
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toEqual({ id: "proxy_1", password: null });

    fireEvent.click(view.getByText("proxy_delete"));
    await waitFor(() => expect(view.getAllByText("proxy_delete")).toHaveLength(2));
    fireEvent.click(view.getAllByText("proxy_delete")[1]!);
    await waitFor(() => expect(deleted).toEqual(["proxy_1"]));
    expect(refreshes).toBe(3);
    expect(providerRefreshes).toBe(1);
  });
});
