import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { useExperienceCopilotTurnStore } from "../../../../stores/experience-copilot-turn-store.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;
let ExperienceCopilotMessageList: typeof import("./ExperienceCopilotMessageList.js").ExperienceCopilotMessageList;

// Mock the two heavy/boundary leaves so the list test pins the LIST contract
// (message/pending/turn-shell rendering), not markdown or the turn shell's
// internal diff chrome (each pinned in its own test).
const realMarkdown = await import("../../../../lib/markdown.js");
mock.module("../../../../lib/markdown.js", () => ({
  ...realMarkdown,
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

const realTurnShell = await import("./ExperienceCopilotTurnShell.js");
mock.module("./ExperienceCopilotTurnShell.js", () => ({
  ...realTurnShell,
  ExperienceCopilotTurnShell: ({ activities }: { activities: unknown[] }) => (
    <div data-testid="copilot-turn-shell">{activities.length} activities</div>
  ),
}));

beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ ExperienceCopilotMessageList } = await import("./ExperienceCopilotMessageList.js"));
});

function message(over: Partial<ExperienceCopilotMessageWire>): ExperienceCopilotMessageWire {
  return {
    id: "m1",
    threadId: "thread-1",
    role: "user",
    content: "hello",
    toolCallsJson: null,
    toolCallId: null,
    createdAt: "",
    ...over,
  };
}

beforeEach(() => {
  useExperienceCopilotTurnStore.setState({ turnsByThread: {} });
});

describe("ExperienceCopilotMessageList", () => {
  it("renders each persisted user/assistant message", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[
          message({ id: "u1", role: "user", content: "Make it scarier" }),
          message({ id: "a1", role: "assistant", content: "Here are the rules" }),
        ]}
        pendingText=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("Make it scarier")).toBeDefined();
    expect(getByText("Here are the rules")).toBeDefined();
  });

  it("shows the live pendingText assistant bubble when non-empty", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText="streaming reply…"
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("streaming reply…")).toBeDefined();
  });

  it("reads the current turn's activities from the store and renders the turn shell", () => {
    useExperienceCopilotTurnStore.setState({
      turnsByThread: {
        "thread-1": [
          { toolCallId: "a1", toolName: "run_test", status: "done", summary: "ok" },
          { toolCallId: "a2", toolName: "read_skill_file", status: "done", readPath: "/f" },
        ],
      },
    });

    const { getByTestId } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByTestId("copilot-turn-shell").textContent).toBe("2 activities");
  });

  it("renders the empty state when there is nothing to show", () => {
    const { getByText } = render(
      <ExperienceCopilotMessageList
        threadId="thread-1"
        messages={[]}
        pendingText=""
        baseRules=""
        baseVisual=""
        onApply={mock()}
      />,
    );

    expect(getByText("experience_copilot_title")).toBeDefined();
  });
});
