import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import type { ProviderProfileRecord } from "../../api/types.js";

useDomEnv();

const { fireEvent, render, waitFor } = await import("@testing-library/react");
const patchUiSettingsAction = mock(async (_patch: { coauthorLoreProviderId: string | null; coauthorLoreModelName: string | null }) => ({}));
const realBootstrapActions = await import("../../stores/api-actions/bootstrap-actions.js");
const realI18n = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({
  ...realBootstrapActions,
  patchUiSettingsAction,
}));
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => false,
}));

const { useProviderDataStore } = await import("../../stores/provider-data-store.js");
const { useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js");
let CoauthorLoreAssistantSettings: typeof import("./CoauthorLoreAssistantSettings.js").CoauthorLoreAssistantSettings;
beforeAll(async () => {
  ({ CoauthorLoreAssistantSettings } = await import("./CoauthorLoreAssistantSettings.js"));
});

const PROFILE = {
  id: "profile_1",
  name: "Lore provider",
  providerPreset: "openai",
  endpoint: "https://api.test/v1",
  defaultModel: null,
  isActive: false,
  cachedModels: { models: [{ id: "lore-model", label: "Lore model" }] },
} as unknown as ProviderProfileRecord;

function fieldTrigger(view: ReturnType<typeof render>, label: string) {
  const labelNode = view.getByText(label);
  const trigger = labelNode.parentElement?.querySelector("button");
  if (!trigger) throw new Error(`Missing ${label} selector`);
  return trigger;
}

describe("CoauthorLoreAssistantSettings", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    useBootstrapStore.setState({ data: null });
    useProviderDataStore.setState({ profiles: [PROFILE], favoritesByProfile: {} });
  });

  afterEach(() => {
    useBootstrapStore.setState({ data: null });
    useProviderDataStore.setState({ profiles: [], favoritesByProfile: {} });
  });

  it("saves nulls when returning to the co-author model and keeps the selectors visible but disabled", async () => {
    const view = render(<CoauthorLoreAssistantSettings />);
    fireEvent.click(view.getByRole("button", { name: "coauthor.lore_assistant.title" }));
    const toggle = view.getByRole("switch", { name: "coauthor.lore_assistant.same_as_coauthor" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(fieldTrigger(view, "coauthor.lore_assistant.provider").hasAttribute("disabled")).toBe(true);
    expect(fieldTrigger(view, "coauthor.lore_assistant.model").hasAttribute("disabled")).toBe(true);

    fireEvent.click(toggle);
    expect(fieldTrigger(view, "coauthor.lore_assistant.provider").hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(patchUiSettingsAction).toHaveBeenCalledWith({ coauthorLoreProviderId: null, coauthorLoreModelName: null }));
    expect(fieldTrigger(view, "coauthor.lore_assistant.provider")).toBeTruthy();
    expect(fieldTrigger(view, "coauthor.lore_assistant.model")).toBeTruthy();
  });

  it("saves a provider and model pair only after a model is chosen", async () => {
    const view = render(<CoauthorLoreAssistantSettings />);
    fireEvent.click(view.getByRole("button", { name: "coauthor.lore_assistant.title" }));
    fireEvent.click(view.getByRole("switch", { name: "coauthor.lore_assistant.same_as_coauthor" }));
    fireEvent.click(fieldTrigger(view, "coauthor.lore_assistant.provider"));
    fireEvent.click(await view.findByText("Lore provider"));
    expect(patchUiSettingsAction).not.toHaveBeenCalled();

    fireEvent.click(fieldTrigger(view, "coauthor.lore_assistant.model"));
    fireEvent.click(await view.findByText("Lore model"));
    await waitFor(() => expect(patchUiSettingsAction).toHaveBeenCalledWith({ coauthorLoreProviderId: "profile_1", coauthorLoreModelName: "lore-model" }));
  });

  it("keeps both selectors visible when saving the selected model fails", async () => {
    patchUiSettingsAction.mockRejectedValueOnce(new Error("save failed"));
    const view = render(<CoauthorLoreAssistantSettings />);
    fireEvent.click(view.getByRole("button", { name: "coauthor.lore_assistant.title" }));
    fireEvent.click(view.getByRole("switch", { name: "coauthor.lore_assistant.same_as_coauthor" }));
    fireEvent.click(fieldTrigger(view, "coauthor.lore_assistant.provider"));
    fireEvent.click(await view.findByText("Lore provider"));
    fireEvent.click(fieldTrigger(view, "coauthor.lore_assistant.model"));
    fireEvent.click(await view.findByText("Lore model"));
    await waitFor(() => expect(view.getByText("save failed")).toBeTruthy());
    expect(fieldTrigger(view, "coauthor.lore_assistant.provider")).toBeTruthy();
    expect(fieldTrigger(view, "coauthor.lore_assistant.model")).toBeTruthy();
  });
});
