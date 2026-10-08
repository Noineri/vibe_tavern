import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import { serializeStPreset } from "@vibe-tavern/import-export";
import type { PromptPresetDto } from "@vibe-tavern/domain";
import type { PresetImportResult } from "./preset-import-flow.js";

useDomEnv();

const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile: () => true,
}));

let PresetImportModal: typeof import("./PresetImportModal.js").PresetImportModal;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let waitFor: typeof import("@testing-library/react").waitFor;

beforeAll(async () => {
  ({ render, fireEvent, waitFor } = await import("@testing-library/react"));
  ({ PresetImportModal } = await import("./PresetImportModal.js"));
});

function presetFile(blockContent: string): File {
  return new File(
    [
      JSON.stringify({
        name: "Probe preset",
        prompts: [
          {
            identifier: "main",
            name: "Main",
            role: "system",
            content: blockContent,
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            enabled: true,
          },
        ],
      }),
    ],
    "probe-preset.json",
    { type: "application/json" },
  );
}

/** One ST regex script with an explicit source state (RXU-11 source
 *  fidelity: `disabled` mirrors the source exactly). */
function stRegexScript(scriptName: string, disabled: boolean) {
  return { scriptName, findRegex: "/x/g", replaceString: "", disabled };
}

/** ST preset embedding three rules with MIXED source states (2 on, 1 off). */
function presetFileWithRegex(): File {
  return new File(
    [
      JSON.stringify({
        name: "Regex bundle preset",
        prompts: [
          {
            identifier: "main",
            name: "Main",
            role: "system",
            content: "System text",
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            enabled: true,
          },
        ],
        extensions: {
          regex_scripts: [
            stRegexScript("On rule", false),
            stRegexScript("Off rule", true),
            stRegexScript("Second on", false),
          ],
        },
      }),
    ],
    "regex-preset.json",
    { type: "application/json" },
  );
}

/** VT-native export (full DTO under `_vibe_tavern`) that ALSO embeds one
 *  disabled regex rule — built with the real serializer so the fixture rides
 *  the real export shape. */
function vtPresetFileWithRegex(): File {
  const dto: PromptPresetDto = {
    id: "vt-1",
    name: "VT source",
    system: "sys",
    jailbreak: "jb",
    prefill: "",
    authorsNote: "",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
    summary: "",
    tools: "",
    nsfw: "",
    enhanceDefinitions: "",
    scriptAiSystemPrompt: "",
    aiAssistantPrompts: "{}",
    customInjections: [],
    promptOrder: [],
    advancedMode: true,
    mergeConsecutiveRoles: false,
    perSendPrefillEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const json = serializeStPreset(dto, [{
    name: "VT rule",
    findRegex: "/y/g",
    replaceString: "",
    trimStrings: [],
    substituteRegex: 0,
    disabled: true,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    isGlobal: false,
    sortOrder: 0,
    profileId: null,
  }]);
  return new File([json], "vt-preset.json", { type: "application/json" });
}

/** Drive one import: open the preview with `file`, wait for its summary
 *  line, optionally flip the enable toggle, click confirm, return the result. */
async function importViaModal(
  file: File,
  previewName: string,
  options: { enableProfile?: boolean } = {},
): Promise<PresetImportResult> {
  let captured: PresetImportResult | undefined;
  const view = render(
    <PresetImportModal initialFile={file} onClose={() => {}} onImport={(result) => { captured = result; }} />,
  );
  await view.findByText(`${previewName}.json`);
  if (options.enableProfile) {
    fireEvent.click(view.getByRole("switch", { name: "regexImport.enableAfterImport" }));
  }
  fireEvent.click(view.getByText("preset_import_btn"));
  await waitFor(() => expect(captured).toBeDefined());
  return captured!;
}

describe("PresetImportModal", () => {
  it("opens the fullscreen preview directly when the mobile picker supplies a file", async () => {
    const file = new File([
      JSON.stringify({ name: "Mobile preset", prompts: [] }),
    ], "mobile-preset.json", { type: "application/json" });
    const view = render(
      <PresetImportModal initialFile={file} onClose={() => {}} onImport={() => {}} />,
    );

    expect(await view.findByText("Mobile preset.json")).toBeTruthy();
    expect(view.queryByText("preset_import_drop_title")).toBeNull();
  });
  // st-macro-parity step 8: importing a preset that uses an ST macro VT
  // deliberately does not support shows the import warning in the preview.
  it("shows the dropped-macro warning for a preset block using {{wiBefore}}", async () => {
    const view = render(
      <PresetImportModal
        initialFile={presetFile("Prefix {{wiBefore}} suffix")}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    expect(
      await view.findByText(
        "Macro {{wiBefore}} is not supported in VT — use preset layers and the generation format instead.",
      ),
    ).toBeTruthy();
  });

  it("shows no dropped-macro warning for a preset using only supported macros", async () => {
    const view = render(
      <PresetImportModal
        initialFile={presetFile("{{trim}} {{user}} said {{pick::a::b}}")}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    expect(await view.findByText("Probe preset.json")).toBeTruthy();
    expect(view.queryByText(/is not supported in VT/)).toBeNull();
  });
});

// RXU-21: the embedded-Regex preview card + the regex fields carried through
// PresetImportResult (the modal previously parsed regexScripts but DROPPED
// them from the result — pinned here after the fix; the count derivation
// itself is pinned on summarizeRegexImportRules in PromptManagerModal.test).
describe("PresetImportModal — embedded Regex profile card (RXU-21)", () => {
  it("renders NO card when the file embeds no rules and carries an empty, default-off regex result", async () => {
    // Card absence BEFORE confirming, then the confirmed result — one modal
    // for the whole test (a stacked second modal gets aria-hidden by Radix).
    let captured: PresetImportResult | undefined;
    const view = render(
      <PresetImportModal
        initialFile={presetFile("plain")}
        onClose={() => {}}
        onImport={(result) => { captured = result; }}
      />,
    );
    await view.findByText("Probe preset.json");
    expect(view.queryByText("regexImport.cardTitle")).toBeNull();
    expect(view.queryByRole("switch")).toBeNull();
    fireEvent.click(view.getByText("preset_import_btn"));
    await waitFor(() => expect(captured).toBeDefined());

    // The result still carries the fields (empty) — every consumer reads one
    // shape, and zero rules means the consumer makes zero regex API calls.
    expect(captured!.regexScripts).toEqual([]);
    expect(captured!.enableRegexProfile).toBe(false);
    expect(captured!.regexProfileName).toBe("Probe preset");
  });

  it("renders the one-Profile card with a default-OFF enable toggle and no card without rules", async () => {
    const withRules = render(
      <PresetImportModal initialFile={presetFileWithRegex()} onClose={() => {}} onImport={() => {}} />,
    );
    expect(await withRules.findByText("Regex bundle preset.json")).toBeTruthy();

    // Card: title, fixed scope label, derived profile name, summary counts.
    expect(withRules.getByText("regexImport.cardTitle")).toBeTruthy();
    expect(withRules.getByText("regexImport.scopePreset")).toBeTruthy();
    expect(withRules.getByText("Regex bundle preset")).toBeTruthy();
    expect(withRules.getByText("regexImport.profileSummary")).toBeTruthy();
    // The master toggle exists and is OFF by default (the owner's
    // default-off decision, quoted verbatim in the plan).
    const toggle = withRules.getByRole("switch", { name: "regexImport.enableAfterImport" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    // Optional information-only disclosure: rule names + source states.
    fireEvent.click(withRules.getByText("regexImport.showRules"));
    for (const name of ["On rule", "Off rule", "Second on"]) {
      expect(withRules.getByText(name)).toBeTruthy();
    }
    const dots = ["On rule", "Off rule", "Second on"].map(
      (name) => withRules.getByText(name).closest("li")!.querySelector("div")!.className,
    );
    expect(dots[0]).toContain("bg-accent");
    expect(dots[1]).toContain("bg-t4");
    expect(dots[2]).toContain("bg-accent");
    // Collapse hides the names again.
    fireEvent.click(withRules.getByText("regexImport.hideRules"));
    expect(withRules.queryByText("Off rule")).toBeNull();
  });

  it("carries source-faithful rules + toggle OFF (default) through the result", async () => {
    const result = await importViaModal(presetFileWithRegex(), "Regex bundle preset");

    expect(result.regexScripts.map((rule) => rule.name)).toEqual(["On rule", "Off rule", "Second on"]);
    // Source states preserved verbatim (RXU-11) — no force-disable pass.
    expect(result.regexScripts.map((rule) => rule.disabled)).toEqual([false, true, false]);
    expect(result.enableRegexProfile).toBe(false);
    expect(result.regexProfileName).toBe("Regex bundle preset");
  });

  it("carries the enable toggle ON when the user flips it before confirming", async () => {
    const result = await importViaModal(presetFileWithRegex(), "Regex bundle preset", { enableProfile: true });

    expect(result.enableRegexProfile).toBe(true);
    expect(result.regexScripts).toHaveLength(3);
  });

  it("carries rules through the _vibe_tavern (native) import path too", async () => {
    const result = await importViaModal(vtPresetFileWithRegex(), "VT source");

    // The lossless VT branch forwards the full DTO AND the embedded rules —
    // both import paths create their Profile through the same consumer.
    expect(result.vibeTavern).toBeDefined();
    expect(result.vibeTavern?.name).toBe("VT source");
    expect(result.regexScripts.map((rule) => rule.name)).toEqual(["VT rule"]);
    expect(result.regexScripts[0]!.disabled).toBe(true);
    expect(result.enableRegexProfile).toBe(false);
  });
});
