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

const realDropdownSelect = await import("../../../shared/DropdownSelect.js");
mock.module("../../../shared/DropdownSelect.js", () => ({
  ...realDropdownSelect,
  DropdownSelect: FakeDropdownSelect,
}));

// Favorites actions hit the RPC client — stub them at the module boundary
// (SAFE: real captured first, only the two favorites fns overridden). The
// hook's data path (store read) stays real: tests seed the store directly.
const realProviderActions = await import("../../../../stores/api-actions/provider-actions.js");
mock.module("../../../../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  loadFavoriteModelsAction: async () => {},
  toggleFavoriteModelAction: async () => {},
}));

beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ExperienceCopilotInputArea } = await import("./ExperienceCopilotInputArea.js"));
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

    fireEvent.change(getByPlaceholderText("experience_copilot_input_placeholder"), { target: { value: "propose a twist" } });

    expect((getByTestId("copilot-send-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the trimmed text and clears the draft", () => {
    const { getByTestId, getByPlaceholderText, props } = renderInput();

    fireEvent.change(getByPlaceholderText("experience_copilot_input_placeholder"), { target: { value: "  make it darker  " } });
    fireEvent.click(getByTestId("copilot-send-btn"));

    expect(props.onSend).toHaveBeenCalledWith("make it darker");
    expect((getByPlaceholderText("experience_copilot_input_placeholder") as HTMLTextAreaElement).value).toBe("");
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
});
