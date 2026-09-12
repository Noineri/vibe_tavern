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
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { useForm } = await import("react-hook-form");

// useT at the module boundary — keys verbatim so assertions match.
const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// CustomTooltip needs a Radix provider context irrelevant to this pin.
const realTooltip = await import("../../shared/Tooltip.js");
mock.module("../../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

// CharacterForm renders BoundResourcesField / GalleryAccordion, which fetch
// the lorebook / persona / script lists on mount; stub them empty so the
// render never hits the network (mirrors CoauthorCharacterForm.test.tsx).
const realLorebookApi = await import("../../../api/lorebook-api.js");
mock.module("../../../api/lorebook-api.js", () => ({
  ...realLorebookApi,
  listAllLorebooks: () => Promise.resolve([]),
}));
const realPersonaApi = await import("../../../api/persona-api.js");
mock.module("../../../api/persona-api.js", () => ({
  ...realPersonaApi,
  listPersonas: () => Promise.resolve([]),
}));
const realScriptApi = await import("../../../api/script-api.js");
mock.module("../../../api/script-api.js", () => ({
  ...realScriptApi,
  listAllScripts: () => Promise.resolve([]),
}));

// CE-C2/C3-style: the binding field reads/writes lorebook/script/regex
// bindings through app-client — stub those to empty so the render stays
// offline (mirrors CoauthorCharacterForm.test.tsx).
const realAppClient = await import("../../../app-client.js");
mock.module("../../../app-client.js", () => ({
  ...realAppClient,
  listAllLorebooks: () => Promise.resolve([]),
  listCharacterLorebooks: () => Promise.resolve([]),
  listPersonaLorebooks: () => Promise.resolve([]),
  getLorebookLinks: () => Promise.resolve([]),
  setLorebookLinks: () => Promise.resolve([]),
  listAllScripts: () => Promise.resolve([]),
  listCharacterScripts: () => Promise.resolve([]),
  listPersonaScripts: () => Promise.resolve([]),
  getScriptLinks: () => Promise.resolve([]),
  setScriptLinks: () => Promise.resolve([]),
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

function Harness({ greetings }: { greetings: string[] }) {
  const form = useForm({ defaultValues: { description: "", firstMessage: "", mesExample: "", scenario: "", personalitySummary: "", alternateGreetings: greetings } });
  return createElement(CharacterForm, {
    form: form as never,
    avatarPreview: null,
    setAvatarPreview: () => {},
    isDirty: false,
    isSaving: false,
    avatarUrl: undefined,
    onSave: mock(),
    onReset: mock(),
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
