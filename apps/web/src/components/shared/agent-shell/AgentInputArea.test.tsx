import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ToolbarSelectItem } from "../ToolbarSelect.js";
import { useProviderDataStore } from "../../../stores/provider-data-store.js";
import type { ProviderProfileRecord } from "../../../api/types.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let AgentInputArea: typeof import("./AgentInputArea.js").AgentInputArea;

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
  contentWidth?: number;
}

// Radix Select.Content does not mount under happy-dom (no layout), so the real
// ToolbarSelect's dropdown cannot be driven. This stub renders the trigger plus
// one button per item, so the controlled onSelect wiring is exercised directly.
function FakeToolbarSelect(props: FakeToolbarSelectProps) {
  return (
    <div>
      {props.trigger}
      {props.items.map((item) => (
        <button
          key={item.value}
          type="button"
          data-testid={props.itemTestId?.(item.value) ?? item.value}
          onClick={() => props.onSelect(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const realToolbarSelect = await import("../ToolbarSelect.js");
mock.module("../ToolbarSelect.js", () => ({
  ...realToolbarSelect,
  ToolbarSelect: FakeToolbarSelect,
}));

// Radix Popover.Content (DropdownSelect's substrate) does not mount under
// happy-dom either (0x0 layout — see DropdownSelect.test.tsx header), so the
// model picker gets the same treatment: a stub that renders the trigger plus
// one button per option across groups, so the controlled onChange wiring and
// the favorites-section construction are exercised directly.
interface FakeDropdownSelectProps {
  value: string;
  options: Array<{ id: string; label: string }>;
  groups?: Array<{ id: string; label?: string; options: Array<{ id: string; label: string; trailing?: ReactNode }> }>;
  placeholder?: string;
  triggerTestId?: string;
  triggerClassName?: string;
  contentWidth?: number;
  triggerLeading?: ReactNode;
  onChange: (value: string) => void;
}

function FakeDropdownSelect(props: FakeDropdownSelectProps) {
  return (
    <div>
      <button type="button" data-testid={props.triggerTestId} className={props.triggerClassName} onClick={() => {}}>
        {props.triggerLeading}
        {props.options.find((o) => o.id === props.value)?.label ?? props.placeholder}
      </button>
      {(props.groups ?? []).map((g) => (
        <div key={g.id} data-testid={`dropdown-group-${g.id}`} data-content-width={props.contentWidth ?? "trigger"}>
          {g.label && <div data-testid={`dropdown-group-label-${g.id}`}>{g.label}</div>}
          {g.options.map((o) => (
            <div key={o.id} data-testid={`dropdown-option-${o.id}`} onClick={() => props.onChange(o.id)}>
              {o.label}
              {o.trailing}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const realDropdownSelect = await import("../DropdownSelect.js");
mock.module("../DropdownSelect.js", () => ({
  ...realDropdownSelect,
  DropdownSelect: FakeDropdownSelect,
}));

// Favorites actions hit the RPC client — stub them at the module boundary
// (SAFE: real captured first, only the two favorites fns overridden). The
// hook's data path (store read) stays real: tests seed the store directly.
const realProviderActions = await import("../../../stores/api-actions/provider-actions.js");
mock.module("../../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  loadFavoriteModelsAction: async () => {},
  toggleFavoriteModelAction: async () => {},
}));

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ AgentInputArea } = await import("./AgentInputArea.js"));
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

function renderInput(over: Partial<Parameters<typeof AgentInputArea>[0]> = {}) {
  const props = {
    isSending: false,
    onSend: mock(),
    onCancel: mock(),
    providerProfileId: "p1",
    model: "m1",
    onProviderChange: mock(),
    ...over,
  };
  const utils = render(withIsolatedI18n(<AgentInputArea {...props} />));
  return { ...utils, props };
}

describe("ExperienceCopilotInputArea", () => {
  it("disables send while empty and enables it once text is typed", () => {
    const { getByTestId, getByPlaceholderText } = renderInput();

    const sendBtn = getByTestId("copilot-send-btn") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);

    fireEvent.change(getByPlaceholderText("agent_input_placeholder"), { target: { value: "propose a twist" } });

    expect((getByTestId("copilot-send-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the trimmed text and clears the draft", () => {
    const { getByTestId, getByPlaceholderText, props } = renderInput();

    fireEvent.change(getByPlaceholderText("agent_input_placeholder"), { target: { value: "  make it darker  " } });
    fireEvent.click(getByTestId("copilot-send-btn"));

    expect(props.onSend).toHaveBeenCalledWith("make it darker");
    expect((getByPlaceholderText("agent_input_placeholder") as HTMLTextAreaElement).value).toBe("");
  });

  it("replaces send with cancel while isSending, and cancel calls onCancel", () => {
    const { queryByTestId, getByTestId, props } = renderInput({ isSending: true });

    expect(queryByTestId("copilot-send-btn")).toBeNull();
    const cancelBtn = getByTestId("copilot-cancel-btn");
    // UX 2026-08-16 remark 2: the cancel button takes the compact icon-square
    // pattern from the mobile input area / the send button — h-8 w-8, icon-only,
    // label only via aria-label + tooltip (NOT a text button).
    expect(cancelBtn.className).toContain("h-8 w-8");
    expect(cancelBtn.textContent).toBe("");
    fireEvent.click(cancelBtn);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("changing the provider calls onProviderChange with the new profile id", () => {
    const { getByTestId, props } = renderInput();

    fireEvent.click(getByTestId("copilot-provider-option-p2"));

    expect(props.onProviderChange).toHaveBeenCalledWith("p2");
  });

  it("changing the model calls onProviderChange with the profile id + model id", () => {
    const { getByTestId, props } = renderInput();

    fireEvent.click(getByTestId("dropdown-option-m1"));

    expect(props.onProviderChange).toHaveBeenCalledWith("p1", "m1");
  });

  it("renders the profile's copilot favorites as a pinned top section", () => {
    useProviderDataStore.setState({
      copilotFavoritesByProfile: {
        p1: [
          { id: "fav1", providerProfileId: "p1", modelId: "m9", label: "Favored Nine", contextLength: 64000, scope: "copilot", createdAt: "" },
        ],
      },
    });
    const { getByTestId } = renderInput();

    // Favorites section renders above the all-models section, with the stored
    // label and an UNSTAR (filled) star trailing on the row.
    expect(getByTestId("dropdown-group-copilot-model-favorites")).toBeDefined();
    expect(getByTestId("dropdown-option-m9").textContent).toContain("Favored Nine");
    expect(getByTestId("copilot-model-star-m9")).toBeDefined();
    // All-models section still carries every live model with an UNFILLED star.
    expect(getByTestId("dropdown-option-m1")).toBeDefined();
    expect(getByTestId("copilot-model-star-m1")).toBeDefined();
  });

  it("without favorites there is no favorites group and no all-section header", () => {
    const { queryByTestId, getByTestId } = renderInput();

    expect(queryByTestId("dropdown-group-copilot-model-favorites")).toBeNull();
    expect(getByTestId("dropdown-group-copilot-model-all")).toBeDefined();
  });

  it("model picker: narrow fixed trigger width, popup decoupled via contentWidth", () => {
    const { getByTestId } = renderInput();

    // UX contract (2026-08-16 remark 3): the CLOSED trigger stays clamped for
    // layout stability (w-[240px], set in bae87b16), while the OPEN dropdown
    // gets its own fixed width (contentWidth) instead of following the
    // trigger — long model ids + trailing star + context length need room.
    expect(getByTestId("copilot-model-pill").className).toContain("w-[240px]");
    expect(getByTestId("dropdown-group-copilot-model-all").getAttribute("data-content-width")).toBe("320");
  });

  it("answeringAsk switches the placeholder to the answering key (AP-6)", () => {
    const { getByPlaceholderText, queryByPlaceholderText } = renderInput({ answeringAsk: true });

    expect(getByPlaceholderText("agent_input_answering_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_placeholder")).toBeNull();
  });

  it("without answeringAsk the ordinary placeholder stays (AP-6)", () => {
    const { getByPlaceholderText, queryByPlaceholderText } = renderInput({ answeringAsk: false });

    expect(getByPlaceholderText("agent_input_placeholder")).toBeDefined();
    expect(queryByPlaceholderText("agent_input_answering_placeholder")).toBeNull();
  });

  it("answeringAsk paints the card accent border, rest keeps border-border (AP-6)", () => {
    const { getByPlaceholderText, queryByPlaceholderText, rerender, props } = renderInput({ answeringAsk: true });

    const card = (getByPlaceholderText("agent_input_answering_placeholder") as HTMLTextAreaElement).closest("div.rounded-lg");
    expect(card?.className).toContain("border-accent");

    rerender(withIsolatedI18n(<AgentInputArea {...props} answeringAsk={false} />));
    const idleCard = (getByPlaceholderText("agent_input_placeholder") as HTMLTextAreaElement).closest("div.rounded-lg");
    expect(idleCard?.className).toContain("border-border");
    expect(idleCard?.className).not.toContain("border-accent");
    expect(queryByPlaceholderText("agent_input_answering_placeholder")).toBeNull();
  });

  it("prefill replaces the current draft (UX 2026-08-16 remark 6)", () => {
    const { getByPlaceholderText, props, rerender } = renderInput();
    const textarea = getByPlaceholderText("agent_input_placeholder") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "hand-typed draft" } });
    expect(textarea.value).toBe("hand-typed draft");

    // A prefill object arriving (fresh identity per copy click in the Shell)
    // replaces the draft — the user reviews/edits, then sends manually.
    rerender(withIsolatedI18n(<AgentInputArea {...props} prefill={{ text: "digest from tester" }} />));
    expect(textarea.value).toBe("digest from tester");
  });
});

// ─── CX-6: pinned-context pills + @-mention popover ─────────────────────────

describe("ExperienceCopilotInputArea — pinned context (CX-6)", () => {
  const CATALOG = [
    { targetType: "character", id: "c1", label: "Alice", hint: "wanderer" },
    { targetType: "skill", id: "sk1", label: "Skill A" },
  ] as const;

  const chatInput = () =>
    document.querySelector('textarea[data-testid="copilot-chat-input"]') as HTMLTextAreaElement;

  /** Type into the real AutoTextarea and surface the caret through the
   *  `select` event the mention session recomputes on (mirrors the
   *  auto-textarea test helper). */
  const typeInto = (text: string, caret = text.length) => {
    const ta = chatInput();
    fireEvent.change(ta, { target: { value: text } });
    ta.setSelectionRange(caret, caret);
    fireEvent.select(ta);
  };

  it("renders pinned pills and the × fires onUnpinContext", () => {
    const onUnpinContext = mock();
    const { getByTestId } = renderInput({
      pinnedContext: [{ targetType: "character", targetId: "c1", label: "Alice" }],
      onUnpinContext,
    });

    const pill = getByTestId("copilot-context-pill-character-c1");
    expect(pill.textContent).toContain("Alice");
    fireEvent.click(getByTestId("copilot-context-pill-remove-character-c1"));
    expect(onUnpinContext).toHaveBeenCalledWith("character", "c1");
  });

  it("no pinned pills when pinnedContext is empty or absent", () => {
    const { queryByTestId } = renderInput();
    expect(queryByTestId("copilot-context-pill-character-c1")).toBeNull();
  });

  it("typing @ opens the popover over the catalog; Enter picks → @query stripped + onPinContext", () => {
    const onPinContext = mock();
    renderInput({ mentionCatalog: CATALOG, onPinContext });

    typeInto("pin @Al");

    // Exactly one filtered row (Alice), the Skill row filtered out.
    const options = Array.from(document.body.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Alice");

    fireEvent.keyDown(chatInput(), { key: "Enter" });

    // The @Al gesture is stripped from the draft; the full item is pinned.
    expect(chatInput().value).toBe("pin ");
    expect(onPinContext).toHaveBeenCalledTimes(1);
    expect(onPinContext).toHaveBeenCalledWith({ targetType: "character", id: "c1", label: "Alice", hint: "wanderer" });
  });

  it("keyboard contract: ArrowDown cycles the active row, Escape closes", () => {
    renderInput({ mentionCatalog: CATALOG, onPinContext: mock() });

    typeInto("@");
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(2);
    const opts = () => Array.from(document.body.querySelectorAll('[role="option"]'));
    expect(opts()[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(chatInput(), { key: "ArrowDown" });
    expect(opts()[1].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(chatInput(), { key: "Escape" });
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it("regression: plain Enter with no mention session still sends", () => {
    const onSend = mock();
    renderInput({ onSend });

    typeInto("hello");
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
    fireEvent.keyDown(chatInput(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });
});

// ─── AP-19: Escape stops the streaming turn ──────────────────────────────────

describe("ExperienceCopilotInputArea — Escape cancels the turn (AP-19)", () => {
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

  it("Escape while isSending cancels the turn (quiet abort, no draft change)", () => {
    const { props } = renderInput({ isSending: true });

    fireEvent.keyDown(chatInput(), { key: "Escape" });

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape with the mention picker OPEN closes the picker and does NOT cancel (picker priority)", () => {
    const { props } = renderInput({ isSending: true, mentionCatalog: CATALOG });

    typeInto("@");
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(2);

    fireEvent.keyDown(chatInput(), { key: "Escape" });

    // The picker's own Escape wins: the popover closes, the stream keeps going.
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("Escape while NOT streaming does nothing new (no cancel, no send)", () => {
    const { props } = renderInput({ isSending: false });

    fireEvent.keyDown(chatInput(), { key: "Escape" });

    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });
});
