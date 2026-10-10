/**
 * CharacterForm — alternate-greeting chip deletion (E2, MOBILE_DEFECTS_ROUND_2).
 *
 * Pins the safe-delete wiring: the per-chip ✕ no longer splices the array
 * instantly — it opens the shared DestructiveConfirmModal; only the confirm
 * removes the greeting, cancel leaves the set untouched, and the selected
 * chip index clamps when the deleted one was the last. Rendered through the
 * real react-hook-form (useForm in a harness) so setValue/shouldDirty wiring
 * is the REAL boundary.
 */
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { defaultObjectiveState, normalizeTrackerTemplate, type TrackerTemplate } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render, waitFor } = await import("@testing-library/react");
const { createElement } = await import("react");
const { useForm } = await import("react-hook-form");

// useT at the module boundary — keys verbatim so assertions match.
const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const n = Number(opts?.n);
      switch (key) {
        case "character_tracker_template_label": return "Tracker template";
        case "character_tracker_template_scene": return `Scene: ${n} field${n === 1 ? "" : "s"}`;
        case "character_tracker_template_objective": return `Objectives: ${String(opts?.mode)} mode, ${n} goal${n === 1 ? "" : "s"}`;
        case "character_tracker_template_mode_route": return "route";
        case "character_tracker_template_mode_goals": return "goals";
        case "character_tracker_template_remove": return "Remove";
        case "character_tracker_template_remove_aria": return "Remove tracker template";
        case "character_tracker_template_remove_title": return "Remove tracker template?";
        case "character_tracker_template_remove_body": return "The template will be removed from the character card. Tracker settings in existing chats will not change.";
        default: return key;
      }
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// CustomTooltip needs a Radix provider context irrelevant to this pin.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

// CharacterForm renders BoundResourcesField / GalleryAccordion, which fetch
// the lorebook / persona / script lists and bindings on mount; stub them empty
// so the render never hits the network (mirrors CoauthorCharacterForm.test.tsx).
const realLorebookApi = await import("../../../api/lorebook-api.js");
const realPersonaApi = await import("../../../api/persona-api.js");
const realScriptApi = await import("../../../api/script-api.js");
const realCharacterApi = await import("../../../api/character-api.js");
const realRegexApi = await import("../../../api/regex-api.js");
const realVersionSwitcher = await import("../VersionSwitcher.js");

let trackerTemplate: TrackerTemplate | null = null;
const getTrackerTemplate = mock(() => Promise.resolve(trackerTemplate));
const deleteTrackerTemplate = mock(async () => { trackerTemplate = null; });
mock.module("../../../api/lorebook-api.js", () => ({
	...realLorebookApi,
	listAllLorebooks: () => Promise.resolve([]),
	getLorebookLinks: () => Promise.resolve([]),
	setLorebookLinks: () => Promise.resolve([]),
}));
mock.module("../../../api/character-api.js", () => ({
	...realCharacterApi,
	listCharacterLorebooks: () => Promise.resolve([]),
	listCharacterScripts: () => Promise.resolve([]),
  getTrackerTemplate,
  deleteTrackerTemplate,
}));
mock.module("../VersionSwitcher.js", () => ({
  ...realVersionSwitcher,
  VersionSwitcher: ({ onAfterActivate }: { onAfterActivate: () => void }) => (
    <button type="button" data-testid="version-switch" onClick={onAfterActivate}>switch version</button>
  ),
}));
mock.module("../../../api/persona-api.js", () => ({
	...realPersonaApi,
	listPersonas: () => Promise.resolve([]),
	listPersonaLorebooks: () => Promise.resolve([]),
	listPersonaScripts: () => Promise.resolve([]),
}));
mock.module("../../../api/script-api.js", () => ({
	...realScriptApi,
	listAllScripts: () => Promise.resolve([]),
	getScriptLinks: () => Promise.resolve([]),
	setScriptLinks: () => Promise.resolve([]),
}));
mock.module("../../../api/regex-api.js", () => ({
	...realRegexApi,
	listAllRegexPresets: () => Promise.resolve([]),
	getRegexLinks: () => Promise.resolve([]),
	setRegexLinks: () => Promise.resolve([]),
}));

let CharacterForm: typeof import("./CharacterForm.js").CharacterForm;
beforeAll(async () => {
  ({ CharacterForm } = await import("./CharacterForm.js"));
});

const chipRemoveButtons = () => Array.from(document.querySelectorAll('[data-testid^="alt-greeting-remove-"]'));

/** The open DestructiveConfirmModal's confirm button (bg-danger, portalled). */
const dangerConfirm = () =>
  Array.from(document.querySelectorAll("button")).find((b) => b.className.includes("bg-danger") && b.className.includes("px-[18px]")) ?? null;

function makeTrackerTemplate({ sceneFieldCount = 0, objectiveMode, objectiveCount = 0 }: {
  sceneFieldCount?: number;
  objectiveMode?: "route" | "goals";
  objectiveCount?: number;
}): TrackerTemplate {
  const objectiveState = defaultObjectiveState();
  const template = normalizeTrackerTemplate({
    version: 1,
    scene: sceneFieldCount > 0
      ? {
          enabled: true,
          config: {
            schema: Object.fromEntries(
              Array.from({ length: sceneFieldCount }, (_, index) => [`field_${index}`, { $type: "string" }]),
            ),
          },
        }
      : null,
    objective: objectiveMode
      ? {
          enabled: true,
          state: {
            ...objectiveState,
            mode: objectiveMode,
            tasks: objectiveMode === "route"
              ? Array.from({ length: objectiveCount }, (_, index) => ({ id: `task_${index}`, description: `Task ${index}`, status: "pending" }))
              : [],
            shortTermGoals: objectiveMode === "goals"
              ? Array.from({ length: objectiveCount }, (_, index) => ({ id: `goal_${index}`, description: `Goal ${index}`, status: "pending" }))
              : [],
          },
        }
      : null,
  });
  if (!template) throw new Error("Expected a populated tracker template");
  return template;
}

function Harness({ greetings, onReset = mock() }: { greetings: string[]; onReset?: () => void }) {
  const form = useForm({ defaultValues: { description: "", firstMessage: "", mesExample: "", scenario: "", personalitySummary: "", alternateGreetings: greetings } });
  return createElement(CharacterForm, {
    form: form as never,
    avatarPreview: null,
    setAvatarPreview: () => {},
    isDirty: false,
    isSaving: false,
    avatarUrl: undefined,
    onSave: mock(),
    onReset,
    onAvatarUpload: mock(),
    onAfterImport: mock(),
    onExportJson: mock(),
    onExportPng: mock(),
    onExportVtf: mock(),
    onDuplicate: mock(),
    onDelete: mock(),
    hasAvatar: false,
    characterId: "test-character-id",
  });
}

afterEach(() => {
  trackerTemplate = null;
  getTrackerTemplate.mockReset();
  getTrackerTemplate.mockImplementation(() => Promise.resolve(trackerTemplate));
  deleteTrackerTemplate.mockReset();
  deleteTrackerTemplate.mockImplementation(async () => { trackerTemplate = null; });
});

describe("CharacterForm — tracker template summary row (CT-5)", () => {
  it("hides the row when the active version has no template", async () => {
    const { queryByText } = render(createElement(Harness, { greetings: [] }));

    await waitFor(() => expect(getTrackerTemplate).toHaveBeenCalledWith("test-character-id"));
    expect(queryByText("Tracker template")).toBeNull();
  });

  it("renders scene-only, objective-only, and combined summaries", async () => {
    trackerTemplate = makeTrackerTemplate({ sceneFieldCount: 7 });
    const scene = render(createElement(Harness, { greetings: [] }));
    expect(await scene.findByText("Scene: 7 fields")).toBeTruthy();
    scene.unmount();

    trackerTemplate = makeTrackerTemplate({ objectiveMode: "goals", objectiveCount: 3 });
    const objective = render(createElement(Harness, { greetings: [] }));
    expect(await objective.findByText("Objectives: goals mode, 3 goals")).toBeTruthy();
    objective.unmount();

    trackerTemplate = makeTrackerTemplate({ sceneFieldCount: 7, objectiveMode: "goals", objectiveCount: 3 });
    const combined = render(createElement(Harness, { greetings: [] }));
    expect(await combined.findByText("Scene: 7 fields · Objectives: goals mode, 3 goals")).toBeTruthy();
  });

  it("confirms removal, calls the DELETE client, and hides the row", async () => {
    trackerTemplate = makeTrackerTemplate({ sceneFieldCount: 1 });
    const { findByRole, getByRole, queryByText } = render(createElement(Harness, { greetings: [] }));

    await findByRole("button", { name: "Remove tracker template" });
    fireEvent.click(getByRole("button", { name: "Remove tracker template" }));
    expect(document.body.textContent).toContain("Remove tracker template?");
    fireEvent.click(dangerConfirm()!);

    await waitFor(() => expect(deleteTrackerTemplate).toHaveBeenCalledWith("test-character-id"));
    await waitFor(() => expect(queryByText("Tracker template")).toBeNull());
  });

  it("re-reads the template after the active version changes", async () => {
    trackerTemplate = makeTrackerTemplate({ sceneFieldCount: 1 });
    const onReset = mock();
    const { findByText, getByTestId } = render(createElement(Harness, { greetings: [], onReset }));

    await findByText("Scene: 1 field");
    trackerTemplate = makeTrackerTemplate({ objectiveMode: "route", objectiveCount: 2 });
    fireEvent.click(getByTestId("version-switch"));

    expect(onReset).toHaveBeenCalledTimes(1);
    await findByText("Objectives: route mode, 2 goals");
  });
});

describe("CharacterForm — alt-greeting chips delete safely (E2)", () => {
  it("✕ opens the destructive confirm; cancel keeps all greetings", () => {
    render(createElement(Harness, { greetings: ["one", "two", "three"] }));
    expect(chipRemoveButtons()).toHaveLength(3);

    fireEvent.click(chipRemoveButtons()[1]);
    // The confirm modal is open (its title is the verbatim i18n key).
    expect(document.body.textContent).toContain("alternate_greeting_delete_title");

    // Cancel → nothing deleted, modal closed.
    const cancel = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "cancel");
    fireEvent.click(cancel!);
    expect(chipRemoveButtons()).toHaveLength(3);
    expect(dangerConfirm()).toBeNull();
  });

  it("confirm removes exactly the chosen greeting and clamps the selection", () => {
    render(createElement(Harness, { greetings: ["one", "two", "three"] }));
    fireEvent.click(chipRemoveButtons()[2]); // the LAST one — selection must clamp
    const confirm = dangerConfirm();
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);
    expect(chipRemoveButtons()).toHaveLength(2);
    expect(document.body.textContent).toContain("Alt 1");
    expect(document.body.textContent).toContain("Alt 2");
    expect(dangerConfirm()).toBeNull();
  });
});
