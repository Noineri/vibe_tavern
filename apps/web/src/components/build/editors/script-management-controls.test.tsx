/**
 * ScriptManagementControls — presentation tests.
 *
 * Pins the AS-8c1 management bar boundary. Desktop pins row 1 (name, kind
 * badge, status pill, enable toggle, desktop save-state text, save, delete
 * — the description field + the entity-only links block moved into the Code
 * tab's toolbar strip since AS-8c4e); mobile pins the shared AS-8c4f1 row
 * (name, toggle, save, `...` — the kind and the delete live in the sheet).
 * i18n is stubbed (key-echo translator); every callback is asserted through
 * the component's explicit props.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type {
  ScriptDraftSaveState,
  ScriptDraftValues,
} from "../../../stores/script-draft-store.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realTooltip = await import("../../shared/Tooltip.js");

mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (k: string) => k,
    tDynamic: (k: string) => k,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let ScriptManagementControls: typeof import("./script-management-controls.js").ScriptManagementControls;
beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ ScriptManagementControls } = await import("./script-management-controls.js"));
});

interface ControlOverrides {
  name?: string;
  enabled?: boolean;
  scriptKind?: string;
  draftDirty?: boolean;
  draftSaveState?: ScriptDraftSaveState;
  draftError?: string | null;
  resetKey?: string | null;
  isMobile?: boolean;
}

function renderControls(overrides: ControlOverrides = {}) {
  const patches: Array<Partial<ScriptDraftValues>> = [];
  const toggles: boolean[] = [];
  let saves = 0;
  let deletes = 0;
  const result = render(
    <ScriptManagementControls
      name="My script"
      enabled={true}
      scriptKind="prompt"
      draftDirty={true}
      draftSaveState="idle"
      draftError={null}
      resetKey="s1"
      isMobile={false}
      onUpdateDraft={(patch) => { patches.push(patch); }}
      onToggleEnabled={(enabled) => { toggles.push(enabled); }}
      onDelete={() => { deletes += 1; }}
      onSave={() => { saves += 1; }}
      {...overrides}
    />,
  );
  return {
    ...result,
    calls: { patches, toggles, saves: () => saves, deletes: () => deletes },
  };
}

describe("ScriptManagementControls", () => {
  it("renders the row-1 management cluster with no description or links", () => {
    const { getByPlaceholderText, getByRole, getByText, queryByPlaceholderText, queryByText, queryByTestId } = renderControls();
    // Row 1: name, kind badge, status pill, toggle, save-state text, save, delete.
    getByPlaceholderText("script_name");
    getByText("script_kind_prompt");
    getByText("experience_editor_enabled");
    getByRole("switch");
    getByText("unsaved_changes");
    getByRole("button", { name: "save" });
    getByRole("button", { name: "delete_script_confirm" });
    // Row 2 moved to the Code tab's toolbar strip (AS-8c4e): the bar renders
    // no description field and no links block.
    expect(queryByPlaceholderText("script_desc_placeholder")).toBeNull();
    expect(queryByText("script_links_label")).toBeNull();
    expect(queryByTestId("links-picker")).toBeNull();
  });

  it("shows the dice kind label for dice scripts", () => {
    const { getByText, queryByText } = renderControls({ scriptKind: "dice" });
    getByText("script_kind_dice");
    expect(queryByText("script_kind_prompt")).toBeNull();
  });

  it("routes name edits through onUpdateDraft", () => {
    const { getByPlaceholderText, calls } = renderControls();
    fireEvent.change(getByPlaceholderText("script_name"), { target: { value: "Renamed" } });
    expect(calls.patches).toEqual([{ name: "Renamed" }]);
  });

  it("routes toggle, save and delete through their callbacks", () => {
    const { getByRole, calls } = renderControls({ enabled: true, draftDirty: true });
    fireEvent.click(getByRole("switch"));
    expect(calls.toggles).toEqual([false]);
    fireEvent.click(getByRole("button", { name: "save" }));
    expect(calls.saves()).toBe(1);
    fireEvent.click(getByRole("button", { name: "delete_script_confirm" }));
    expect(calls.deletes()).toBe(1);
  });

  it("renders the shared mobile row on mobile: one row, no status pill, kind and delete in the sheet", () => {
    // AS-8c4f1: mobile renders ManagementMobileRow — the name, the toggle,
    // the save and the `...` button in one row. The status pill and the
    // save-state text are gone (the toggle and the save button carry the
    // state); the kind badge and the delete live in the more-actions sheet.
    const { getByPlaceholderText, getByRole, getByText, queryByText, calls } = renderControls({ isMobile: true, draftDirty: false });
    getByPlaceholderText("script_name");
    getByRole("switch");
    getByRole("button", { name: "save" });
    getByRole("button", { name: "management_more_actions" });
    expect(queryByText("experience_editor_enabled")).toBeNull();
    expect(queryByText("experience_editor_enabled_short")).toBeNull();
    expect(queryByText("saved_state")).toBeNull();
    expect(queryByText("script_kind_prompt")).toBeNull();
    expect(queryByText("delete_script_confirm")).toBeNull();
    // `...` opens the sheet with the script name, the kind and the delete.
    fireEvent.click(getByRole("button", { name: "management_more_actions" }));
    getByText("My script");
    getByText("script_kind_prompt");
    // The kind row is info-only: tapping it deletes nothing.
    fireEvent.click(getByText("script_kind_prompt"));
    expect(calls.deletes()).toBe(0);
    // The sheet delete routes through the same onDelete (confirm modal).
    fireEvent.click(getByText("delete_script_confirm"));
    expect(calls.deletes()).toBe(1);
  });
});
