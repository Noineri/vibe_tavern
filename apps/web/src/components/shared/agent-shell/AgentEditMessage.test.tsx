/**
 * Agent inline message edit (AGENT_SHELL_POLISH, Wave 3 / AP-12) — the NEW
 * component: `AgentEditMessage` (fork #1 of the RP message edit arm in
 * `chat/MessageBlock.tsx`). Local draft state, Esc cancels, submit resends
 * via the passed `onSubmit`, blank drafts cannot submit.
 */
import { describe, expect, it } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const { render, fireEvent } = await import("@testing-library/react");
const { AgentEditMessage } = await import("./AgentEditMessage.js");

function renderEditor(over: Partial<Parameters<typeof AgentEditMessage>[0]> = {}) {
  const onSubmit = over.onSubmit ?? ((_content: string) => {});
  const onCancel = over.onCancel ?? (() => {});
  return {
    onSubmit,
    onCancel,
    ...render(
      <AgentEditMessage
        initialText="What should I say?"
        isBusy={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
        {...over}
      />,
    ),
  };
}

describe("AgentEditMessage — inline edit of the last own message (AP-12)", () => {
  it("renders the message text as the editable draft", () => {
    const { getByRole } = renderEditor({ initialText: "second question" });

    const box = getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("second question");
  });

  it("submit forwards the edited draft", () => {
    const seen: string[] = [];
    const { getByRole, getByTestId } = renderEditor({ onSubmit: (content) => { seen.push(content); } });

    fireEvent.change(getByRole("textbox") as HTMLTextAreaElement, { target: { value: "revised question" } });
    fireEvent.click(getByTestId("copilot-edit-send"));
    expect(seen).toEqual(["revised question"]);
  });

  it("Escape cancels without submitting", () => {
    const submitted: string[] = [];
    let cancelled = 0;
    const { getByRole } = renderEditor({
      onSubmit: (content) => { submitted.push(content); },
      onCancel: () => { cancelled += 1; },
    });

    fireEvent.change(getByRole("textbox") as HTMLTextAreaElement, { target: { value: "changed my mind" } });
    fireEvent.keyDown(getByRole("textbox"), { key: "Escape" });
    expect(cancelled).toBe(1);
    expect(submitted).toEqual([]);
  });

  it("the cancel button cancels without submitting", () => {
    const submitted: string[] = [];
    let cancelled = 0;
    const { getByTestId } = renderEditor({
      onSubmit: (content) => { submitted.push(content); },
      onCancel: () => { cancelled += 1; },
    });

    fireEvent.click(getByTestId("copilot-edit-cancel"));
    expect(cancelled).toBe(1);
    expect(submitted).toEqual([]);
  });

  it("a blank draft disables send (the empty-text guard)", () => {
    const submitted: string[] = [];
    const { getByRole, getByTestId } = renderEditor({ onSubmit: (content) => { submitted.push(content); } });

    fireEvent.change(getByRole("textbox") as HTMLTextAreaElement, { target: { value: "   " } });
    expect((getByTestId("copilot-edit-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByTestId("copilot-edit-send"));
    expect(submitted).toEqual([]);
  });

  it("while busy both buttons disable (the controller's isSending)", () => {
    const { getByTestId } = renderEditor({ isBusy: true });

    expect((getByTestId("copilot-edit-send") as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId("copilot-edit-cancel") as HTMLButtonElement).disabled).toBe(true);
  });
});
