import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserTheme } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv({ failOnNetwork: true });
const { render, fireEvent, within, cleanup, waitFor } = await import("@testing-library/react");
const { InterfaceSettingsSection } = await import("./interface-settings-section.js");
const { TweaksPanelBody } = await import("./popovers/TweaksPanel.js");
const { MobileSettings } = await import("./popovers/MobileSettings.js");
const { TooltipProvider } = await import("../shared/Tooltip.js");
const { useInterfaceTheme } = await import("../../hooks/use-interface-theme.js");
const { useInterfaceSettingsStore, INTERFACE_SETTINGS_STORAGE_KEY } = await import("../../stores/interface-settings-store.js");
const { useUserThemesStore } = await import("../../stores/user-themes-store.js");
const { useScriptSafetySettingsStore } = await import("../../stores/script-safety-settings-store.js");

// L1: full shells/section/shared controls + real stores/hook/RPC; only fetch is
// doubled (the external network boundary). No module mocks, paths, DBs or sleeps.
// Fetch, stores, storage key and root chrome restored per test and afterAll.
const originalFetch = globalThis.fetch;
const originalPreferences = useInterfaceSettingsStore.getState();
const originalCatalog = useUserThemesStore.getState();
const originalWarnings = useScriptSafetySettingsStore.getState();
const originalStored = localStorage.getItem(INTERFACE_SETTINGS_STORAGE_KEY);
const root = document.documentElement;
const originalClass = root.className;
const originalStyle = root.getAttribute("style");
const sample: UserTheme = { id: "sample", name: "tuned.css", css: ":root.user-sample { --bg: #123; }" };
let rows: UserTheme[];
let rejectUpload: boolean;
let deletes: number;
function restore() {
  globalThis.fetch = originalFetch;
  useInterfaceSettingsStore.setState(originalPreferences, true);
  useUserThemesStore.setState(originalCatalog, true);
  useScriptSafetySettingsStore.setState(originalWarnings, true);
  if (originalStored === null) localStorage.removeItem(INTERFACE_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(INTERFACE_SETTINGS_STORAGE_KEY, originalStored);
  root.className = originalClass;
  if (originalStyle === null) root.removeAttribute("style"); else root.setAttribute("style", originalStyle);
}
beforeEach(() => {
  restore(); rows = []; rejectUpload = false; deletes = 0;
  useInterfaceSettingsStore.getState().setSetting("theme", "coffee");
  useScriptSafetySettingsStore.setState({ suppressImportWarnings: false });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = raw.slice(raw.indexOf("/api/"));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (path === "/api/user-themes" && method === "GET") return Response.json(rows.map(({ id, name }) => ({ id, name })));
    if (path === "/api/user-themes" && method === "POST") {
      if (rejectUpload) return Response.json({ error: { message: "Expected :root" } }, { status: 400 });
      const body = JSON.parse(String(init?.body));
      const saved = { ...sample, name: body.name };
      rows = [saved]; return Response.json(saved, { status: 201 });
    }
    if (path === "/api/user-themes/sample" && method === "GET") return rows[0] ? Response.json(rows[0]) : Response.json({}, { status: 404 });
    if (path === "/api/user-themes/sample" && method === "DELETE") { rows = []; deletes++; return Response.json({ ok: true }); }
    throw new Error(`Unexpected theme-test request: ${method} ${path}`);
  }, { preconnect: () => {} });
});
afterEach(() => { cleanup(); restore(); });
afterAll(restore);

function Host() {
  useInterfaceTheme();
  return <TooltipProvider>
    <section aria-label="desktop"><TweaksPanelBody /></section>
    <section aria-label="phone"><MobileSettings open onClose={() => {}} /></section>
    <InterfaceSettingsSection />
  </TooltipProvider>;
}
function chooseFile(view: ReturnType<typeof render>, name = "tuned.css") {
  fireEvent.change(view.getByLabelText("user_theme_upload"), { target: { files: [new File([":root { --bg: #123; }"], name, { type: "text/css" })] } });
}

describe("user themes across settings surfaces", () => {
  test("empty catalog has no custom picker and only the full section owns management", async () => {
    const view = render(<Host />);
    await waitFor(() => expect(useUserThemesStore.getState().loaded).toBe(true));
    expect(view.queryByText("user_theme_choice")).toBeNull();
    const section = within(view.getByRole("region", { name: "settings_section_interface" }));
    expect(section.getByRole("button", { name: "user_theme_upload" })).toBeTruthy();
    for (const name of ["desktop", "phone"]) expect(within(view.getByRole("region", { name })).queryByRole("button", { name: "user_theme_upload" })).toBeNull();
  });

  test("upload applies and appears in all three real pickers; a built-in choice clears the custom selection", async () => {
    const view = render(<Host />);
    chooseFile(view);
    await waitFor(() => expect(root.classList.contains("user-sample")).toBe(true));
    expect(view.getAllByText("user_theme_choice")).toHaveLength(3);
    for (const name of ["desktop", "phone", "settings_section_interface"]) {
      const surface = within(view.getByRole("region", { name }));
      expect(surface.getByRole("button", { name: "tuned.css" })).toBeTruthy();
      expect(within(surface.getByRole("radiogroup", { name: "tweaks_theme" })).getAllByRole("radio").every((button) => button.getAttribute("aria-checked") === "false")).toBe(true);
    }
    const desktop = within(view.getByRole("region", { name: "desktop" }));
    fireEvent.click(within(desktop.getByRole("radiogroup", { name: "tweaks_theme" })).getAllByRole("radio")[2]!);
    expect(useInterfaceSettingsStore.getState().settings.theme).toBe("mystic-dawn");
    expect(view.getAllByRole("button", { name: "user_theme_none" })).toHaveLength(3);
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
  });

  test("selecting an existing upload through the shared dropdown updates every surface", async () => {
    rows = [sample];
    const view = render(<Host />);
    const desktop = within(view.getByRole("region", { name: "desktop" }));
    fireEvent.click(await desktop.findByRole("button", { name: "user_theme_none" }));
    fireEvent.click(await view.findByRole("option", { name: "tuned.css" }));
    await waitFor(() => expect(root.classList.contains("user-sample")).toBe(true));
    expect(view.getAllByRole("button", { name: "tuned.css" })).toHaveLength(3);
    const phone = within(view.getByRole("region", { name: "phone" }));
    fireEvent.click(phone.getByRole("button", { name: "tuned.css" }));
    fireEvent.click(await view.findByRole("option", { name: "user_theme_none" }));
    expect(useInterfaceSettingsStore.getState().settings.theme).toBe("coffee");
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
  });

  test("rejection renders a localized expected-format hint below upload without changing the theme", async () => {
    rejectUpload = true;
    const view = render(<Host />);
    chooseFile(view);
    expect((await view.findByRole("alert")).textContent).toBe("user_theme_upload_invalid");
    expect(useInterfaceSettingsStore.getState().settings.theme).toBe("coffee");
    expect(rows).toEqual([]);
  });

  test("deletion is confirmed; cancel preserves the file, confirm removes active CSS and returns to default", async () => {
    rows = [sample];
    useInterfaceSettingsStore.getState().setSetting("theme", "user:sample");
    const view = render(<Host />);
    await waitFor(() => expect(root.classList.contains("user-sample")).toBe(true));
    fireEvent.click(view.getByRole("button", { name: "user_theme_remove" }));
    fireEvent.click(view.getByRole("button", { name: "cancel" }));
    expect(deletes).toBe(0);
    expect(rows).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: "user_theme_remove" }));
    fireEvent.click(view.getByRole("button", { name: "delete" }));
    await waitFor(() => expect(useInterfaceSettingsStore.getState().settings.theme).toBe("coffee"));
    expect(deletes).toBe(1);
    expect(rows).toEqual([]);
    expect(document.querySelector("style[data-vt-user-theme]")).toBeNull();
    expect(view.queryByText("user_theme_choice")).toBeNull();
  });
});
