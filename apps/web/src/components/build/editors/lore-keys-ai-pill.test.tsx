/**
 * AI_PILL_MODEL_CROSS_PROVIDER_REPORT step 1 — the lore-keys pill never takes
 * a model from the persisted snapshot once it has its own settings: an empty
 * model is sent as absent (the provider's default), and a save refreshes the
 * bootstrap store so a remounted pill seeds from what was saved.
 *
 * AiQuickPill is stubbed here (the real settings modal + DropdownSelect path
 * is pinned in ChatImpersonateAiPill.provider-switch.test.tsx); this file pins
 * the pill's own generate/save wiring.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useForm, FormProvider } from "react-hook-form";
import { wireLoreEntry, wireUiSettings } from "../../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";
import type { AiAssistantRequestBody, UiSettingsRecord } from "../../../api/types.js";
import type { AiQuickSettings } from "../../shared/AiQuickPill.js";
import type { LoreEntryDraft } from "./use-lorebook-editor-state.js";

useDomEnv();

const { act, render, waitFor } = await import("@testing-library/react");

const calls = {
  requests: [] as AiAssistantRequestBody[],
  pill: null as { onGenerate: () => void; onSettingsChange?: (settings: AiQuickSettings) => void } | null,
};
let savedRecord: UiSettingsRecord = wireUiSettings();

const realAiApi = await import("../../../api/ai-assistant-api.js");
const realSettingsApi = await import("../../../api/settings-api.js");

mock.module("../../../api/ai-assistant-api.js", () => ({
  ...realAiApi,
  streamAiAssistant: mock(async function* (request: AiAssistantRequestBody) {
    calls.requests.push(request);
    yield { type: "text" as const, text: '{"keys":["dragon"],"secondaryKeys":[]}' };
    yield { type: "done" as const };
  }),
}));
mock.module("../../../api/settings-api.js", () => ({
  ...realSettingsApi,
  updateUiSettings: mock(async (patch: Partial<UiSettingsRecord>) => {
    savedRecord = { ...savedRecord, ...patch };
    return savedRecord;
  }),
}));
installI18nContextSeam();
mock.module("../../shared/AiQuickPill.js", () => ({
  AiQuickPill: (props: NonNullable<typeof calls.pill>) => {
    calls.pill = props;
    return null;
  },
}));

let LoreKeysAiPill: typeof import("./lore-keys-ai-pill.js").LoreKeysAiPill;
let useBootstrapStore: typeof import("../../../stores/api-actions/bootstrap-actions.js").useBootstrapStore;

beforeAll(async () => {
  ({ LoreKeysAiPill } = await import("./lore-keys-ai-pill.js"));
  ({ useBootstrapStore } = await import("../../../stores/api-actions/bootstrap-actions.js"));
});

beforeEach(() => {
  calls.requests = [];
  calls.pill = null;
  savedRecord = { ...wireUiSettings(), aiAssistantProviderId: "prov_a", aiAssistantModelName: "ma" };
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: savedRecord,
      agentKindSettings: {},
      isArmServer: false,
    },
  });
});

function Harness() {
  const { metadata: _metadata, ...entry } = wireLoreEntry();
  const form = useForm<LoreEntryDraft>({ defaultValues: { ...entry, content: "A dragon sleeps here." } });
  return (
    <FormProvider {...form}>
      <LoreKeysAiPill />
    </FormProvider>
  );
}

async function generate() {
  const before = calls.requests.length;
  await act(async () => { calls.pill?.onGenerate(); });
  await waitFor(() => expect(calls.requests.length).toBe(before + 1));
  return calls.requests[calls.requests.length - 1];
}

describe("LoreKeysAiPill — never pairs a provider with another provider's model", () => {
  test("a fresh pill seeds the persisted pair whole", async () => {
    render(<Harness />);
    await waitFor(() => expect(calls.pill).not.toBeNull());
    const request = await generate();
    expect(request.providerProfileId).toBe("prov_a");
    expect(request.model).toBe("ma");
  });

  test("after a provider switch with the default model, the request carries the new provider and no model", async () => {
    render(<Harness />);
    await waitFor(() => expect(calls.pill).not.toBeNull());
    await act(async () => {
      calls.pill?.onSettingsChange?.({ providerId: "prov_b", modelName: "", keyTarget: "both" });
    });
    const request = await generate();
    expect(request.providerProfileId).toBe("prov_b");
    expect(request.model).toBeUndefined();
  });

  test("saving the pair refreshes the bootstrap store", async () => {
    render(<Harness />);
    await waitFor(() => expect(calls.pill).not.toBeNull());
    await act(async () => {
      calls.pill?.onSettingsChange?.({ providerId: "prov_b", modelName: "mb", keyTarget: "both" });
    });
    await waitFor(() => {
      const saved = useBootstrapStore.getState().data?.uiSettings;
      expect(saved?.aiAssistantProviderId).toBe("prov_b");
      expect(saved?.aiAssistantModelName).toBe("mb");
    });
  });
});
