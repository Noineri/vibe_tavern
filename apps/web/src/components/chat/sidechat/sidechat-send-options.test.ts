import { describe, expect, it } from "bun:test";
import { getAgentHost } from "../../../lib/agent-host-registry.js";
import { SIDECHAT_AGENT_KIND } from "../../../api/agent-kind-served-modes.js";
import "./sidechat-host.js";

describe("sidechat send options", () => {
  it("carries current preset selections by identity without other links", () => {
    const options = getAgentHost(SIDECHAT_AGENT_KIND).buildSendOptions({
      owner: { kind: "chat", chatId: "chat", branchId: "branch", agentKind: SIDECHAT_AGENT_KIND },
      threadId: "thread",
      isSending: false,
      bridge: { session: null, setInputPrefill: () => {} },
      contextLinks: [
        { targetType: "prompt_preset", targetId: "preset_a" },
        { targetType: "character", targetId: "character" },
        { targetType: "prompt_preset", targetId: "preset_b" },
      ],
    });
    expect(options.promptAttachments).toEqual([{ presetId: "preset_a" }, { presetId: "preset_b" }]);
  });
});
