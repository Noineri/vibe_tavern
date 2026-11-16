import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { brandId, type ChatId, type ChatBranchId, type MessageId, type MessageVariantId, type PromptTraceRecordDto } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import type { DiagnosticsGenerationPreview, DiagnosticsGenerationSelection } from "../../api/diagnostics-api.js";
import type { DetachedWindowAPI } from "happy-dom";

useDomEnv({ failOnNetwork: true });
const { render, fireEvent, waitFor, cleanup, act, within } = await import("@testing-library/react");
const { SettingsModal } = await import("../modals/SettingsModal.js");
const { registerAboutSettingsSection } = await import("./about-settings-section.js");
const { getSettingsSections, registerSettingsSection } = await import("../../lib/settings-section-registry.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { useModalStore } = await import("../../stores/modal-store.js");
const { useChatStore } = await import("../../stores/chat-store.js");

// L1: repo-relative imports, no DB/migrations, module mocks or real i18n changes.
// Real SettingsModal + About + dropdown/confirm/API client; only HTTP and browser
// download boundaries are doubled. Globals, registries, stores and URL spies are
// restored per test/file. Parked promises/resolved UI only; no sleeps/OS assumptions.
const originalFetch = globalThis.fetch;
const originalModal = useModalStore.getState();
const originalChat = useChatStore.getState();
const originalSections = getSettingsSections();
const originalWidth = window.innerWidth;
// The happy-dom global registered by useDomEnv(): lib.dom's Window type
// cannot express the test driver's happyDOM member, so the view is a
// documented narrowing (the registered window really carries it).
type HappyDomTestWindow = typeof window & { happyDOM: DetachedWindowAPI };
const browser = window as HappyDomTestWindow;
const cacheKey = "vibe-tavern.update-check.v3";
const originalCache = localStorage.getItem(cacheKey);
const createUrl = spyOn(URL, "createObjectURL");
const revokeUrl = spyOn(URL, "revokeObjectURL");
const clickAnchor = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
let disposeSection: (() => void) | undefined;
let requests: Array<{ path: string; method: string; body: unknown }>;
let history: () => Promise<Response>;
let preview: (selection: DiagnosticsGenerationSelection) => Promise<Response>;
let zip: () => Promise<Response>;

function trace(id: string, variant: string | null = `variant-${id}`): PromptTraceRecordDto {
  return {
    id, chatId: brandId<ChatId>("chat-a"), branchId: brandId<ChatBranchId>(`branch-${id}`),
    messageId: brandId<MessageId>(`message-${id}`), variantId: variant ? brandId<MessageVariantId>(variant) : null,
    model: `model-${id}`, presetName: "Preset", createdAt: "2026-11-04T00:00:00Z", latencyMs: 1,
    layers: [], finalPayload: {}, tokenAccounting: {}, activatedLoreEntries: [], scriptInjections: [], retrievedMemories: [],
  };
}
const attempts = [trace("trace-a"), trace("trace-b", null)];
function selection(attempt: PromptTraceRecordDto): DiagnosticsGenerationSelection {
  return { traceId: attempt.id, chatId: attempt.chatId, branchId: attempt.branchId, messageId: attempt.messageId, variantId: attempt.variantId ?? null };
}
function capture(target: DiagnosticsGenerationSelection): DiagnosticsGenerationPreview {
  const files = [{ path: "generation/request.json", bytes: 40, text: `REQUEST ${target.traceId} [redacted]` }];
  return { selection: target, model: `model-${target.traceId}`, presetName: "Preset", createdAt: "2026-11-04T00:00:00Z", entries: files, files, missing: ["providerResponse"] };
}
function parked<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  globalThis.fetch = originalFetch;
  useModalStore.setState(originalModal, true);
  useChatStore.setState(originalChat, true);
  useChatStore.setState({ activeChatId: brandId<ChatId>("chat-a") });
  browser.happyDOM.setWindowSize({ width: 1280 });
  localStorage.removeItem(cacheKey);
  createUrl.mockReset(); createUrl.mockReturnValue("blob:diagnostics");
  revokeUrl.mockReset(); revokeUrl.mockImplementation(() => {});
  clickAnchor.mockClear();
  requests = [];
  history = async () => Response.json(attempts);
  preview = async (target) => Response.json(capture(target));
  zip = async () => new Response("zip-fixture", { headers: { "Content-Type": "application/zip" } });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path.includes("api.github.com")) return new Response("{}", { status: 404 });
    if (path.endsWith("/api/runtime/info")) return Response.json({ currentVersion: "1.5.1", installKind: "dev", canSelfUpdate: false });
    if (path.includes("/api/chats/chat-a/traces")) return history();
    if (path.endsWith("/api/diagnostics/preview")) return preview(body.selection);
    if (path.endsWith("/api/diagnostics") && method === "GET") return Response.json({ entries: [{ path: "vt-info.json", bytes: 512 }, { path: "server-log.txt", bytes: 10 }, { path: "provider-profiles.json", bytes: 10 }, { path: "data-sizes.json", bytes: 10 }] });
    if (path.endsWith("/api/diagnostics") && method === "POST") return zip();
    throw new Error(`Unexpected request ${method} ${path}`);
  }, { preconnect: () => {} });
  disposeSection = registerAboutSettingsSection();
});
function restore() {
  disposeSection?.(); disposeSection = undefined;
  for (const section of originalSections) registerSettingsSection(section);
  useModalStore.setState(originalModal, true);
  useChatStore.setState(originalChat, true);
  globalThis.fetch = originalFetch;
  browser.happyDOM.setWindowSize({ width: originalWidth });
  if (originalCache === null) localStorage.removeItem(cacheKey); else localStorage.setItem(cacheKey, originalCache);
}
afterEach(() => { cleanup(); restore(); });
afterAll(() => { restore(); createUrl.mockRestore(); revokeUrl.mockRestore(); clickAnchor.mockRestore(); });
async function openExport() {
  useModalStore.getState().openSettings("about");
  const view = render(<TooltipProvider><SettingsModal /></TooltipProvider>);
  fireEvent.click(await view.findByRole("button", { name: "settings_about_diagnostics" }));
  await view.findByText("settings_about_diag_info");
  return view;
}
type View = Awaited<ReturnType<typeof openExport>>;
async function enable(view: View) {
  fireEvent.click(view.getByRole("switch", { name: "settings_about_diag_attach_toggle" }));
  await view.findByRole("group", { name: "settings_about_diag_attach_pick_label" });
}
async function pick(view: View, id: string) {
  fireEvent.click(within(view.getByRole("group", { name: "settings_about_diag_attach_pick_label" })).getByRole("button"));
  fireEvent.click(await view.findByRole("option", { name: new RegExp(`model-${id}`) }));
}
const zipRequests = () => requests.filter((request) => request.path.endsWith("/api/diagnostics") && request.method === "POST");
const previewRequests = () => requests.filter((request) => request.path.endsWith("/api/diagnostics/preview"));

describe("diagnostics consent in the real settings shell", () => {
  test("defaults to technical-only and never loads generation content before opt-in", async () => {
    const view = await openExport();
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(requests.some((request) => request.path.includes("/traces"))).toBe(false);
    expect(previewRequests()).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_download" }));
    await waitFor(() => expect(clickAnchor).toHaveBeenCalledTimes(1));
    expect(zipRequests().map((request) => request.body)).toEqual([undefined]);
    expect(revokeUrl).toHaveBeenCalledWith("blob:diagnostics");
    expect(view.queryByRole("switch")).toBeNull();
  });

  for (const width of [1280, 390]) {
  test(`at ${width}px shows the selected redacted capture and downloads content only after a separate confirmation`, async () => {
    browser.happyDOM.setWindowSize({ width });
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    await view.findByText("REQUEST trace-a [redacted]");
    expect(previewRequests().map((request) => request.body)).toEqual([{ selection: selection(attempts[0]!) }]);
    expect(view.getByText("settings_about_diag_preview_missing")).toBeTruthy();
    expect(view.getByText("settings_about_diag_attach_warning")).toBeTruthy();
    expect(zipRequests()).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_download" }));
    expect(view.getByText("settings_about_diag_content_confirm_body")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "cancel" }));
    expect(zipRequests()).toEqual([]);
    expect(view.getByRole("button", { name: "settings_about_diag_download" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_download" }));
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_confirm" }));
    await waitFor(() => expect(clickAnchor).toHaveBeenCalledTimes(1));
    expect(zipRequests().map((request) => request.body)).toEqual([{ attach: { selection: selection(attempts[0]!), confirmed: true } }]);
    fireEvent.click(view.getByRole("button", { name: "settings_about_diagnostics" }));
    await view.findByRole("switch");
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });
  }

  test("changing the selected generation invalidates a late preview and keeps the exact nullable variant tuple", async () => {
    const late = parked<Response>();
    preview = async (target) => target.traceId === "trace-a" ? late.promise : Response.json(capture(target));
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    await pick(view, "trace-b");
    await view.findByText("REQUEST trace-b [redacted]");
    await act(async () => { late.resolve(Response.json(capture(selection(attempts[0]!)))); await late.promise; });
    expect(view.queryByText("REQUEST trace-a [redacted]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_download" }));
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_confirm" }));
    await waitFor(() => expect(clickAnchor).toHaveBeenCalledTimes(1));
    expect(zipRequests()[0]?.body).toEqual({ attach: { selection: selection(attempts[1]!), confirmed: true } });
  });

  test("deselecting during history loading cannot restore an attachment", async () => {
    const late = parked<Response>(); history = () => late.promise;
    const view = await openExport();
    fireEvent.click(view.getByRole("switch"));
    await view.findByText("settings_about_diag_attach_loading");
    fireEvent.click(view.getByRole("switch"));
    await act(async () => { late.resolve(Response.json(attempts)); await late.promise; });
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(view.queryByRole("group", { name: "settings_about_diag_attach_pick_label" })).toBeNull();
    expect(previewRequests()).toEqual([]);
  });

  for (const action of ["cancel", "unmount", "selection"] as const) {
  test(`${action} invalidates a pending content download rather than saving stale content`, async () => {
    const late = parked<Response>(); zip = () => late.promise;
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    await view.findByText("REQUEST trace-a [redacted]");
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_download" }));
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_confirm" }));
    if (action === "cancel") fireEvent.click(view.getByRole("button", { name: "settings_about_diag_cancel" }));
    if (action === "unmount") view.unmount();
    if (action === "selection") { await pick(view, "trace-b"); await view.findByText("REQUEST trace-b [redacted]"); }
    await act(async () => { late.resolve(new Response("late-zip")); await late.promise; });
    expect(createUrl).not.toHaveBeenCalled();
    expect(clickAnchor).not.toHaveBeenCalled();
    if (action === "selection") expect(view.getByText("REQUEST trace-b [redacted]")).toBeTruthy();
  });
  }

  test("a deselected preview cannot reappear even when the same generation is chosen again", async () => {
    const late = parked<Response>();
    let calls = 0;
    preview = async (target) => ++calls === 1 ? late.promise : Response.json({ ...capture(target), files: [{ path: "generation/request.json", bytes: 10, text: "NEW_PREVIEW" }] });
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    fireEvent.click(view.getByRole("switch"));
    await enable(view); await pick(view, "trace-a");
    await view.findByText("NEW_PREVIEW");
    await act(async () => { late.resolve(Response.json(capture(selection(attempts[0]!)))); await late.promise; });
    expect(view.queryByText("REQUEST trace-a [redacted]")).toBeNull();
    expect(view.getByText("NEW_PREVIEW")).toBeTruthy();
    expect(zipRequests()).toEqual([]);
  });

  test("a mismatched preview is rejected instead of displaying or exporting another generation", async () => {
    preview = async () => Response.json(capture(selection(attempts[1]!)));
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    await view.findByText("settings_about_diag_preview_failed");
    expect(view.queryByText("REQUEST trace-b [redacted]")).toBeNull();
    expect(view.queryByRole("button", { name: "settings_about_diag_content_download" })).toBeNull();
    expect(zipRequests()).toEqual([]);
  });

  test("the picker does not arbitrarily hide attempts after the twentieth row", async () => {
    history = async () => Response.json(Array.from({ length: 21 }, (_, i) => trace(`saved-${i}`)));
    const view = await openExport();
    await enable(view); await pick(view, "saved-20");
    expect(await view.findByText("REQUEST saved-20 [redacted]")).toBeTruthy();
  });

  test("a failed content download leaves inspection available but still requires a new confirmation for retry", async () => {
    zip = async () => Response.json({}, { status: 503 });
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    await view.findByText("REQUEST trace-a [redacted]");
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_download" }));
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_confirm" }));
    await waitFor(() => expect((view.getByRole("button", { name: "settings_about_diag_content_download" }) as HTMLButtonElement).disabled).toBe(false));
    expect(zipRequests()).toHaveLength(1);
    expect(clickAnchor).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "settings_about_diag_content_download" }));
    expect(view.getByText("settings_about_diag_content_confirm_body")).toBeTruthy();
    expect(zipRequests()).toHaveLength(1);
  });

  test("reopening never remembers selection or consent", async () => {
    const view = await openExport();
    await enable(view); await pick(view, "trace-a");
    await view.findByText("REQUEST trace-a [redacted]");
    fireEvent.click(view.getByRole("button", { name: "close" }));
    act(() => useModalStore.getState().openSettings("about"));
    fireEvent.click(view.getByRole("button", { name: "settings_about_diagnostics" }));
    await view.findByRole("switch");
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(view.queryByText("REQUEST trace-a [redacted]")).toBeNull();
    expect(zipRequests()).toEqual([]);
  });

  for (const reason of ["noChat", "empty", "historyError", "previewError"] as const) {
    test(`${reason} keeps technical-only download available without inventing a capture`, async () => {
      if (reason === "noChat") useChatStore.setState({ activeChatId: null });
      if (reason === "empty") history = async () => Response.json([]);
      if (reason === "historyError") history = async () => Response.json({}, { status: 503 });
      if (reason === "previewError") preview = async () => Response.json({}, { status: 404 });
      const view = await openExport();
      fireEvent.click(view.getByRole("switch"));
      if (reason === "previewError") { await view.findByRole("group", { name: "settings_about_diag_attach_pick_label" }); await pick(view, "trace-a"); }
      await view.findByText(reason === "noChat" ? "settings_about_diag_attach_no_chat" : reason === "empty" ? "settings_about_diag_attach_no_traces" : reason === "previewError" ? "settings_about_diag_preview_failed" : "settings_about_diag_attach_failed");
      expect(view.queryByRole("button", { name: "settings_about_diag_content_download" })).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "settings_about_diag_download" }));
      await waitFor(() => expect(clickAnchor).toHaveBeenCalledTimes(1));
      expect(zipRequests().map((request) => request.body)).toEqual([undefined]);
    });
  }
});
