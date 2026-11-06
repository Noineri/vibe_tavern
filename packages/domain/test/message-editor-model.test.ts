import { describe, expect, it } from "bun:test";
import { resolveMessageEditorModelPair } from "../src/message-editor-model.js";

describe("resolveMessageEditorModelPair", () => {
  it("returns the editor's own pair whole when the editor provider is set", () => {
    expect(resolveMessageEditorModelPair({
      messageEditorProviderId: "prov_editor",
      messageEditorModelName: "editor-model",
      aiAssistantProviderId: "prov_legacy",
      aiAssistantModelName: "legacy-model",
    })).toEqual({ providerId: "prov_editor", modelName: "editor-model" });
  });

  it("falls back to the legacy assistant pair whole only when no editor provider is saved", () => {
    expect(resolveMessageEditorModelPair({
      messageEditorProviderId: null,
      messageEditorModelName: null,
      aiAssistantProviderId: "prov_legacy",
      aiAssistantModelName: "legacy-model",
    })).toEqual({ providerId: "prov_legacy", modelName: "legacy-model" });
  });

  it("never mixes pairs: an editor provider keeps its own (possibly blank) model", () => {
    // The pair is taken whole — the editor's provider never borrows the
    // legacy pair's model. A blank model is returned as-is: the caller
    // (ordinary editor request or Director delegate) falls through to the
    // ordinary downstream resolution — the provider's saved default model.
    expect(resolveMessageEditorModelPair({
      messageEditorProviderId: "prov_editor",
      messageEditorModelName: "",
      aiAssistantProviderId: "prov_legacy",
      aiAssistantModelName: "legacy-model",
    })).toEqual({ providerId: "prov_editor", modelName: "" });
    expect(resolveMessageEditorModelPair({
      messageEditorProviderId: "prov_editor",
      messageEditorModelName: null,
    })).toEqual({ providerId: "prov_editor", modelName: "" });
  });

  it("passes a legacy pair with a blank model through for downstream resolution", () => {
    expect(resolveMessageEditorModelPair({
      aiAssistantProviderId: "prov_legacy",
      aiAssistantModelName: null,
    })).toEqual({ providerId: "prov_legacy", modelName: "" });
  });

  it("returns the empty pair when nothing is configured (or the source is null)", () => {
    expect(resolveMessageEditorModelPair({
      messageEditorProviderId: null,
      messageEditorModelName: null,
      aiAssistantProviderId: null,
      aiAssistantModelName: null,
    })).toEqual({ providerId: "", modelName: "" });
    expect(resolveMessageEditorModelPair({})).toEqual({ providerId: "", modelName: "" });
    expect(resolveMessageEditorModelPair(null)).toEqual({ providerId: "", modelName: "" });
  });
});
