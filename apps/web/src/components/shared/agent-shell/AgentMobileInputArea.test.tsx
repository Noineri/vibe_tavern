import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ToolbarSelectItem } from "../ToolbarSelect.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import type { FavoriteProviderModelRecord, ProviderProfileRecord } from "../../../api/types.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentMobileInputArea: typeof import("./AgentMobileInputArea.js").AgentMobileInputArea;

// ── SAFE mock.module stubs (capture real first, spread `...real`) ──

const realTooltip = await import("../Tooltip.js");
mock.module("../Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

interface FakeToolbarSelectProps {
  mobile?: boolean;
  trigger: ReactElement;
  triggerTooltip?: string;
  itemTestId?: (value: string) => string;
  title: ReactNode;
  items: ToolbarSelectItem[];
  value: string | null;
  onSelect: (value: string) => void;
  emptyText?: ReactNode;
  searchable?: boolean;
  contentWidth?: number;
}

// Radix Select.Content does not mount under happy-dom (no layout), so the real
// ToolbarSelect's dropdown cannot be driven. This stub renders the trigger plus
// one row per item (a div, like the desktop DropdownSelect stub — the real row
// is a Radix item, not a button, and the star toggle is itself a <button>),
// so the controlled onSelect wiring is exercised directly.
// Section labels and leading/trailing nodes render inline (the trailing node
// wrapped in a stopPropagation span — the primitive's documented contract:
// "Pointer events on it are stopped so tapping it does NOT select the item").
function FakeToolbarSelect(props: FakeToolbarSelectProps) {
  return (
    <div>
      {props.trigger}
      {props.items.map((item) => (
        <div key={item.value}>
          {item.sectionLabel != null && item.sectionLabel !== "" && (
            <div>{item.sectionLabel}</div>
          )}
          <div
            data-testid={props.itemTestId?.(item.value) ?? item.value}
            onClick={() => props.onSelect(item.value)}
          >
            {item.leading}
            {item.label}
            {item.trailing != null && (
              <span onClick={(e) => e.stopPropagation()}>{item.trailing}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const realToolbarSelect = await import("../ToolbarSelect.js");
mock.module("../ToolbarSelect.js", () => ({
  ...realToolbarSelect,
  ToolbarSelect: FakeToolbarSelect,
}));

// The favorites hook's mount effect fires the REAL RPC client (fetch with no
// server under happy-dom) — its rejection settles into the hook's local error
// state AFTER the test's synchronous flow, tripping one act() warning per
// test. Stub the two favorites actions at the module boundary (SAFE: real
// captured first, only the favorites fns overridden — same as the desktop
// input-area suite). The hook's data path (store read) stays real: tests seed
// the store directly. No test below asserts favorites UI.
const realProviderActions = await import("../../../stores/api-actions/provider-actions.js");
mock.module("../../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  loadFavoriteModelsAction: async () => {},
  // The pills' star toggles fire-and-forget through this action and converge
  // via the store — the fake applies that convergence synchronously so the
  // toggle boundary is pinnable without a server (add ↔ remove by `removing`).
  toggleFavoriteModelAction: async (
    profileId: string,
    modelId: string,
    label: string | null | undefined,
    contextLength: number | null | undefined,
    removing: boolean,
  ) => {
    const state = useProviderDataStore.getState();
    const current = state.copilotFavoritesByProfile[profileId] ?? [];
    const next: FavoriteProviderModelRecord[] = removing
      ? current.filter((f) => f.modelId !== modelId)
      : [...current, {
          id: `fav-${modelId}`,
          providerProfileId: profileId,
          modelId,
          label: label ?? modelId,
          contextLength: contextLength ?? null,
          scope: "copilot",
          createdAt: "",
        }];
    useProviderDataStore.setState({
      copilotFavoritesByProfile: { ...state.copilotFavoritesByProfile, [profileId]: next },
    });
  },
}));

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentMobileInputArea } = await import("./AgentMobileInputArea.js"));
});

// Two profiles; p1 carries one tool-capable cached model so the REAL
// useProviderModels hook serves the model list from cache (no fetch).
const PROFILES = [
  {
    id: "p1",
    name: "OpenAI Pro",
    cachedModels: { models: [{ id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } }] },
  },
  {
    id: "p2",
    name: "Anthropic",
    cachedModels: { models: [{ id: "m2", label: "Model Two", contextLength: 200000, capabilities: { tools: true } }] },
  },
] as unknown as ProviderProfileRecord[];

function seedStores() {
  useProviderDataStore.setState({ profiles: PROFILES, copilotFavoritesByProfile: {} });
}

beforeEach(() => {
  seedStores();
});

// Per-test isolated i18next instance (empty resources ⇒ t() returns the key
// verbatim, so every key-based assertion keeps passing). This silences
// react-i18next's NO_I18NEXT_INSTANCE warning from the @-mention popover
// WITHOUT touching the process-global i18n singleton: initI18n() has no reset
// and would poison sibling files sharing the worker (R13).
function makeIsolatedI18n() {
  const instance = createInstance();
  void instance.init({
    lng: "en",
    fallbackLng: "en",
    resources: {},
    ns: ["translation"],
    defaultNS: "translation",
    keySeparator: false,
    nsSeparator: false,
    interpolation: { prefix: "{", suffix: "}", escapeValue: false },
  });
  return instance;
}

function withIsolatedI18n(node: ReactNode) {
  return <I18nextProvider i18n={makeIsolatedI18n()}>{node}</I18nextProvider>;
}

function renderMobileInput(over: Partial<Parameters<typeof AgentMobileInputArea>[0]> = {}) {
  const props = {
    isSending: false,
    onSend: mock(),
    onCancel: mock(),
    providerProfileId: "p1",
    model: "m1",
    onProviderChange: mock(),
    ...over,
  };
  const utils = render(withIsolatedI18n(<AgentMobileInputArea {...props} />));
  return { ...utils, props };
}

describe("ExperienceCopilotMobileInputArea — pinned context (CX-6)", () => {
  const CATALOG = [
    { targetType: "character", id: "c1", label: "Alice", hint: "wanderer" },
    { targetType: "skill", id: "sk1", label: "Skill A" },
  ] as const;

  const chatInput = () =>
    document.querySelector('textarea[data-testid="copilot-chat-input"]') as HTMLTextAreaElement;

  /** Type into the real AutoTextarea and surface the caret through the
   *  `select` event the mention session recomputes on. */
  const typeInto = (text: string, caret = text.length) => {
    const ta = chatInput();
    fireEvent.change(ta, { target: { value: text } });
    ta.setSelectionRange(caret, caret);
    fireEvent.select(ta);
  };

  it("answeringAsk switches the placeholder to the answering key (AP-6)", () => {
    const { getByPlaceholderText, queryByPlaceholderText } = renderMobileInput({ answeringAsk: true });

    expect(getByPlaceholderText("agent_input_answering_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_placeholder")).toBeNull();
  });

  it("without answeringAsk the ordinary placeholder stays (AP-6)", () => {
    const { getByPlaceholderText, queryByPlaceholderText } = renderMobileInput({ answeringAsk: false });

    expect(getByPlaceholderText("agent_input_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_answering_placeholder")).toBeNull();
  });

  it("answeringAsk paints the card accent border, rest keeps the transparent border (AP-6)", () => {
    const { getByPlaceholderText, queryByPlaceholderText, rerender, props } = renderMobileInput({ answeringAsk: true });

    // The mobile card carries no border at rest — `border-transparent` holds
    // the footprint so the accent border toggles without a layout shift.
    const card = (getByPlaceholderText("agent_input_answering_placeholder") as HTMLTextAreaElement).closest("div.rounded-xl");
    expect(card?.className).toContain("border-accent");

    rerender(withIsolatedI18n(<AgentMobileInputArea {...props} answeringAsk={false} />));
    const idleCard = (getByPlaceholderText("agent_input_placeholder") as HTMLTextAreaElement).closest("div.rounded-xl");
    expect(idleCard?.className).toContain("border-transparent");
    expect(idleCard?.className).not.toContain("border-accent");
    expect(queryByPlaceholderText("agent_input_answering_placeholder")).toBeNull();
  });

  it("renders pinned pills and the × fires onUnpinContext", () => {
    const onUnpinContext = mock();
    const { getByTestId } = renderMobileInput({
      pinnedContext: [{ targetType: "character", targetId: "c1", label: "Alice" }],
      onUnpinContext,
    });

    const pill = getByTestId("copilot-context-pill-character-c1");
    expect(pill.textContent).toContain("Alice");
    fireEvent.click(getByTestId("copilot-context-pill-remove-character-c1"));
    expect(onUnpinContext).toHaveBeenCalledWith("character", "c1");
  });

  it("bare Enter does NOT send (E4: on-screen enter = newline key; send via button only)", () => {
    const { props } = renderMobileInput({});
    typeInto("hello there");
    fireEvent.keyDown(chatInput(), { key: "Enter" });
    fireEvent.keyDown(chatInput(), { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(chatInput().value).toBe("hello there");
  });

  it("typing @ + Enter picks → @query stripped from the draft + onPinContext", () => {
    const onPinContext = mock();
    renderMobileInput({ mentionCatalog: CATALOG, onPinContext });

    typeInto("pin @Al");

    const options = Array.from(document.body.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Alice");

    fireEvent.keyDown(chatInput(), { key: "Enter" });

    expect(chatInput().value).toBe("pin ");
    expect(onPinContext).toHaveBeenCalledTimes(1);
    expect(onPinContext).toHaveBeenCalledWith({ targetType: "character", id: "c1", label: "Alice", hint: "wanderer" });
  });
});

// ─── AP-19: Escape stops the streaming turn ──────────────────────────────────

describe("ExperienceCopilotMobileInputArea — Escape cancels the turn (AP-19)", () => {
  const CATALOG = [
    { targetType: "character", id: "c1", label: "Alice", hint: "wanderer" },
    { targetType: "skill", id: "sk1", label: "Skill A" },
  ] as const;

  const chatInput = () =>
    document.querySelector('textarea[data-testid="copilot-chat-input"]') as HTMLTextAreaElement;

  const typeInto = (text: string, caret = text.length) => {
    const ta = chatInput();
    fireEvent.change(ta, { target: { value: text } });
    ta.setSelectionRange(caret, caret);
    fireEvent.select(ta);
  };

  it("Escape while isSending cancels the turn — bare Enter stays the newline key (E4)", () => {
    const { props } = renderMobileInput({ isSending: true });

    typeInto("draft stays");
    fireEvent.keyDown(chatInput(), { key: "Enter" });
    fireEvent.keyDown(chatInput(), { key: "Escape" });

    expect(props.onSend).not.toHaveBeenCalled();
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape with the mention picker OPEN closes the picker and does NOT cancel (picker priority)", () => {
    const { props } = renderMobileInput({ isSending: true, mentionCatalog: CATALOG });

    typeInto("@");
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(2);

    fireEvent.keyDown(chatInput(), { key: "Escape" });

    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("Escape while NOT streaming does nothing new", () => {
    const { props } = renderMobileInput({ isSending: false });

    fireEvent.keyDown(chatInput(), { key: "Escape" });

    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });
});

// ─── AP-26b: phone pills characterization (pre-move) ─────────────────────────
// Pins TODAY's inline phone pills so the move into `AgentModelPills mobile`
// keeps them byte-identical: trigger labels, the favorites/all sections, the
// star-toggle contract, the select contract. These pass UNCHANGED after the
// move (same test ids through the same ToolbarSelect stub).

describe("ExperienceCopilotMobileInputArea — phone pills (AP-26b)", () => {
  const TWO_MODEL_PROFILES = [
    {
      id: "p1",
      name: "OpenAI Pro",
      cachedModels: { models: [
        { id: "m1", label: "Model One", contextLength: 128000, capabilities: { tools: true } },
        { id: "m2", label: "Model Two", contextLength: 64000, capabilities: { tools: true } },
      ] },
    },
    {
      id: "p2",
      name: "Anthropic",
      cachedModels: { models: [{ id: "m2", label: "Model Two", contextLength: 200000, capabilities: { tools: true } }] },
    },
  ] as unknown as ProviderProfileRecord[];

  function seedTwoModelsWithFavorite() {
    useProviderDataStore.setState({
      profiles: TWO_MODEL_PROFILES,
      copilotFavoritesByProfile: {
        p1: [{ id: "fav-m1", providerProfileId: "p1", modelId: "m1", label: "Model One", contextLength: 128000, scope: "copilot", createdAt: "" }],
      },
    });
  }

  it("pills render with the active profile name and the active model label", () => {
    const { getByTestId } = renderMobileInput({});

    expect(getByTestId("copilot-provider-pill").textContent).toContain("OpenAI Pro");
    expect(getByTestId("copilot-model-pill").textContent).toContain("Model One");
  });

  it("model sheet: favorites section with its label and leading stars, then all-models WITHOUT the favorited model", () => {
    seedTwoModelsWithFavorite();
    const { getByTestId, getByText, queryAllByTestId } = renderMobileInput({});

    // Favorites section carries its label; the favorited row renders exactly
    // once — the leading star (svg) sits before the label text, and the
    // trailing toggle offers the unstar (filled) action.
    expect(getByText("copilot_model_favorites_section")).toBeDefined();
    expect(queryAllByTestId("copilot-model-option-m1")).toHaveLength(1);
    const favRow = getByTestId("copilot-model-option-m1");
    expect(favRow.textContent).toContain("Model One");
    const favHtml = favRow.innerHTML;
    expect(favHtml.indexOf("<svg")).toBeGreaterThanOrEqual(0);
    expect(favHtml.indexOf("<svg")).toBeLessThan(favHtml.indexOf("Model One"));
    expect(getByTestId("copilot-model-star-m1")).toBeDefined();
    // All-models section carries its label and lists only the non-favorite.
    expect(getByText("copilot_model_all_section")).toBeDefined();
    expect(getByTestId("copilot-model-option-m2")).toBeDefined();
  });

  it("a star tap toggles the favorite and NEVER selects the row", () => {
    seedTwoModelsWithFavorite();
    const { getByTestId, queryAllByTestId, props } = renderMobileInput({});

    fireEvent.click(getByTestId("copilot-model-star-m2"));

    // The composer's binding is untouched...
    expect(props.onProviderChange).not.toHaveBeenCalled();
    // ...while the favorites converge through the store (m2 joins m1) and
    // the row moves to the favorites section (still rendered exactly once).
    const after = useProviderDataStore.getState().copilotFavoritesByProfile["p1"] ?? [];
    expect(after.map((f) => f.modelId).sort()).toEqual(["m1", "m2"]);
    expect(queryAllByTestId("copilot-model-option-m2")).toHaveLength(1);
  });

  it("picking a model calls onProviderChange with the profile id + model id", () => {
    seedTwoModelsWithFavorite();
    const { getByTestId, props } = renderMobileInput({});

    fireEvent.click(getByTestId("copilot-model-option-m2"));

    expect(props.onProviderChange).toHaveBeenCalledWith("p1", "m2");
  });
});
