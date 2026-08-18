import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ToolbarSelectItem } from "../../../shared/ToolbarSelect.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import type { ProviderProfileRecord } from "../../../../api/types.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ExperienceCopilotMobileInputArea: typeof import("./ExperienceCopilotMobileInputArea.js").ExperienceCopilotMobileInputArea;

// ── SAFE mock.module stubs (capture real first, spread `...real`) ──

const realTooltip = await import("../../../shared/Tooltip.js");
mock.module("../../../shared/Tooltip.js", () => ({
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

const realToolbarSelect = await import("../../../shared/ToolbarSelect.js");
mock.module("../../../shared/ToolbarSelect.js", () => ({
  ...realToolbarSelect,
  ToolbarSelect: FakeToolbarSelect,
}));

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ExperienceCopilotMobileInputArea } = await import("./ExperienceCopilotMobileInputArea.js"));
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

function renderMobileInput(over: Partial<Parameters<typeof ExperienceCopilotMobileInputArea>[0]> = {}) {
  const props = {
    isSending: false,
    onSend: mock(),
    onCancel: mock(),
    providerProfileId: "p1",
    model: "m1",
    onProviderChange: mock(),
    ...over,
  };
  const utils = render(<ExperienceCopilotMobileInputArea {...props} />);
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
