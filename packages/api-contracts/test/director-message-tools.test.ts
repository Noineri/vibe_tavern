/**
 * DMT-11 contracts — the Director message tools' shared schemas, the editable
 * swipe-permission answer, and the ONE permission-state decoder:
 *
 * - both proposal payloads (message-edit / message-variant) parse and reject;
 * - all three tool inputs validate;
 * - a permission Allow answer carries an optional instruction; a Deny answer
 *   carrying one is rejected; legacy answer bodies are unchanged;
 * - legacy prompt-read rows still parse (schema + decoder), and a prompt read
 *   can never decode as a swipe merely because an instruction is present.
 *
 * Imports go through the package barrel so the export wiring itself is under
 * test. Pure T0: no doubles, no globals, no I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  DIRECTOR_MESSAGE_TOOLS,
  DIRECTOR_MESSAGE_TOOL_NAMES,
  DIRECTOR_MESSAGE_RECORD_TYPES,
  proposeMessageEditInputSchema,
  proposeMessageVariantInputSchema,
  requestMessageSwipeInputSchema,
  directorMessageEditProposalSchema,
  directorMessageVariantProposalSchema,
  directorSwipePermissionMarkerSchema,
  directorSwipeGrantedReceiptSchema,
  directorSwipeDeniedReceiptSchema,
  directorSwipeToolOutputSchema,
  experienceCopilotStreamAnswerSchema,
  experienceCopilotStreamPermissionAnswerSchema,
  experienceCopilotStreamRequestSchema,
  agentPermissionStateSchema,
  agentToolActivitySchema,
  type AgentToolActivity,
  decodeAgentPermissionState,
  isAgentPermissionToolName,
  AGENT_PERMISSION_TOOL_NAMES,
} from "../src/index.js";

// ─── Tool identifiers ─────────────────────────────────────────────────────────

describe("director message tool identifiers", () => {
  test("carry the plan's wire names", () => {
    expect(DIRECTOR_MESSAGE_TOOLS.proposeMessageEdit).toBe("propose_message_edit");
    expect(DIRECTOR_MESSAGE_TOOLS.proposeMessageVariant).toBe("propose_message_variant");
    expect(DIRECTOR_MESSAGE_TOOLS.requestMessageSwipe).toBe("request_message_swipe");
    expect(DIRECTOR_MESSAGE_TOOL_NAMES).toEqual([
      "propose_message_edit",
      "propose_message_variant",
      "request_message_swipe",
    ]);
  });

  test("record types are the two reviewable payloads", () => {
    expect(DIRECTOR_MESSAGE_RECORD_TYPES.messageEdit).toBe("message-edit");
    expect(DIRECTOR_MESSAGE_RECORD_TYPES.messageVariant).toBe("message-variant");
  });
});

// ─── Tool inputs ──────────────────────────────────────────────────────────────

describe("proposeMessageEditInputSchema", () => {
  test("accepts a named source swipe", () => {
    const input = { position: 4, variant: 2, instruction: "Fix the name inconsistency" };
    expect(proposeMessageEditInputSchema.parse(input)).toEqual(input);
  });

  test("omitting the variant means the currently selected swipe", () => {
    expect(proposeMessageEditInputSchema.parse({ position: 0, instruction: "fix pose" })).toEqual({
      position: 0,
      instruction: "fix pose",
    });
  });

  test("rejects missing instruction, bad positions and bad variant numbers", () => {
    expect(() => proposeMessageEditInputSchema.parse({ position: 4 })).toThrow();
    expect(() => proposeMessageEditInputSchema.parse({ instruction: "x" })).toThrow();
    expect(() =>
      proposeMessageEditInputSchema.parse({ position: -1, instruction: "x" }),
    ).toThrow();
    expect(() =>
      proposeMessageEditInputSchema.parse({ position: 4, variant: 0, instruction: "x" }),
    ).toThrow();
    expect(() =>
      proposeMessageEditInputSchema.parse({ position: 4, variant: 1.5, instruction: "x" }),
    ).toThrow();
  });

  test("model-authored input stays lenient (extra keys stripped, not fatal)", () => {
    // The tool-input convention follows sidechatPromptReadInputSchema: the AI
    // SDK parses model output and an extra key must not crash a call.
    expect(
      proposeMessageEditInputSchema.parse({ position: 1, instruction: "x", chatter: "hi" }),
    ).toEqual({ position: 1, instruction: "x" });
  });
});

describe("proposeMessageVariantInputSchema", () => {
  test("accepts one or more source swipes with the complete text", () => {
    const input = { position: 3, sourceVariants: [1], content: "A complete alternative reply." };
    expect(proposeMessageVariantInputSchema.parse(input)).toEqual(input);
    expect(
      proposeMessageVariantInputSchema.parse({
        position: 3,
        sourceVariants: [1, 3],
        content: "Another.",
      }),
    ).toEqual({ position: 3, sourceVariants: [1, 3], content: "Another." });
  });

  test("rejects zero sources, empty content and malformed numbers", () => {
    expect(() =>
      proposeMessageVariantInputSchema.parse({ position: 3, sourceVariants: [], content: "x" }),
    ).toThrow();
    expect(() =>
      proposeMessageVariantInputSchema.parse({ position: 3, sourceVariants: [1], content: "" }),
    ).toThrow();
    expect(() =>
      proposeMessageVariantInputSchema.parse({ position: 3, sourceVariants: [0], content: "x" }),
    ).toThrow();
    expect(() =>
      proposeMessageVariantInputSchema.parse({ position: 3, sourceVariants: ["1"], content: "x" }),
    ).toThrow();
  });
});

describe("requestMessageSwipeInputSchema", () => {
  test("accepts position plus the draft instruction", () => {
    const input = { position: 5, instruction: "Regenerate with a calmer tone" };
    expect(requestMessageSwipeInputSchema.parse(input)).toEqual(input);
  });

  test("rejects a missing or empty instruction", () => {
    expect(() => requestMessageSwipeInputSchema.parse({ position: 5 })).toThrow();
    expect(() => requestMessageSwipeInputSchema.parse({ position: 5, instruction: "" })).toThrow();
  });
});

// ─── Proposal payloads (the RecordProposal payload values) ────────────────────

describe("directorMessageEditProposalSchema", () => {
  const valid = {
    source: { messageId: "m1", variantId: "v1", position: 4, variantNumber: 2 },
    sourceText: "She walked toward the door.",
    instruction: "Correct the pose: she is sitting.",
    candidate: "She sat by the door.",
    editor: { modelId: "editor-model", presetName: "Editor preset", finishReason: "stop" },
  };

  test("parses a complete payload with frozen identity, base, instruction, candidate and provenance", () => {
    expect(directorMessageEditProposalSchema.parse(valid)).toEqual(valid);
  });

  test("editor provenance requires only the model id", () => {
    expect(
      directorMessageEditProposalSchema.parse({ ...valid, editor: { modelId: "m" } }),
    ).toEqual({ ...valid, editor: { modelId: "m" } });
  });

  test("rejects empty candidate/source text and unknown keys (strict — persisted state)", () => {
    expect(() => directorMessageEditProposalSchema.parse({ ...valid, candidate: "" })).toThrow();
    expect(() => directorMessageEditProposalSchema.parse({ ...valid, sourceText: "" })).toThrow();
    expect(() =>
      directorMessageEditProposalSchema.parse({ ...valid, smuggled: true }),
    ).toThrow();
    expect(() =>
      directorMessageEditProposalSchema.parse({ ...valid, editor: { modelId: "m", bogus: 1 } }),
    ).toThrow();
    expect(() => directorMessageEditProposalSchema.parse({ ...valid, instruction: "" })).toThrow();
  });

  test("rejects a source identity missing its immutable ids", () => {
    expect(() =>
      directorMessageEditProposalSchema.parse({
        ...valid,
        source: { position: 4, variantNumber: 2 },
      }),
    ).toThrow();
  });
});

describe("directorMessageVariantProposalSchema", () => {
  const valid = {
    sources: [
      { messageId: "m1", variantId: "v1", position: 3, variantNumber: 1 },
      { messageId: "m1", variantId: "v2", position: 3, variantNumber: 2 },
    ],
    content: "The Director's complete alternative reply.",
  };

  test("parses frozen source identities plus the full candidate", () => {
    expect(directorMessageVariantProposalSchema.parse(valid)).toEqual(valid);
  });

  test("requires at least one source and rejects unknown keys (strict)", () => {
    expect(() => directorMessageVariantProposalSchema.parse({ sources: [], content: "x" })).toThrow();
    expect(() => directorMessageVariantProposalSchema.parse({ ...valid, smuggled: 1 })).toThrow();
    expect(() => directorMessageVariantProposalSchema.parse({ ...valid, content: "" })).toThrow();
  });
});

// ─── Swipe permission marker/receipts ─────────────────────────────────────────

describe("directorSwipePermissionMarkerSchema", () => {
  const marker = {
    status: "awaiting_permission",
    messageId: "m9",
    variantId: "v3",
    position: 5,
    variantNumber: 3,
    replyFirstLine: "First line of the swipe",
    instruction: "Regenerate with a calmer tone",
  } as const;

  test("parses the awaiting marker with identity, reply identification and the full instruction", () => {
    expect(directorSwipePermissionMarkerSchema.parse(marker)).toEqual(marker);
  });

  test("rejects a missing instruction, empty first line and unknown keys (strict)", () => {
    const { instruction, ...withoutInstruction } = marker;
    expect(() => directorSwipePermissionMarkerSchema.parse(withoutInstruction)).toThrow();
    expect(() =>
      directorSwipePermissionMarkerSchema.parse({ ...marker, instruction: "" }),
    ).toThrow();
    expect(() =>
      directorSwipePermissionMarkerSchema.parse({ ...marker, replyFirstLine: "" }),
    ).toThrow();
    expect(() => directorSwipePermissionMarkerSchema.parse({ ...marker, extra: 1 })).toThrow();
  });
});

describe("directorSwipeGrantedReceiptSchema", () => {
  const receipt = {
    status: "granted",
    messageId: "m9",
    variantId: "v3",
    position: 5,
    variantNumber: 3,
    replyFirstLine: "First line of the swipe",
    instruction: "The final user-approved instruction",
  } as const;

  test("carries the final user-approved instruction text", () => {
    expect(directorSwipeGrantedReceiptSchema.parse(receipt)).toEqual(receipt);
    const { instruction, ...withoutInstruction } = receipt;
    expect(() => directorSwipeGrantedReceiptSchema.parse(withoutInstruction)).toThrow();
    expect(() => directorSwipeGrantedReceiptSchema.parse({ ...receipt, instruction: "" })).toThrow();
  });
});

describe("directorSwipeDeniedReceiptSchema", () => {
  test("is exactly the split-turn mechanism's pinned denied rewrite", () => {
    expect(directorSwipeDeniedReceiptSchema.parse({ status: "denied" })).toEqual({ status: "denied" });
    expect(() => directorSwipeDeniedReceiptSchema.parse({ status: "denied", note: "x" })).toThrow();
    expect(() => directorSwipeDeniedReceiptSchema.parse({ status: "granted" })).toThrow();
  });
});

describe("directorSwipeToolOutputSchema", () => {
  test("accepts every persisted vocabulary member", () => {
    const marker = {
      status: "awaiting_permission",
      messageId: "m9",
      variantId: "v3",
      position: 5,
      variantNumber: 3,
      replyFirstLine: "Line",
      instruction: "Do it",
    } as const;
    expect(directorSwipeToolOutputSchema.parse(marker)).toEqual(marker);
    expect(
      directorSwipeToolOutputSchema.parse({ ...marker, status: "granted", instruction: "final" }),
    ).toEqual({ ...marker, status: "granted", instruction: "final" });
    expect(directorSwipeToolOutputSchema.parse({ status: "denied" })).toEqual({ status: "denied" });
  });

  test("refuses a status outside the permission vocabulary", () => {
    expect(() =>
      directorSwipeToolOutputSchema.parse({
        status: "awaiting_answer",
        messageId: "m",
        variantId: "v",
        position: 1,
        variantNumber: 1,
        replyFirstLine: "L",
        instruction: "i",
      }),
    ).toThrow();
  });
});

// ─── The editable permission answer ───────────────────────────────────────────

describe("experienceCopilotStreamPermissionAnswerSchema — editable Allow (DMT-11)", () => {
  test("an Allow answer carries the optional edited instruction", () => {
    const withInstruction = experienceCopilotStreamPermissionAnswerSchema.parse({
      toolCallId: "tc_swipe_1",
      decision: "allow",
      instruction: "Regenerate, but keep the ending",
    });
    expect(withInstruction).toEqual({
      toolCallId: "tc_swipe_1",
      decision: "allow",
      instruction: "Regenerate, but keep the ending",
    });
  });

  test("a Deny answer carrying an instruction is rejected", () => {
    expect(() =>
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_swipe_1",
        decision: "deny",
        instruction: "sneaky",
      }),
    ).toThrow(/denied permission cannot carry an instruction/i);
  });

  test("the instruction bound mirrors the ask family's text bound", () => {
    expect(() =>
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_swipe_1",
        decision: "allow",
        instruction: "",
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_swipe_1",
        decision: "allow",
        instruction: "x".repeat(50_001),
      }),
    ).toThrow();
  });

  test("legacy bodies are unchanged: bare allow/deny parse, unknown keys stay rejected", () => {
    expect(
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_perm_1",
        decision: "allow",
      }),
    ).toEqual({ toolCallId: "tc_perm_1", decision: "allow" });
    expect(
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_perm_1",
        decision: "deny",
      }),
    ).toEqual({ toolCallId: "tc_perm_1", decision: "deny" });
    expect(() =>
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_perm_1",
        decision: "allow",
        text: "why not",
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_perm_1",
        decision: "allow",
        skipped: true,
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamPermissionAnswerSchema.parse({
        toolCallId: "tc_perm_1",
        decision: "maybe",
      }),
    ).toThrow();
  });
});

describe("experienceCopilotStreamAnswerSchema — union discrimination preserved", () => {
  const base = { providerProfileId: "p1" };

  test("an editable allow parses through the request union", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_swipe_1", decision: "allow", instruction: "edited text" },
    });
    expect(parsed.answer).toEqual({
      toolCallId: "tc_swipe_1",
      decision: "allow",
      instruction: "edited text",
    });
  });

  test("ask-family bodies still parse as the ask member", () => {
    const parsed = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_1", text: "the answer" },
    });
    expect(parsed.answer).toEqual({ toolCallId: "tc_1", text: "the answer" });
    const skipped = experienceCopilotStreamRequestSchema.parse({
      ...base,
      answer: { toolCallId: "tc_1", skipped: true },
    });
    expect(skipped.answer).toEqual({ toolCallId: "tc_1", skipped: true });
  });

  test("legacy permission bodies still parse through the request union", () => {
    expect(
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        answer: { toolCallId: "tc_perm_1", decision: "deny" },
      }).answer,
    ).toEqual({ toolCallId: "tc_perm_1", decision: "deny" });
  });

  test("the ask/permission/regenerate exclusivity is preserved", () => {
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        content: "hi",
        answer: { toolCallId: "tc_1", text: "x" },
      }),
    ).toThrow();
    expect(() =>
      experienceCopilotStreamRequestSchema.parse({
        ...base,
        answer: { toolCallId: "tc_1", text: "x" },
        regenerate: true,
      }),
    ).toThrow();
  });

  test("the discriminated-by-shape union routes an instructed allow to the permission member", () => {
    const answer = experienceCopilotStreamAnswerSchema.parse({
      toolCallId: "tc_swipe_1",
      decision: "allow",
      instruction: "edited",
    });
    expect("decision" in answer && answer.decision === "allow").toBe(true);
  });
});

// ─── The ONE permission-state decoder ─────────────────────────────────────────

describe("AGENT_PERMISSION_TOOL_NAMES / isAgentPermissionToolName", () => {
  test("is the single permission-tool list", () => {
    expect(AGENT_PERMISSION_TOOL_NAMES).toEqual(["read_message_prompt", "request_message_swipe"]);
    expect(isAgentPermissionToolName("read_message_prompt")).toBe(true);
    expect(isAgentPermissionToolName("request_message_swipe")).toBe(true);
    expect(isAgentPermissionToolName("ask_user")).toBe(false);
    expect(isAgentPermissionToolName("write_buffer")).toBe(false);
  });
});

describe("decodeAgentPermissionState — legacy prompt-read rows (SC-23f)", () => {
  const MARKER = {
    status: "awaiting_permission",
    position: 7,
    variantNumber: 2,
    replyFirstLine: "First line of the swipe",
    promptTokens: 1234,
    presetName: "Preset",
  };

  test("parses the awaiting marker verbatim with the prompt_read kind", () => {
    expect(decodeAgentPermissionState("read_message_prompt", MARKER)).toEqual({
      status: "awaiting_permission",
      kind: "prompt_read",
      position: 7,
      variantNumber: 2,
      replyFirstLine: "First line of the swipe",
      promptTokens: 1234,
      presetName: "Preset",
    });
  });

  test("parses the denied rewrite (status only) and the granted rewrite (identity kept)", () => {
    expect(decodeAgentPermissionState("read_message_prompt", { status: "denied" })).toEqual({
      status: "denied",
      kind: "prompt_read",
    });
    expect(
      decodeAgentPermissionState("read_message_prompt", {
        status: "granted",
        position: 7,
        variantNumber: 2,
        replyFirstLine: "First line",
        promptTokens: 1234,
        presetName: "Preset",
      }),
    ).toEqual({
      status: "granted",
      kind: "prompt_read",
      position: 7,
      variantNumber: 2,
      replyFirstLine: "First line",
      promptTokens: 1234,
      presetName: "Preset",
    });
  });

  test("a prompt read can never become a swipe because an instruction is present", () => {
    const decoded = decodeAgentPermissionState("read_message_prompt", {
      ...MARKER,
      instruction: "sneaky",
      messageId: "m9",
      variantId: "v3",
    });
    expect(decoded).not.toBeNull();
    expect(decoded!.kind).toBe("prompt_read");
    expect("instruction" in decoded!).toBe(false);
    expect("messageId" in decoded!).toBe(false);
  });

  test("malformed prompt-read rows return null (awaiting missing its rendered fields)", () => {
    const { promptTokens, ...missingTokens } = MARKER;
    expect(decodeAgentPermissionState("read_message_prompt", missingTokens)).toBeNull();
    expect(
      decodeAgentPermissionState("read_message_prompt", { ...MARKER, replyFirstLine: "" }),
    ).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", { status: "awaiting_permission" })).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", "text")).toBeNull();
    expect(decodeAgentPermissionState("read_message_prompt", null)).toBeNull();
    expect(
      decodeAgentPermissionState("read_message_prompt", { status: "awaiting_answer" }),
    ).toBeNull();
  });
});

describe("decodeAgentPermissionState — swipe rows (DMT-11)", () => {
  const MARKER = {
    status: "awaiting_permission",
    messageId: "m9",
    variantId: "v3",
    position: 5,
    variantNumber: 3,
    replyFirstLine: "First line of the swipe",
    instruction: "Regenerate with a calmer tone",
  };

  test("decodes the awaiting marker with the swipe kind and the full instruction", () => {
    expect(decodeAgentPermissionState("request_message_swipe", MARKER)).toEqual({
      status: "awaiting_permission",
      kind: "swipe",
      messageId: "m9",
      variantId: "v3",
      position: 5,
      variantNumber: 3,
      replyFirstLine: "First line of the swipe",
      instruction: "Regenerate with a calmer tone",
    });
  });

  test("decodes the granted receipt only with the final approved instruction", () => {
    expect(
      decodeAgentPermissionState("request_message_swipe", {
        ...MARKER,
        status: "granted",
        instruction: "The final user-approved text",
      }),
    ).toEqual({
      status: "granted",
      kind: "swipe",
      messageId: "m9",
      variantId: "v3",
      position: 5,
      variantNumber: 3,
      replyFirstLine: "First line of the swipe",
      instruction: "The final user-approved text",
    });
    const { instruction, ...withoutInstruction } = MARKER;
    expect(
      decodeAgentPermissionState("request_message_swipe", {
        ...withoutInstruction,
        status: "granted",
      }),
    ).toBeNull();
  });

  test("decodes the pinned denied rewrite as a swipe", () => {
    expect(decodeAgentPermissionState("request_message_swipe", { status: "denied" })).toEqual({
      status: "denied",
      kind: "swipe",
    });
  });

  test("malformed swipe markers return null", () => {
    const { instruction, ...missingInstruction } = MARKER;
    expect(decodeAgentPermissionState("request_message_swipe", missingInstruction)).toBeNull();
    expect(
      decodeAgentPermissionState("request_message_swipe", { ...MARKER, instruction: "" }),
    ).toBeNull();
    const { variantNumber, ...missingVariant } = MARKER;
    expect(decodeAgentPermissionState("request_message_swipe", missingVariant)).toBeNull();
    expect(
      decodeAgentPermissionState("request_message_swipe", { ...MARKER, replyFirstLine: "" }),
    ).toBeNull();
    expect(decodeAgentPermissionState("request_message_swipe", 42)).toBeNull();
    expect(
      decodeAgentPermissionState("request_message_swipe", { status: "awaiting_answer" }),
    ).toBeNull();
  });
});

describe("decodeAgentPermissionState — dispatch and unknown tools", () => {
  test("an unknown tool name is not a permission tool", () => {
    expect(
      decodeAgentPermissionState("ask_user", { status: "awaiting_permission", variantNumber: 1, replyFirstLine: "L", instruction: "i" }),
    ).toBeNull();
    expect(decodeAgentPermissionState("write_buffer", { status: "granted" })).toBeNull();
  });

  test("the presentation schema accepts both families' states, legacy rows without kind included", () => {
    expect(
      agentPermissionStateSchema.parse({
        status: "granted",
        position: 1,
        variantNumber: 2,
        replyFirstLine: "Hello",
        promptTokens: 300,
        presetName: "Preset",
      }),
    ).toEqual({
      status: "granted",
      position: 1,
      variantNumber: 2,
      replyFirstLine: "Hello",
      promptTokens: 300,
      presetName: "Preset",
    });
    const swipe = agentPermissionStateSchema.parse({
      status: "awaiting_permission",
      kind: "swipe",
      messageId: "m9",
      variantId: "v3",
      variantNumber: 3,
      replyFirstLine: "Line",
      instruction: "Do it",
    });
    expect(swipe).toEqual({
      status: "awaiting_permission",
      kind: "swipe",
      messageId: "m9",
      variantId: "v3",
      variantNumber: 3,
      replyFirstLine: "Line",
      instruction: "Do it",
    });
  });

  test("a legacy persisted activity row with a kindless permission payload still parses", () => {
    const activity: AgentToolActivity = {
      toolCallId: "code",
      toolName: "write_buffer",
      status: "done",
      target: "code",
      proposed: "return 1;",
      permission: { status: "granted", position: 1, variantNumber: 2, replyFirstLine: "Hello", promptTokens: 300, presetName: "Preset" },
    };
    expect(agentToolActivitySchema.parse(activity)).toEqual(activity);
  });
});
