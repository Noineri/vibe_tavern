/**
 * ScriptManagementControls — presentation tests.
 *
 * Pins the AS-8c1 management bar boundary: row 1 (name, kind badge, status
 * pill, enable toggle, desktop save-state text, save, delete) plus row 2
 * (description + the entity-only links block). i18n and the LinkBindingPopover
 * are stubbed (key-echo translator, structural popover double); every
 * callback is asserted through the component's explicit props.
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { useDomEnv } from "../../../../test/dom-env.js";
import type { ScriptLinkRecord } from "../../../api/types.js";
import type { LinkTarget } from "../../shared/LinkBindingPopover.js";
import type {
  ScriptDraftSaveState,
  ScriptDraftValues,
} from "../../../stores/script-draft-store.js";

useDomEnv();

const realI18nContext = await import("../../../i18n/context.js");
const realLinkBindingPopover = await import("../../shared/LinkBindingPopover.js");
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

mock.module("../../shared/LinkBindingPopover.js", () => ({
  ...realLinkBindingPopover,
  LinkBindingPopover: (props: {
    links: Array<{ targetType: string; targetId: string }>;
    onSetLinks: (links: Array<{ targetType: string; targetId: string }>) => void;
  }) => (
    <div data-testid="links-picker">
      {props.links.map((link) => (
        <span key={`${link.targetType}:${link.targetId}`} data-testid="bound-link">
          {link.targetId}
        </span>
      ))}
      <button
        type="button"
        data-testid="links-add"
        onClick={() => props.onSetLinks([...props.links, { targetType: "persona", targetId: "persona-2" }])}
      >
        add
      </button>
      <button
        type="button"
        data-testid="links-mixed"
        onClick={() => props.onSetLinks([...props.links, { targetType: "lorebook", targetId: "lb-1" }])}
      >
        mixed
      </button>
    </div>
  ),
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
  scopeType?: string;
  description?: string;
  links?: ScriptLinkRecord[];
  linkCharacters?: LinkTarget[];
  linkPersonas?: LinkTarget[];
  draftDirty?: boolean;
  draftSaveState?: ScriptDraftSaveState;
  draftError?: string | null;
  resetKey?: string | null;
  isMobile?: boolean;
}

function renderControls(overrides: ControlOverrides = {}) {
  const patches: Array<Partial<ScriptDraftValues>> = [];
  const toggles: boolean[] = [];
  const linksSets: Array<Array<{ targetType: "character" | "persona"; targetId: string }>> = [];
  let saves = 0;
  let deletes = 0;
  const result = render(
    <ScriptManagementControls
      name="My script"
      enabled={true}
      scriptKind="prompt"
      scopeType="entity"
      description="Does things"
      links={[]}
      linkCharacters={[]}
      linkPersonas={[]}
      draftDirty={true}
      draftSaveState="idle"
      draftError={null}
      resetKey="s1"
      isMobile={false}
      onUpdateDraft={(patch) => { patches.push(patch); }}
      onToggleEnabled={(enabled) => { toggles.push(enabled); }}
      onDelete={() => { deletes += 1; }}
      onSave={() => { saves += 1; }}
      onSetScriptLinks={(next) => { linksSets.push(next); }}
      {...overrides}
    />,
  );
  return {
    ...result,
    calls: { patches, toggles, linksSets, saves: () => saves, deletes: () => deletes },
  };
}

describe("ScriptManagementControls", () => {
  it("renders both rows: management cluster plus description and links", () => {
    const { getByPlaceholderText, getByRole, getByText, getByTestId } = renderControls();
    // Row 1: name, kind badge, status pill, toggle, save-state text, save, delete.
    getByPlaceholderText("script_name");
    getByText("script_kind_prompt");
    getByText("experience_editor_enabled");
    getByRole("switch");
    getByText("unsaved_changes");
    getByRole("button", { name: "save" });
    getByRole("button", { name: "delete_script_confirm" });
    // Row 2: description field and the entity-scope links block.
    getByPlaceholderText("script_desc_placeholder");
    getByText("script_links_label");
    getByTestId("links-picker");
  });

  it("shows the dice kind label for dice scripts", () => {
    const { getByText, queryByText } = renderControls({ scriptKind: "dice" });
    getByText("script_kind_dice");
    expect(queryByText("script_kind_prompt")).toBeNull();
  });

  it("routes name and description edits through onUpdateDraft", () => {
    const { getByPlaceholderText, calls } = renderControls();
    fireEvent.change(getByPlaceholderText("script_name"), { target: { value: "Renamed" } });
    fireEvent.change(getByPlaceholderText("script_desc_placeholder"), { target: { value: "New desc" } });
    expect(calls.patches).toEqual([{ name: "Renamed" }, { description: "New desc" }]);
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

  it("renders the links block only for entity scope", () => {
    const entity = renderControls({ scopeType: "entity" });
    entity.getByText("script_links_label");
    entity.getByTestId("links-picker");
    entity.unmount();
    const global = renderControls({ scopeType: "global" });
    expect(global.queryByText("script_links_label")).toBeNull();
    expect(global.queryByTestId("links-picker")).toBeNull();
  });

  it("passes bound links through and filters non-entity links on set", () => {
    const characters: LinkTarget[] = [{ id: "c1", name: "C1", avatarAssetId: null }];
    const links: ScriptLinkRecord[] = [{ scriptId: "s1", targetType: "character", targetId: "c1" }];
    const { getByTestId, getByText, calls } = renderControls({ links, linkCharacters: characters });
    getByText("c1");
    fireEvent.click(getByTestId("links-add"));
    expect(calls.linksSets).toEqual([
      [
        { targetType: "character", targetId: "c1" },
        { targetType: "persona", targetId: "persona-2" },
      ],
    ]);
    fireEvent.click(getByTestId("links-mixed"));
    // The lorebook link is dropped: only character/persona links survive.
    expect(calls.linksSets[1]).toEqual([{ targetType: "character", targetId: "c1" }]);
  });

  it("hides the save-state text on mobile and shortens the status pill", () => {
    // As in the model, the mobile hiding is the `max-md:hidden` CSS class,
    // not conditional rendering — so the text stays in the DOM on both
    // viewports and the class carries the boundary.
    const desktop = renderControls({ isMobile: false, draftDirty: false });
    expect(desktop.getByText("saved_state").getAttribute("class")).toContain("max-md:hidden");
    desktop.getByText("experience_editor_enabled");
    desktop.unmount();
    const mobile = renderControls({ isMobile: true, draftDirty: false });
    expect(mobile.getByText("saved_state").getAttribute("class")).toContain("max-md:hidden");
    mobile.getByText("experience_editor_enabled_short");
  });
});
