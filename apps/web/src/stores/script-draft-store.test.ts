import { beforeEach, describe, expect, it } from "vitest";
import type { ScriptRecord } from "../api/types.js";
import {
  isScriptDraftDirty,
  useScriptDraftStore,
} from "./script-draft-store.js";

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
});
