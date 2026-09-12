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

const { render } = await import("@testing-library/react");
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
});
