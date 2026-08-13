import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ToolbarSelectItem } from "../../../shared/ToolbarSelect.js";
import { useProviderDataStore } from "../../../../stores/provider-data-store.js";
import type { ProviderProfileRecord } from "../../../../api/types.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ExperienceCopilotInputArea: typeof import("./ExperienceCopilotInputArea.js").ExperienceCopilotInputArea;

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
  ({ ExperienceCopilotInputArea } = await import("./ExperienceCopilotInputArea.js"));
});

// Two profiles; p1 carries one tool-capable cached model so the REAL
// useToolCapableModels hook serves the model list from cache (no fetch).
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
  useProviderDataStore.setState({ profiles: PROFILES });
}

beforeEach(() => {
  seedStores();
});

function renderInput(over: Partial<Parameters<typeof ExperienceCopilotInputArea>[0]> = {}) {
  const props = {
    isSending: false,
    onSend: mock(),
    onCancel: mock(),
    providerProfileId: "p1",
    model: "m1",
    onProviderChange: mock(),
    ...over,
  };
  const utils = render(<ExperienceCopilotInputArea {...props} />);
  return { ...utils, props };
}

describe("ExperienceCopilotInputArea", () => {
  it("disables send while empty and enables it once text is typed", () => {
    const { getByTestId, getByPlaceholderText } = renderInput();

    const sendBtn = getByTestId("copilot-send-btn") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);

    fireEvent.change(getByPlaceholderText("Ask the copilot…"), { target: { value: "propose a twist" } });

    expect((getByTestId("copilot-send-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the trimmed text and clears the draft", () => {
    const { getByTestId, getByPlaceholderText, props } = renderInput();

    fireEvent.change(getByPlaceholderText("Ask the copilot…"), { target: { value: "  make it darker  " } });
    fireEvent.click(getByTestId("copilot-send-btn"));

    expect(props.onSend).toHaveBeenCalledWith("make it darker");
    expect((getByPlaceholderText("Ask the copilot…") as HTMLTextAreaElement).value).toBe("");
  });

  it("replaces send with cancel while isSending, and cancel calls onCancel", () => {
    const { queryByTestId, getByTestId, props } = renderInput({ isSending: true });

    expect(queryByTestId("copilot-send-btn")).toBeNull();
    fireEvent.click(getByTestId("copilot-cancel-btn"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("changing the provider calls onProviderChange with the new profile id", () => {
    const { getByTestId, props } = renderInput();

    fireEvent.click(getByTestId("copilot-provider-option-p2"));

    expect(props.onProviderChange).toHaveBeenCalledWith("p2");
  });

  it("changing the model calls onProviderChange with the profile id + model id", () => {
    const { getByTestId, props } = renderInput();

    fireEvent.click(getByTestId("copilot-model-option-m1"));

    expect(props.onProviderChange).toHaveBeenCalledWith("p1", "m1");
  });
});
