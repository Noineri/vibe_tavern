import { beforeEach, describe, expect, it } from "bun:test";
import type { ExperienceVisualRow, ScriptRecord } from "../api/types.js";
import {
  isScriptDraftDirty,
  useScriptDraftStore,
} from "./script-draft-store.js";
import {
  duplicateVisualDraftValues,
  isExperienceVisualDraftDirty,
  useExperienceVisualDraftStore,
} from "./experience-authoring-store.js";

const script: ScriptRecord = {
  id: "script_1",
  name: "Script",
  description: "",
  code: "stored",
  scriptKind: "prompt",
  scopeType: "character",
  characterId: "character_1",
  personaId: null,
  chatId: null,
  enabled: true,
  sortOrder: 0,
  defaultVisualId: null,
};

describe("script draft store", () => {
  beforeEach(() => {
    useScriptDraftStore.getState().resetAll();
  });

  it("owns edits locally and captures one complete snapshot for explicit Save", () => {
    const store = useScriptDraftStore.getState();
    store.ensure(script);
    store.patch(script.id, { name: "Draft", code: "draft code" });

    const dirty = useScriptDraftStore.getState().drafts[script.id];
    expect(isScriptDraftDirty(dirty)).toBe(true);
    expect(dirty?.saveState).toBe("idle");

    expect(useScriptDraftStore.getState().prepareSave(script.id)).toEqual({
      name: "Draft",
      description: "",
      code: "draft code",
      enabled: true,
      scriptKind: "prompt",
    });
    expect(useScriptDraftStore.getState().drafts[script.id]?.saveState).toBe("saving");
  });

  it("does not replace a dirty buffer when fresh server records are loaded", () => {
    const store = useScriptDraftStore.getState();
    store.ensure(script);
    store.patch(script.id, { code: "local draft" });
    store.ensure({ ...script, code: "new server value" });

    const current = useScriptDraftStore.getState().drafts[script.id];
    expect(current?.values.code).toBe("local draft");
    expect(current?.base.code).toBe("stored");
    expect(isScriptDraftDirty(current)).toBe(true);
  });

  it("does not erase an edit made while Save is in flight", () => {
    const store = useScriptDraftStore.getState();
    store.ensure(script);
    store.patch(script.id, { code: "A" });
    const submitted = store.prepareSave(script.id);
    if (!submitted) throw new Error("expected dirty snapshot");

    useScriptDraftStore.getState().patch(script.id, { code: "AB" });
    expect(useScriptDraftStore.getState().drafts[script.id]?.saveState).toBe("saving");
    expect(useScriptDraftStore.getState().prepareSave(script.id)).toBeNull();

    useScriptDraftStore.getState().completeSave(
      script.id,
      submitted,
      { ...script, code: "A" },
    );

    const current = useScriptDraftStore.getState().drafts[script.id];
    expect(current?.values.code).toBe("AB");
    expect(current?.base.code).toBe("A");
    expect(current?.saveState).toBe("idle");
    expect(isScriptDraftDirty(current)).toBe(true);
  });

  it("marks an unchanged submitted snapshot saved", () => {
    const store = useScriptDraftStore.getState();
    store.ensure(script);
    store.patch(script.id, { code: "saved" });
    const submitted = store.prepareSave(script.id);
    if (!submitted) throw new Error("expected dirty snapshot");

    useScriptDraftStore.getState().completeSave(
      script.id,
      submitted,
      { ...script, code: "saved" },
    );

    const current = useScriptDraftStore.getState().drafts[script.id];
    expect(current?.values.code).toBe("saved");
    expect(current?.saveState).toBe("saved");
    expect(isScriptDraftDirty(current)).toBe(false);
  });

  it("keeps a failed snapshot dirty and retryable", () => {
    const store = useScriptDraftStore.getState();
    store.ensure(script);
    store.patch(script.id, { code: "unsaved" });
    store.prepareSave(script.id);
    store.failSave(script.id, "offline");

    const current = useScriptDraftStore.getState().drafts[script.id];
    expect(current?.values.code).toBe("unsaved");
    expect(current?.saveState).toBe("error");
    expect(current?.error).toBe("offline");
    expect(isScriptDraftDirty(current)).toBe(true);
  });

  it("invalidates interactive trust locally until the changed source is saved", () => {
    const interactive = { ...script, scriptKind: "interactive" as const };
    const store = useScriptDraftStore.getState();
    store.ensure(interactive);

    store.patch(interactive.id, { code: "changed", enabled: true });
    expect(useScriptDraftStore.getState().drafts[interactive.id]?.values.enabled).toBe(false);

    useScriptDraftStore.getState().patch(interactive.id, { enabled: true });
    expect(useScriptDraftStore.getState().drafts[interactive.id]?.values.enabled).toBe(false);

    const submitted = useScriptDraftStore.getState().prepareSave(interactive.id);
    if (!submitted) throw new Error("expected dirty snapshot");
    useScriptDraftStore.getState().completeSave(interactive.id, submitted, {
      ...interactive,
      code: "changed",
      enabled: false,
    });
    useScriptDraftStore.getState().patch(interactive.id, { enabled: true });
    expect(useScriptDraftStore.getState().drafts[interactive.id]?.values.enabled).toBe(true);
  });

  it("does not change Prompt or Dice enabled state when their source changes", () => {
    for (const scriptKind of ["prompt", "dice"] as const) {
      const record = { ...script, id: `script_${scriptKind}`, scriptKind };
      useScriptDraftStore.getState().ensure(record);
      useScriptDraftStore.getState().patch(record.id, { code: "changed" });
      expect(useScriptDraftStore.getState().drafts[record.id]?.values.enabled).toBe(true);
    }
  });
});

const visual: ExperienceVisualRow = {
  id: "xv_1",
  name: "Visual",
  source: "<main>stored</main>",
  sourceHash: "hash_stored",
  apiVersion: 1,
  compatibleManifestIds: ["round"],
  scopeType: "global",
  characterId: null,
  personaId: null,
  chatId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("experience visual draft store", () => {
  beforeEach(() => {
    useScriptDraftStore.getState().resetAll();
    useExperienceVisualDraftStore.getState().resetAll();
  });

  it("preserves dirty visual source across refetch and tracks only the persisted server hash", () => {
    const store = useExperienceVisualDraftStore.getState();
    store.ensure(visual);
    store.patch(visual.id, { source: "<main>local</main>" });
    store.ensure({ ...visual, source: "<main>remote</main>", sourceHash: "hash_remote" });

    const current = useExperienceVisualDraftStore.getState().drafts[visual.id];
    expect(current?.values.source).toBe("<main>local</main>");
    expect(current?.base.source).toBe("<main>stored</main>");
    expect(current?.sourceHash).toBe("hash_stored");
    expect(isExperienceVisualDraftDirty(current)).toBe(true);
  });

  it("preserves edits made during save and adopts the saved base hash", () => {
    const store = useExperienceVisualDraftStore.getState();
    store.ensure(visual);
    store.patch(visual.id, { source: "A" });
    const submitted = store.prepareSave(visual.id);
    if (!submitted) throw new Error("expected dirty visual snapshot");
    useExperienceVisualDraftStore.getState().patch(visual.id, { source: "AB" });
    useExperienceVisualDraftStore.getState().completeSave(visual.id, submitted, {
      ...visual,
      source: "A",
      sourceHash: "hash_a",
    });

    const current = useExperienceVisualDraftStore.getState().drafts[visual.id];
    expect(current?.values.source).toBe("AB");
    expect(current?.base.source).toBe("A");
    expect(current?.sourceHash).toBe("hash_a");
    expect(current?.saveState).toBe("idle");
    expect(isExperienceVisualDraftDirty(current)).toBe(true);
  });

  it("keeps failed visual saves dirty and retryable", () => {
    const store = useExperienceVisualDraftStore.getState();
    store.ensure(visual);
    store.patch(visual.id, { compatibleManifestIds: ["board"] });
    store.prepareSave(visual.id);
    store.failSave(visual.id, "offline");

    const current = useExperienceVisualDraftStore.getState().drafts[visual.id];
    expect(current?.values.compatibleManifestIds).toEqual(["board"]);
    expect(current?.saveState).toBe("error");
    expect(current?.error).toBe("offline");
    expect(isExperienceVisualDraftDirty(current)).toBe(true);
  });

  it("duplicates every editable visual field without sharing arrays", () => {
    const copy = duplicateVisualDraftValues(visual);
    expect(copy).toEqual({
      name: "Visual",
      source: "<main>stored</main>",
      apiVersion: 1,
      compatibleManifestIds: ["round"],
    });
    copy.compatibleManifestIds.push("board");
    expect(visual.compatibleManifestIds).toEqual(["round"]);
  });

  it("keeps rules and visual draft state independent", () => {
    const interactive = { ...script, scriptKind: "interactive" as const };
    useScriptDraftStore.getState().ensure(interactive);
    useExperienceVisualDraftStore.getState().ensure(visual);

    useScriptDraftStore.getState().patch(interactive.id, { code: "new rules" });
    const visualEntry = useExperienceVisualDraftStore.getState().drafts[visual.id];
    expect(isExperienceVisualDraftDirty(visualEntry)).toBe(false);
    expect(visualEntry?.saveState).toBe("idle");

    useExperienceVisualDraftStore.getState().patch(visual.id, { source: "new visual" });
    const rulesEntry = useScriptDraftStore.getState().drafts[interactive.id];
    expect(rulesEntry?.values.code).toBe("new rules");
    expect(rulesEntry?.saveState).toBe("idle");
  });
});
