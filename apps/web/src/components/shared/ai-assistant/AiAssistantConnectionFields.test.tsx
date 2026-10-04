/**
 * MUI step 17 (owner 2026-09-11): the AI-assistant connection fields (provider
 * + model pickers used by the AI-editor modal, AiAssistantModal — including
 * the impersonation settings — and RegexAiAssistantModal) stack into a list on
 * mobile instead of the 2-col grid. Pin: the container carries the mobile
 * single-column override; both labeled pickers render.
 */
import { describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");
const { AiAssistantConnectionFields } = await import("./AiAssistantConnectionFields.js");

const LABELS = {
  connection: "connection",
  model: "model",
  selectProvider: "select provider",
  searchProvider: "search provider",
  searchModel: "search model",
};

describe("AiAssistantConnectionFields mobile layout (MUI step 17)", () => {
  it("columnates on mobile (max-md:grid-cols-1) while keeping the 2-col desktop grid", () => {
    const view = render(
      <AiAssistantConnectionFields
        providerProfiles={[{ id: "p1", name: "OpenRouter" }]}
        providerId="p1"
        modelName="m1"
        providerModels={[{ id: "m1", label: "Model One" }]}
        selectedProfileDefaultModel="m1"
        onProviderChange={() => {}}
        onModelChange={() => {}}
        labels={LABELS}
      />,
    );
    const container = view.container.firstElementChild as HTMLElement;
    expect(container.className).toContain("grid-cols-2");
    expect(container.className).toContain("max-md:grid-cols-1");
    expect(view.getByText("connection")).toBeTruthy();
    expect(view.getByText("model")).toBeTruthy();
  });

  it("opt-in secondary-model controls resolve the chat fallback and expose the shared toggle and pin", () => {
    const changes: Array<[string, unknown]> = [];
    const view = render(
      <AiAssistantConnectionFields
        providerProfiles={[
          { id: "active", name: "Active", defaultModel: "chat-default", isActive: true },
          { id: "secondary", name: "Secondary", defaultModel: "secondary-default" },
        ]}
        providerId="secondary"
        modelName="secondary-model"
        providerModels={[{ id: "chat-default", label: "Chat default" }]}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        useChatModel={{ checked: true, onChange: (checked) => changes.push(["chat", checked]), label: "Use chat" }}
        modelPin={{
          pinned: false,
          onChange: (pinned, value) => changes.push(["pin", { pinned, ...value }]),
          pinLabel: "Pin model",
          unpinLabel: "Unpin model",
          overridesChatModel: true,
        }}
        showLabels={false}
        includeDefaultOption={false}
        withBottomMargin={false}
        labels={LABELS}
      />,
    );

    expect(view.getByRole("button", { name: "Active" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Chat default" })).toBeTruthy();
    fireEvent.click(view.getByRole("switch", { name: "Use chat" }));
    fireEvent.click(view.getByTitle("Pin model"));
    expect(changes).toEqual([
      ["chat", false],
      ["pin", { pinned: true, providerId: "active", modelName: "chat-default" }],
    ]);
  });
});
