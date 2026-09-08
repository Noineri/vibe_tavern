/**
 * LorebookImportModal — single-file import lands disabled (L1e).
 *
 * A standalone world file activates nothing on arrival at the source (ST
 * parity), so mode:"new" sends `enabled: false`; the scope it lands in stays
 * the surface's current selection. Merge/replace into an existing book must
 * NOT send the flag — only the creation branch consumes it (the service
 * ignores it on merge, but the modal shouldn't emit what it doesn't mean).
 *
 * Drives the real 3-step wizard (file input → target pick → run) with the
 * app-client seam stubbed; assertions target the emitted request body.
 *
 * Runner: bun:test with scoped happy-dom (per-file process).
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import type { LorebookRecord } from "../../../app-client.js";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();

const importLorebookEntries = mock(
  async (_lorebookId: string, _body: unknown) => ({ imported: 1, skipped: 0, warnings: [] as string[] }),
);
const realAppClient = await import("../../../app-client.js");
mock.module("../../../app-client.js", () => ({
  ...realAppClient,
  importLorebookEntries,
}));

let LorebookImportModal: typeof import("./LorebookImportModal.js").LorebookImportModal;
let render: typeof import("@testing-library/react").render;
let fireEvent: typeof import("@testing-library/react").fireEvent;
beforeAll(async () => {
  ({ render, fireEvent } = await import("@testing-library/react"));
  ({ LorebookImportModal } = await import("./LorebookImportModal.js"));
});

beforeEach(() => {
  importLorebookEntries.mockClear();
});

const EXISTING: LorebookRecord = {
  id: "lb-existing",
  name: "Existing Book",
  description: "",
  scopeType: "entity",
  characterId: "char-1",
  personaId: null,
  chatId: null,
  scanDepth: 0,
  tokenBudget: 2048,
  tokenBudgetPercent: null,
  recursiveScanning: false,
  useGroupScoring: false,
  enabled: true,
};

const ST_FILE = JSON.stringify({
  name: "World",
  entries: {
    "0": { uid: 0, key: ["k"], keysecondary: [], content: "c.", comment: "" },
  },
});

function renderModal(lorebooks: LorebookRecord[] = []) {
  const onImportComplete = mock(() => {});
  const view = render(
    <LorebookImportModal
      open
      lorebooks={lorebooks}
      scope="entity"
      characterId="char-1"
      personaId={null}
      chatId={null}
      onClose={() => {}}
      onImportComplete={onImportComplete}
      t={(k) => k as string}
    />,
  );
  return { view, onImportComplete };
}

/** Same modal, opened from a persona build context (personaId set). */
function renderModalPersonaContext(lorebooks: LorebookRecord[] = []) {
  const onImportComplete = mock(() => {});
  const view = render(
    <LorebookImportModal
      open
      lorebooks={lorebooks}
      scope="entity"
      characterId="char-1"
      personaId="persona-9"
      chatId={null}
      onClose={() => {}}
      onImportComplete={onImportComplete}
      t={(k) => k as string}
    />,
  );
  return { view, onImportComplete };
}

/** Feed a JSON file through the hidden input, then advance new → next → import. */
async function importNewFile(
  view: ReturnType<typeof render>,
  fileName: string,
  contents: string,
) {
  const input = view.container.querySelector("input[type='file']");
  if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
  const file = new File([contents], fileName, { type: "application/json" });
  // happy-dom exposes `files` as a read-only getter — assign it as an own
  // property, then dispatch the change event (fireEvent's target assignment
  // cannot write a FileList).
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);

  // Step 2 (FileReader is async) → keep "create new" → step 3 → run.
  await view.findByText("import_next");
  fireEvent.click(view.getByText("import_next"));
  await view.findByText("import_btn");
  fireEvent.click(view.getByText("import_btn"));
  await view.findByText("import_btn"); // run is async; settle before asserting
}

describe("LorebookImportModal — disabled-on-arrival (L1e)", () => {
  it("mode:new sends enabled:false and keeps the surface scope + owner", async () => {
    const { view } = renderModal();
    await importNewFile(view, "world.json", ST_FILE);

    expect(importLorebookEntries).toHaveBeenCalledTimes(1);
    const [lorebookId, body] = importLorebookEntries.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(lorebookId).toBe("new");
    expect(body.mode).toBe("new");
    expect(body.enabled).toBe(false);
    // The scope it lands in stays the surface's current selection.
    expect(body.scopeType).toBe("entity");
    expect(body.characterId).toBe("char-1");
    expect(body.fallbackName).toBe("world");
  });

  it("mode:new from a persona context lands entity homed to the persona", async () => {
    const { view } = renderModalPersonaContext();
    await importNewFile(view, "world.json", ST_FILE);

    expect(importLorebookEntries).toHaveBeenCalledTimes(1);
    const [, body] = importLorebookEntries.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body.scopeType).toBe("entity");
    // Exactly one typed owner FK — the persona context owns the import.
    expect(body.personaId).toBe("persona-9");
    expect(body.characterId).toBeUndefined();
  });

  it("merge into an existing book sends no enabled flag", async () => {
    const { view } = renderModal([EXISTING]);
    const input = view.container.querySelector("input[type='file']");
    if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
    const file = new File([ST_FILE], "world.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);

    await view.findByText("import_next");
    // Pick the existing book → switches to merge mode.
    fireEvent.click(view.getByText("Existing Book"));
    fireEvent.click(view.getByText("import_next"));
    await view.findByText("import_btn");
    fireEvent.click(view.getByText("import_btn"));
    await view.findByText("import_btn");

    expect(importLorebookEntries).toHaveBeenCalledTimes(1);
    const [lorebookId, body] = importLorebookEntries.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(lorebookId).toBe("lb-existing");
    expect(body.mode).toBe("merge");
    expect("enabled" in body).toBe(false);
  });
});
