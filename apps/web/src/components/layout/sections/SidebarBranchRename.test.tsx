/**
 * SidebarBranchRename characterization test.
 *
 * Pins the inline branch-rename control's contract. SidebarBranchRename owns a
 * tiny edit/commit/cancel state machine that was extracted verbatim out of
 * Sidebar.tsx (SIDEBAR_GOD_OBJECT_AUDIT step 3c); this test pins the behavior
 * that must survive the extraction and the upcoming RichChatRow move:
 *   - default: renders an edit-trigger button (no input);
 *   - click the trigger → shows a focused input seeded with the initial label;
 *   - blur with a changed, non-empty value → onRename(trimmed), back to button;
 *   - blur with an UNCHANGED value → onRename NOT called, back to button;
 *   - blur with an empty / whitespace-only value → onRename NOT called (abort);
 *   - Escape → cancel (no onRename), back to button;
 *   - Enter → delegates to blur → onRename(trimmed).
 *
 * useT is mocked at the module boundary (the control calls useT but never
 * renders its output — same passthrough pattern as ActionSheet/VibeMdView).
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

const { SidebarBranchRename } = await import("./SidebarBranchRename.js");
let userEvent: typeof import("@testing-library/user-event").default;
beforeAll(async () => {
	({ default: userEvent } = await import("@testing-library/user-event"));
});

describe("SidebarBranchRename", () => {
  it("renders an edit-trigger button (not an input) by default", () => {
    const { getByRole, queryByRole } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={() => {}} />,
    );
    expect(getByRole("button")).toBeTruthy();
    expect(queryByRole("textbox")).toBeNull();
  });

  it("clicking the trigger reveals a focused input seeded with the initial label", () => {
    const { getByRole, getByDisplayValue } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={() => {}} />,
    );
    fireEvent.click(getByRole("button"));
    const input = getByDisplayValue("main");
    expect(input).toBeTruthy();
    // useEffect focuses the input on edit-mode entry.
    expect(document.activeElement).toBe(input);
  });

	it("blur with a changed value commits onRename with the trimmed value", async () => {
		const onRename = mock();
    const { getByRole, getByDisplayValue, queryByRole } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={onRename} />,
		);
		fireEvent.click(getByRole("button"));
		const input = getByDisplayValue("main");
		if (!(input instanceof HTMLInputElement)) throw new Error("Expected a branch-label input");
		const user = userEvent.setup();
		await user.clear(input);
		await user.type(input, "  renamed  ");
		expect(input.value).toBe("  renamed  ");
		await user.tab();
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenLastCalledWith("renamed");
    // committed → input unmounts, button returns
    expect(queryByRole("textbox")).toBeNull();
  });

  it("blur with an UNCHANGED value does NOT call onRename", () => {
		const onRename = mock();
    const { getByRole, getByDisplayValue, queryByRole } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={onRename} />,
    );
    fireEvent.click(getByRole("button"));
    const input = getByDisplayValue("main");
    fireEvent.blur(input); // unchanged
    expect(onRename).not.toHaveBeenCalled();
    expect(queryByRole("textbox")).toBeNull();
  });

  it("blur with an empty / whitespace-only value aborts (no onRename)", () => {
		const onRename = mock();
    const { getByRole, getByDisplayValue } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={onRename} />,
    );
    fireEvent.click(getByRole("button"));
    const input = getByDisplayValue("main");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("Escape cancels without calling onRename and returns to the button", () => {
		const onRename = mock();
    const { getByRole, getByDisplayValue, queryByRole } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={onRename} />,
    );
    fireEvent.click(getByRole("button"));
    const input = getByDisplayValue("main");
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(queryByRole("textbox")).toBeNull();
  });

	it("Enter delegates to blur → commits onRename with the trimmed value", async () => {
		const onRename = mock();
    const { getByRole, getByDisplayValue } = render(
      <SidebarBranchRename branchId="br1" initialLabel="main" onRename={onRename} />,
		);
		fireEvent.click(getByRole("button"));
		const input = getByDisplayValue("main");
		if (!(input instanceof HTMLInputElement)) throw new Error("Expected a branch-label input");
		const user = userEvent.setup();
		await user.clear(input);
		await user.type(input, "renamed");
		expect(input.value).toBe("renamed");
		await user.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenLastCalledWith("renamed");
  });
});
