import { beforeAll, describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { FormState } from "../../modals/ProviderModal.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

// LS-5: the panel reads/writes the sampler-set library through the RPC client.
// Mocked here at the api-module seam (apps/web runs one file per process, so
// the registration cannot leak; ...real keeps every other export intact). The
// in-memory library + call log are reset by the set-row describe's beforeEach.
const realSamplerSetApi = await import("../../../api/sampler-set-api.js");
type SetPayload = import("@vibe-tavern/api-contracts").SamplerSet["payload"];
let setLibrary: import("@vibe-tavern/api-contracts").SamplerSet[] = [];
let apiCalls: Array<{ fn: string; args: unknown[] }> = [];
mock.module("../../../api/sampler-set-api.js", () => ({
  ...realSamplerSetApi,
  listSamplerSets: async () => {
    apiCalls.push({ fn: "list", args: [] });
    return [...setLibrary];
  },
  createSamplerSet: async (input: { name: string; payload: SetPayload }) => {
    apiCalls.push({ fn: "create", args: [input] });
    const created: import("@vibe-tavern/api-contracts").SamplerSet = {
      id: "sset_new",
      name: input.name,
      sortOrder: setLibrary.length,
      payload: input.payload,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    setLibrary = [...setLibrary, created];
    return created;
  },
  updateSamplerSet: async (id: string, input: { name?: string; payload?: SetPayload }) => {
    apiCalls.push({ fn: "update", args: [id, input] });
    const existing = setLibrary.find((s) => s.id === id);
    if (!existing) throw new Error(`set ${id} not found`);
    const updated = { ...existing, ...input, updatedAt: "2026-09-09T00:00:01.000Z" };
    setLibrary = setLibrary.map((s) => (s.id === id ? updated : s));
    return updated;
  },
  deleteSamplerSet: async (id: string) => {
    apiCalls.push({ fn: "delete", args: [id] });
    setLibrary = setLibrary.filter((s) => s.id !== id);
  },
  importSamplerSet: async () => {
    throw new Error("importSamplerSet is not covered in these tests");
  },
}));

let ProviderSamplerPanel: typeof import("./ProviderSamplerPanel.js").ProviderSamplerPanel;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ProviderSamplerPanel } = await import("./ProviderSamplerPanel.js"));
});

function form(): FormState {
  return {
    id: "provider-1",
    name: "Provider",
    providerPreset: "openaiCompat",
    baseUrl: "https://example.test/v1",
    apiKey: "",
    hasStoredApiKey: false,
    model: "model-a",
    visionModel: "",
    temperature: 0.7,
    topP: 1,
    minP: 0,
    topK: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    adaptiveTarget: -1,
    adaptiveDecay: 0.9,
    dynatempRange: 0,
    dynatempExponent: 1,
    topNSigma: 0,
    smoothingFactor: 0,
    repeatLastN: -1,
    dryPenaltyLastN: -1,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    bannedStrings: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    maxTokens: 4096,
    contextBudget: 8192,
    pinContextBudget: false,
    tokenPadding: 0,
    generationMode: "chat",
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    editingModelId: null,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "medium",
    showReasoning: true,
    streamResponse: true,
    customSamplers: true,
    proxyMode: "inherit",
    proxyId: null,
    samplerSetId: null,
    generationFormat: null,
  };
}

describe("ProviderSamplerPanel advanced disclosure", () => {
  it("opens the real advanced sampler body from its collapsed header", () => {
    const { getByText, queryByText } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} />,
    );
    expect(queryByText("sampler_top_p")).toBeNull();

    fireEvent.click(getByText("samplers_advanced"));

    expect(getByText("sampler_top_p")).toBeTruthy();
  });

  it("shows adaptive-p fields only for providers whose sampler set includes them (llamacpp_native / koboldcpp_native)", async () => {
    const { resolveSamplerCapabilities } = await import("@vibe-tavern/domain");
    const llamaCaps = resolveSamplerCapabilities(null, "llamacpp");
    const { getByText, queryByText, unmount } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} capabilities={{ samplers: llamaCaps }} />,
    );
    fireEvent.click(getByText("samplers_advanced"));
    expect(getByText("sampler_adaptive_target")).toBeTruthy();
    expect(getByText("sampler_adaptive_decay")).toBeTruthy();
    // B2 llama-server numeric tail
    expect(getByText("sampler_dynatemp_range")).toBeTruthy();
    expect(getByText("sampler_dynatemp_exponent")).toBeTruthy();
    expect(getByText("sampler_top_n_sigma")).toBeTruthy();
    expect(getByText("sampler_smoothing_factor")).toBeTruthy();
    expect(getByText("sampler_dry_penalty_last_n")).toBeTruthy();
    unmount();

    const openaiCaps = resolveSamplerCapabilities("openai", "openai_compat");
    const { getByText: get2, queryByText: query2 } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} capabilities={{ samplers: openaiCaps }} />,
    );
    fireEvent.click(get2("samplers_advanced"));
    expect(query2("sampler_adaptive_target")).toBeNull();
    expect(query2("sampler_adaptive_decay")).toBeNull();
    expect(query2("sampler_dynatemp_range")).toBeNull();
    expect(query2("sampler_top_n_sigma")).toBeNull();
    expect(query2("sampler_smoothing_factor")).toBeNull();
    expect(query2("sampler_dry_penalty_last_n")).toBeNull();
  });

  it("shows bannedStrings (antislop) only where koboldcpp_native applies (B3)", async () => {
    const { resolveSamplerCapabilities } = await import("@vibe-tavern/domain");
    const koboldCaps = resolveSamplerCapabilities("koboldcpp", "koboldcpp");
    const { getByText, queryByText, unmount } = render(
      <ProviderSamplerPanel form={form()} updateForm={mock()} capabilities={{ samplers: koboldCaps }} />,
    );
    fireEvent.click(getByText("samplers_advanced"));
    expect(getByText("sampler_banned_strings")).toBeTruthy();
    unmount();

    // Not in the llama-server surface and not in the shared openai_local set
    for (const caps of [
      resolveSamplerCapabilities(null, "llamacpp"),
      resolveSamplerCapabilities("openai", "openai_compat"),
      resolveSamplerCapabilities("vllm", "openai_compat"),
    ]) {
      const { getByText: get, queryByText: query, unmount: un } = render(
        <ProviderSamplerPanel form={form()} updateForm={mock()} capabilities={{ samplers: caps }} />,
      );
      fireEvent.click(get("samplers_advanced"));
      expect(query("sampler_banned_strings")).toBeNull();
      un();
    }
  });
});

// ── Named sampler-set row (LOCAL_SUPPORT_PLAN LS-5d/e/f) ──────────────────────
// Pins the owner-confirmed UI semantics as the panel actually implements them:
// icon-only 7-button row (tooltips via aria-label), diskette/rename/revert/
// trash/export disabled without a selection, apply = capability-filtered
// copy-on-select, dirty dot cleared by 💾 and by re-apply (🔄 / re-select),
// morph input + ✓/✕ (Enter = save) with the inline collision warning, and the
// destructive-confirm delete that clears the profile's pointer.

const { waitFor } = await import("@testing-library/react");
type PanelView = Awaited<ReturnType<typeof render>>;

function setForm(over: Partial<FormState> = {}): FormState {
  return { ...form(), customSamplers: true, ...over };
}

function makeHarness(initial: FormState) {
  const current: FormState = { ...initial };
  const calls: Array<{ k: keyof FormState; v: unknown }> = [];
  const updateForm = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    calls.push({ k, v: v as unknown });
    (current as unknown as Record<string, unknown>)[k as string] = v;
  };
  return { current, calls, updateForm };
}

const DIVINE_PAYLOAD = { temperature: 1.31, topP: 0.14, topK: 49 };
const BIG_O_PAYLOAD = { tfsZ: 0.68, dryMultiplier: 0.8 };

function seedLibrary() {
  setLibrary = [
    { id: "sset_1", name: "Divine Intellect", sortOrder: 0, payload: { ...DIVINE_PAYLOAD }, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" },
    { id: "sset_2", name: "Big O", sortOrder: 1, payload: { ...BIG_O_PAYLOAD }, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z" },
  ];
  apiCalls = [];
}

const SET_TESTIDS = [
  "sampler-set-new", "sampler-set-save", "sampler-set-rename", "sampler-set-revert",
  "sampler-set-delete", "sampler-set-import", "sampler-set-export",
] as const;

/** The destructive confirm's primary button lives in the body portal (Modal). */
function confirmModalButtons(): { confirm: HTMLElement | null; open: boolean } {
  const confirm = [...document.body.querySelectorAll("button")].find(
    (b) => (b.className ?? "").includes("bg-danger"),
  );
  return { confirm: confirm ?? null, open: Boolean(confirm) };
}

describe("ProviderSamplerPanel sampler-set row (LS-5)", () => {
  let view: PanelView;

  function panelElement(h: ReturnType<typeof makeHarness>, capabilities?: Record<string, unknown>) {
    return (
      <ProviderSamplerPanel
        form={{ ...h.current }}
        updateForm={h.updateForm as never}
        capabilities={capabilities as never}
      />
    );
  }

  function mountPanel(h: ReturnType<typeof makeHarness>, capabilities?: Record<string, unknown>): void {
    view = render(panelElement(h, capabilities));
  }

  /** Push the harness's current form back as the panel prop (the modal's own
   *  re-render in the real app; the panel's dirty dot reads the PROP). */
  function syncForm(h: ReturnType<typeof makeHarness>, capabilities?: Record<string, unknown>): void {
    view.rerender(panelElement(h, capabilities));
  }

  async function pickSet(label: string): Promise<void> {
    fireEvent.click(view.getByTestId("sampler-set-trigger"));
    await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
    const item = [...view.baseElement.querySelectorAll("[cmdk-item]")].find(
      (i) => (i.textContent ?? "").trim() === label,
    );
    if (!item) throw new Error(`no cmdk item "${label}"`);
    fireEvent.click(item);
    await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
  }

  beforeEach(() => {
    seedLibrary();
  });

  afterEach(() => {
    view?.unmount();
  });

  it("renders the icon-only 7-button row; target actions disabled without a selection", () => {
    const h = makeHarness(setForm());
    mountPanel(h);

    for (const testid of SET_TESTIDS) {
      expect(view.getByTestId(testid)).toBeTruthy();
    }
    // No target = no action (diskette / pencil / refresh / trash / download).
    for (const testid of ["sampler-set-save", "sampler-set-rename", "sampler-set-revert", "sampler-set-delete", "sampler-set-export"]) {
      expect((view.getByTestId(testid) as HTMLButtonElement).disabled).toBe(true);
    }
    // «+» and upload always work.
    for (const testid of ["sampler-set-new", "sampler-set-import"]) {
      expect((view.getByTestId(testid) as HTMLButtonElement).disabled).toBe(false);
    }
    // No dot without an applied set.
    expect(view.queryByTestId("sampler-set-dirty-dot")).toBeNull();
  });

  it("apply is copy-on-select with per-protocol filtering (unsupported values never enter the form)", async () => {
    const { resolveSamplerCapabilities } = await import("@vibe-tavern/domain");
    const llamaCaps = { ...resolveSamplerCapabilities(null, "llamacpp"), dryMultiplier: false };
    const h = makeHarness(setForm());
    mountPanel(h, { samplers: llamaCaps });
    await waitFor(() =>
      expect((view.getByTestId("sampler-set-trigger") as HTMLElement).textContent).toContain("sampler_set_placeholder"),
    );

    await pickSet("Big O");

    const keys = new Set(h.calls.map((c) => c.k));
    // tfsZ IS supported by the llama surface → applied.
    expect(h.calls.find((c) => c.k === "tfsZ")).toEqual({ k: "tfsZ", v: 0.68 });
    // dryMultiplier is capability-filtered OFF (LS-5f) → never enters the form.
    expect(keys.has("dryMultiplier")).toBe(false);
    // The pointer rides the apply.
    expect(h.calls.find((c) => c.k === "samplerSetId")).toEqual({ k: "samplerSetId", v: "sset_2" });
    // Applying is a pure copy — no library writes fired.
    expect(apiCalls.filter((c) => c.fn !== "list")).toEqual([]);
  });

  it("dirty dot: appears when values diverge from the applied set, cleared by 💾", async () => {
    const h = makeHarness(setForm({ ...DIVINE_PAYLOAD, samplerSetId: "sset_1" }));
    mountPanel(h);
    // Values match the applied set (previous-session pre-selection backfills
    // the baseline without re-applying) → clean.
    await waitFor(() =>
      expect((view.getByTestId("sampler-set-trigger") as HTMLElement).textContent).toContain("Divine Intellect"),
    );
    await waitFor(() => expect(view.queryByTestId("sampler-set-dirty-dot")).toBeNull());

    // The user nudges a knob → the dot lights.
    h.current.temperature = 0.5;
    syncForm(h);
    await waitFor(() => expect(view.queryByTestId("sampler-set-dirty-dot")).toBeTruthy());

    // 💾 saves the CURRENT extract into the set → the dot clears.
    fireEvent.click(view.getByTestId("sampler-set-save"));
    await waitFor(() => expect(view.queryByTestId("sampler-set-dirty-dot")).toBeNull());
    const save = apiCalls.find((c) => c.fn === "update");
    expect(save?.args[0]).toBe("sset_1");
    expect((save?.args[1] as { payload: Record<string, unknown> }).payload.temperature).toBe(0.5);
  });

  it("dirty dot clears on re-apply (🔄) — the set re-copies its stored values", async () => {
    const h = makeHarness(setForm({ ...DIVINE_PAYLOAD, samplerSetId: "sset_1" }));
    mountPanel(h);
    await waitFor(() => expect(view.queryByTestId("sampler-set-dirty-dot")).toBeNull());

    h.current.temperature = 0.5;
    syncForm(h);
    await waitFor(() => expect(view.queryByTestId("sampler-set-dirty-dot")).toBeTruthy());

    fireEvent.click(view.getByTestId("sampler-set-revert"));
    // The harness form now carries the re-applied values (copy-on-select).
    syncForm(h);
    await waitFor(() => expect(view.queryByTestId("sampler-set-dirty-dot")).toBeNull());
    // The revert re-applied the SET's value, not the user's tweak.
    expect(h.calls.find((c) => c.k === "temperature")).toEqual({ k: "temperature", v: 1.31 });
  });

  it("«+» morph: creates a set under the typed name from the current values", async () => {
    const h = makeHarness(setForm({ ...DIVINE_PAYLOAD }));
    mountPanel(h);
    await waitFor(() =>
      expect((view.getByTestId("sampler-set-trigger") as HTMLElement).textContent).toContain("sampler_set_placeholder"),
    );

    fireEvent.click(view.getByTestId("sampler-set-new"));
    const input = view.getByTestId("sampler-set-name-input") as HTMLInputElement;
    // React applies autoFocus as a behavior, not a DOM attribute — the input
    // lands focused.
    expect(document.activeElement === input).toBe(true);
    fireEvent.change(input, { target: { value: "My Set" } });
    fireEvent.click(view.getByTestId("sampler-set-morph-confirm"));

    await waitFor(() => expect(view.queryByTestId("sampler-set-name-input")).toBeNull());
    const create = apiCalls.find((c) => c.fn === "create");
    expect(create?.args[0]).toEqual({ name: "My Set", payload: expect.objectContaining(DIVINE_PAYLOAD) });
    // The created set becomes the selected one.
    expect(h.calls.find((c) => c.k === "samplerSetId")).toEqual({ k: "samplerSetId", v: "sset_new" });
  });

  it("morph: a duplicate name shows the inline collision warning and blocks ✓; editing the name clears it", async () => {
    const h = makeHarness(setForm());
    mountPanel(h);
    await waitFor(() =>
      expect((view.getByTestId("sampler-set-trigger") as HTMLElement).textContent).toContain("sampler_set_placeholder"),
    );

    fireEvent.click(view.getByTestId("sampler-set-new"));
    const input = view.getByTestId("sampler-set-name-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Big O" } });

    // Collision line under the input (client-side, case-insensitive).
    expect(view.getByText("sampler_set_name_exists")).toBeTruthy();
    expect((view.getByTestId("sampler-set-morph-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(apiCalls.filter((c) => c.fn === "create")).toEqual([]);

    fireEvent.change(input, { target: { value: "Big O II" } });
    expect(view.queryByText("sampler_set_name_exists")).toBeNull();
    expect((view.getByTestId("sampler-set-morph-confirm") as HTMLButtonElement).disabled).toBe(false);
  });

  it("rename morph prefills the selected set's name; Enter confirms the rename", async () => {
    const h = makeHarness(setForm({ ...DIVINE_PAYLOAD, samplerSetId: "sset_1" }));
    mountPanel(h);
    await waitFor(() =>
      expect((view.getByTestId("sampler-set-trigger") as HTMLElement).textContent).toContain("Divine Intellect"),
    );

    fireEvent.click(view.getByTestId("sampler-set-rename"));
    const input = view.getByTestId("sampler-set-name-input") as HTMLInputElement;
    expect(input.value).toBe("Divine Intellect");
    fireEvent.change(input, { target: { value: "Divine Intellect II" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(view.queryByTestId("sampler-set-name-input")).toBeNull());
    const update = apiCalls.find((c) => c.fn === "update");
    expect(update?.args[0]).toBe("sset_1");
    expect(update?.args[1]).toEqual({ name: "Divine Intellect II" });
  });

  it("delete: destructive confirm gates the delete; confirming clears the profile pointer", async () => {
    const h = makeHarness(setForm({ ...DIVINE_PAYLOAD, samplerSetId: "sset_1" }));
    mountPanel(h);
    await waitFor(() =>
      expect((view.getByTestId("sampler-set-trigger") as HTMLElement).textContent).toContain("Divine Intellect"),
    );

    fireEvent.click(view.getByTestId("sampler-set-delete"));
    await waitFor(() => expect(confirmModalButtons().open).toBe(true));
    // Cancel keeps the set.
    const cancelBtn = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "cancel",
    );
    fireEvent.click(cancelBtn!);
    await waitFor(() => expect(confirmModalButtons().open).toBe(false));
    expect(apiCalls.filter((c) => c.fn === "delete")).toEqual([]);

    // Confirm deletes the set and clears ONLY the pointer (copy-on-select:
    // the applied values stay on the profile).
    fireEvent.click(view.getByTestId("sampler-set-delete"));
    await waitFor(() => expect(confirmModalButtons().open).toBe(true));
    fireEvent.click(confirmModalButtons().confirm!);
    await waitFor(() => expect(apiCalls.some((c) => c.fn === "delete" && c.args[0] === "sset_1")).toBe(true));
    expect(h.calls.find((c) => c.k === "samplerSetId")).toEqual({ k: "samplerSetId", v: null });
  });
});

// W1 (MOBILE_UI_DEFECTS_REPORT step 2): on phones the accordion header's set
// row columnates — title row, then the preset selector row, then the
// icon-action row — so the preset-management buttons are never clipped by
// horizontal row pressure. Desktop keeps the original single horizontal row
// (title | selector + icon actions; the md: prefixed classes restore it).
describe("ProviderSamplerPanel accordion header (mobile two-row layout, W1)", () => {
  it("max-md: columnates the set row (selector / icon-action rows); md: restores the single horizontal row", () => {
    const view = render(<ProviderSamplerPanel form={setForm()} updateForm={mock()} />);
    const header = view.getByTestId("sampler-accordion-header");
    // Mobile: the header stacks (title row → set row) and children stretch.
    // Mobile-first: flex-col is the base direction, md:flex-row restores the
    // single desktop row.
    expect(header.className).toContain("flex-col");
    expect(header.className).toContain("max-md:items-stretch");
    expect(header.className).toContain("max-md:gap-2");
    // Desktop: the original single horizontal row.
    expect(header.className).toContain("md:flex-row");
    expect(header.className).toContain("md:items-center");
    expect(header.className).toContain("md:justify-between");
    // The set row (cluster) is the header's second child and columnates too:
    // row 1 = preset selector wrap, row 2 = the icon-action row.
    const cluster = view.getByTestId("sampler-set-trigger").parentElement!.parentElement!;
    expect(cluster).toBe(header.lastElementChild as HTMLElement);
    expect(cluster.className).toContain("max-md:flex-col");
    expect(cluster.className).toContain("max-md:items-stretch");
    expect(cluster.className).toContain("md:flex-row");
    expect(cluster.className).toContain("md:items-center");
    // Icon actions live in their own row — a sibling of the selector wrap
    // inside the cluster, wrap-capable for narrow widths (7×28px + toggle ≈ 264px).
    const iconRow = view.getByTestId("sampler-set-new").parentElement!;
    expect(iconRow).toBe(cluster.lastElementChild as HTMLElement);
    expect(iconRow.className).toContain("flex-wrap");
    expect(iconRow.querySelectorAll("button")).toHaveLength(7);
    view.unmount();
  });
});
