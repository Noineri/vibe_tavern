import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });
const { render, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { MobileAccessSection } = await import("./mobile-access-section.js");
const QRCode = (await import("qrcode")).default;

// L1: no paths/DBs or module doubles; real API seam, QR encoder and body.
// Fetch/clipboard/confirm are external boundaries, restored per test/file.
// Assertions wait for resolved UI states, never sleeps; no OS/order assumptions.
const originalFetch = globalThis.fetch;
const originalConfirm = window.confirm;
const clipboard = spyOn(navigator.clipboard, "writeText");
const access = { ips: [
  { address: "192.168.1.20", type: "primary", interfaceName: "eth0" },
  { address: "100.64.0.2", type: "tailscale", interfaceName: "tailscale0" },
  { address: "10.0.0.4", type: "fallback", interfaceName: "eth1" },
], port: 8787, token: "secret /+", tlsEnabled: true };
let info: Omit<typeof access, "token"> & { token: string | null };
let requests: string[];
let copies: string[];
let confirms: string[];
let approve: boolean;
beforeEach(() => {
  globalThis.fetch = originalFetch;
  window.confirm = originalConfirm;
  info = { ...access }; requests = []; copies = []; confirms = []; approve = true;
  clipboard.mockImplementation(async (text) => { copies.push(text); });
  window.confirm = (message) => { confirms.push(String(message)); return approve; };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST") { info = { ...info, token: "replacement" }; return Response.json({ ok: true }); }
    if (method === "DELETE") return Response.json({ ok: true });
    if (url === "/api/settings/mobile-access") return Response.json(info);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }, { preconnect: () => {} });
});
afterAll(() => { globalThis.fetch = originalFetch; window.confirm = originalConfirm; clipboard.mockRestore(); });

describe("mobile access body", () => {
  test("preserves encoded HTTPS QR/addresses, token visibility/copy and mutation confirmations", async () => {
    let disabled = 0;
    const view = render(<MobileAccessSection onDisabled={() => { disabled++; }} />);
    const url = "https://192.168.1.20:8787/#token=secret%20%2F%2B";
    await view.findByText(url);
    const expectedSvg = await QRCode.toString(url, { type: "svg", width: 200, margin: 1 });
    const expectedQr = new DOMParser().parseFromString(expectedSvg, "image/svg+xml");
    expect(Array.from(view.baseElement.querySelectorAll(".bg-white svg path"), (path) => path.getAttribute("d"))).toEqual(Array.from(expectedQr.querySelectorAll("path"), (path) => path.getAttribute("d")));
    expect(view.getByText("https://100.64.0.2:8787/#token=secret%20%2F%2B")).toBeTruthy();
    expect(view.getByText("https://10.0.0.4:8787/#token=secret%20%2F%2B")).toBeTruthy();
    fireEvent.click(view.getAllByRole("button", { name: "mobile_access_copy" })[0]!);
    await view.findByRole("button", { name: "mobile_access_copied" });
    expect(copies).toEqual([url]);
    const tokenRow = view.getByText("mobile_access_token").parentElement!;
    fireEvent.click(tokenRow.querySelector("button")!);
    expect(within(tokenRow).getByText(access.token)).toBeTruthy();
    fireEvent.click(within(tokenRow).getByRole("button", { name: "mobile_access_copy" }));
    await waitFor(() => expect(copies).toEqual([url, access.token]));
    approve = false;
    fireEvent.click(view.getByRole("button", { name: "mobile_access_regenerate" }));
    fireEvent.click(view.getByRole("button", { name: "mobile_access_disable" }));
    expect(requests).toEqual(["GET /api/settings/mobile-access"]);
    expect(confirms).toEqual(["mobile_access_regenerate_confirm", "mobile_access_disable_confirm"]);
    approve = true;
    fireEvent.click(view.getByRole("button", { name: "mobile_access_regenerate" }));
    await view.findByText("https://192.168.1.20:8787/#token=replacement");
    expect(requests.slice(-2)).toEqual(["POST /api/settings/mobile-access/regenerate", "GET /api/settings/mobile-access"]);
    fireEvent.click(view.getByRole("button", { name: "mobile_access_disable" }));
    await waitFor(() => expect(disabled).toBe(1));
    expect(view.getByRole("button", { name: "mobile_access_enable" })).toBeTruthy();
  });

  test("does not enable on entry; explicit Enable creates a token and uses HTTP when TLS is off", async () => {
    info = { ...info, token: null, tlsEnabled: false };
    const view = render(<MobileAccessSection />);
    const enable = await view.findByRole("button", { name: "mobile_access_enable" });
    expect(requests).toEqual(["GET /api/settings/mobile-access"]);
    fireEvent.click(enable);
    await view.findByText("http://192.168.1.20:8787/#token=replacement");
    expect(requests).toEqual(["GET /api/settings/mobile-access", "POST /api/settings/mobile-access/regenerate", "GET /api/settings/mobile-access"]);
    expect(confirms).toEqual([]);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByText("mobile_access_firewall_warn")).toBeTruthy();
    expect(view.getByText("mobile_access_alternate_ips")).toBeTruthy();
  });

  test("a rejected mutation preserves the enabled state, and a failed initial read supports retry", async () => {
    const respond = globalThis.fetch;
    let rejectRead = true;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (rejectRead || init?.method === "DELETE") return Response.json({}, { status: 503 });
      return respond(input, init);
    }, { preconnect: () => {} });
    let disabled = 0;
    const view = render(<MobileAccessSection onDisabled={() => { disabled++; }} />);
    expect(await view.findByRole("alert")).toBeTruthy();
    expect(view.queryByRole("button", { name: "mobile_access_enable" })).toBeNull();
    rejectRead = false;
    fireEvent.click(view.getByRole("button", { name: "retry" }));
    await view.findByText("https://192.168.1.20:8787/#token=secret%20%2F%2B");
    fireEvent.click(view.getByRole("button", { name: "mobile_access_disable" }));
    expect(await view.findByRole("alert")).toBeTruthy();
    expect(view.getByText("https://192.168.1.20:8787/#token=secret%20%2F%2B")).toBeTruthy();
    expect(disabled).toBe(0);
  });

  test("a late read from an unmounted body cannot replace the new body's token or QR", async () => {
    const respond = globalThis.fetch;
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    let first = true;
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      if (first) { first = false; return oldResponse; }
      return respond(input, init);
    }, { preconnect: () => {} });
    const old = render(<MobileAccessSection />);
    old.unmount();
    info = { ...info, token: "current" };
    const view = render(<MobileAccessSection />);
    const url = "https://192.168.1.20:8787/#token=current";
    await view.findByText(url);
    const qrPath = view.baseElement.querySelector(".bg-white svg path[stroke]")?.getAttribute("d");
    await act(async () => { resolveOld(Response.json({ ...access, token: "stale" })); await oldResponse; });
    expect(view.getByText(url)).toBeTruthy();
    expect(view.queryByText("https://192.168.1.20:8787/#token=stale")).toBeNull();
    expect(view.baseElement.querySelector(".bg-white svg path[stroke]")?.getAttribute("d")).toBe(qrPath);
  });

  test("a completed disable cannot notify or close a later section after unmount", async () => {
    const respond = globalThis.fetch;
    let finishDisable!: (response: Response) => void;
    const pendingDisable = new Promise<Response>((resolve) => { finishDisable = resolve; });
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => init?.method === "DELETE" ? pendingDisable : respond(input, init), { preconnect: () => {} });
    let notifications = 0;
    const view = render(<MobileAccessSection onDisabled={() => { notifications++; }} />);
    fireEvent.click(await view.findByRole("button", { name: "mobile_access_disable" }));
    expect((view.getByRole("button", { name: "mobile_access_disable" }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    await act(async () => { finishDisable(Response.json({ ok: true })); await pendingDisable; });
    expect(notifications).toBe(0);
  });
});
