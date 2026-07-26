/**
 * SidebarChatRename characterization test.
 *
 * Pins the chat-title rename input's commit/abort contract. SidebarChatRename
 * owns the draft + the commit state machine that was lifted out of RichChatRow
 * (SIDEBAR_GOD_OBJECT_AUDIT step 3c); the context menu that triggers rename is a
 * Radix DropdownMenu whose Content does not mount under happy-dom, so this input
 * is the only testable seam for the rename behavior. Pins:
 *   - renders an `<input>` seeded with the initial value;
 *   - blur with a changed, non-empty value → onCommit(trimmed), onCancel NOT called;
 *   - blur UNCHANGED → onCancel, onCommit NOT called (abort);
 *   - blur empty / whitespace → onCancel, onCommit NOT called (abort);
 *   - Escape → onCancel, onCommit NOT called;
 *   - Enter with a changed value → onCommit(trimmed).
 */
import { beforeAll, describe, it, expect, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render, fireEvent } = await import("@testing-library/react");

let SidebarChatRename: typeof import("./SidebarChatRename.js").SidebarChatRename;

beforeAll(async () => {
	({ SidebarChatRename } = await import("./SidebarChatRename.js"));
});

const CLASS = "rename-input";

describe("SidebarChatRename", () => {
  it("renders an input seeded with the initial value", () => {
    const { getByDisplayValue, getByRole } = render(
      <SidebarChatRename initialValue="My Chat" onCommit={() => {}} onCancel={() => {}} className={CLASS} />,
    );
    const input = getByDisplayValue("My Chat");
    expect(input).toBeTruthy();
    expect(getByRole("textbox")).toBe(input);
  });

  it("blur with a changed value commits onCommit with the trimmed value", () => {
		const onCommit = mock();
		const onCancel = mock();
    const { getByDisplayValue } = render(
      <SidebarChatRename initialValue="My Chat" onCommit={onCommit} onCancel={onCancel} className={CLASS} />,
    );
    const input = getByDisplayValue("My Chat");
	    fireEvent.change(input, { target: { value: "  Renamed  " } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith("Renamed");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("blur with an UNCHANGED value aborts via onCancel (no onCommit)", () => {
		const onCommit = mock();
		const onCancel = mock();
    const { getByDisplayValue } = render(
      <SidebarChatRename initialValue="My Chat" onCommit={onCommit} onCancel={onCancel} className={CLASS} />,
    );
    fireEvent.blur(getByDisplayValue("My Chat")); // unchanged
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("blur with an empty / whitespace-only value aborts via onCancel (no onCommit)", () => {
		const onCommit = mock();
		const onCancel = mock();
    const { getByDisplayValue } = render(
      <SidebarChatRename initialValue="My Chat" onCommit={onCommit} onCancel={onCancel} className={CLASS} />,
    );
    const input = getByDisplayValue("My Chat");
	    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels via onCancel (no onCommit)", () => {
		const onCommit = mock();
		const onCancel = mock();
    const { getByDisplayValue } = render(
      <SidebarChatRename initialValue="My Chat" onCommit={onCommit} onCancel={onCancel} className={CLASS} />,
    );
    const input = getByDisplayValue("My Chat");
	    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter with a changed value commits onCommit with the trimmed value", () => {
		const onCommit = mock();
		const onCancel = mock();
    const { getByDisplayValue } = render(
      <SidebarChatRename initialValue="My Chat" onCommit={onCommit} onCancel={onCancel} className={CLASS} />,
    );
    const input = getByDisplayValue("My Chat");
	    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith("Renamed");
    expect(onCancel).not.toHaveBeenCalled();
  });
});
