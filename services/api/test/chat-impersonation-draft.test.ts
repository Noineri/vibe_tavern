import { describe, expect, it } from "bun:test";
import { getModeConfig } from "../src/domain/ai-assistant/ai-assistant-modes.js";
import {
  buildUserMessage,
  getChatImpersonatePromptKey,
} from "../src/domain/ai-assistant/ai-assistant-stream.js";
import { SERVICE_PROMPT_ASSET_FILES } from "../src/domain/service-prompts/service-prompt-registry.js";

const baseRequest = {
  mode: "chat_impersonate" as const,
  instruction: "Write the next message as the current persona.",
  providerProfileId: "profile_1",
  enabledLayers: [],
};

describe("chat impersonation draft", () => {
  it("seeds the persona message from a non-empty draft", () => {
    const message = buildUserMessage({
      ...baseRequest,
      draftText: "*I look away.* Fine.",
    }, getModeConfig("chat_impersonate"));

    expect(message).toBe("Write the next message as the current persona.\n\nBuild on this draft as the persona would write it:\n\n*I look away.* Fine.");
  });

  it("uses the enhance service prompt only when enhancement has a draft to improve", () => {
    expect(getChatImpersonatePromptKey({ ...baseRequest, draftText: "draft", enhanceDraft: true })).toBe("chat_impersonate_enhance");
    expect(getChatImpersonatePromptKey({ ...baseRequest, draftText: "", enhanceDraft: true })).toBe("chat_impersonate");
    expect(getChatImpersonatePromptKey({ ...baseRequest, draftText: "draft", enhanceDraft: false })).toBe("chat_impersonate");
  });

  it("registers the editable enhance prompt asset", () => {
    expect(SERVICE_PROMPT_ASSET_FILES.chat_impersonate_enhance).toBe("chat-impersonate-enhance-ai-prompt.md");
  });
});
