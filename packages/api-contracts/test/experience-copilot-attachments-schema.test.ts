import { describe, expect, test } from "bun:test";
import type { Attachment } from "@vibe-tavern/domain";
import {
  experienceCopilotMessageSchema,
  experienceCopilotStreamRequestSchema,
  type ExperienceCopilotMessageWire,
} from "../src/schemas/experience-copilot-schema.js";

// T0: real schemas, no doubles, global state, paths, waits or database setup.
const message = {
  id: "message_1", threadId: "thread_1", role: "user", content: "Read this",
  toolCallsJson: null, toolCallId: null, reasoning: null,
  reasoningDurationMs: null, createdAt: "2026-10-24T00:00:00.000Z",
};
const attachment: Attachment = {
  id: "file_1", assetId: "asset_1", type: "file", name: "notes.md",
  mimeType: "text/markdown", sizeBytes: 12, tokenCount: 1200,
};

describe("agent attachment contracts (CA-4a1)", () => {
  test("legacy turn-mode bodies and every refine message stay byte-identical", () => {
    for (const content of [undefined, "Hello"]) {
      for (const answer of [undefined, { toolCallId: "call_1", text: "Yes" }, { toolCallId: "call_1", decision: "allow" }]) {
        for (const regenerate of [undefined, false, true]) {
          const body = {
            providerProfileId: "profile_1",
            ...(content !== undefined ? { content } : {}),
            ...(answer !== undefined ? { answer } : {}),
            ...(regenerate !== undefined ? { regenerate } : {}),
          };
          const modes = [content !== undefined && "`content`", answer !== undefined && "`answer`", regenerate === true && "`regenerate`"].filter(Boolean);
          const result = experienceCopilotStreamRequestSchema.safeParse(body);
          if (modes.length === 1) {
            expect(result.success).toBe(true);
            if (result.success) expect(result.data).toEqual(body);
          } else {
            expect(result.success).toBe(false);
            if (!result.success) expect(result.error.issues).toEqual([{
              code: "custom", path: [],
              message: modes.length === 0
                ? "Provide either `content` (a new message), `answer` (answering the pending question), or `regenerate` (rerunning the last turn)."
                : `Provide only one turn mode — got ${modes.join(" + ")}; \`content\` (a new message), \`answer\` (answering the pending question), and \`regenerate\` (rerunning the last turn) are mutually exclusive.`,
            }]);
          }
        }
      }
    }
  });

  test("a legacy message stays byte-identical with no attachments key", () => {
    const parsed = experienceCopilotMessageSchema.parse(message);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(message));
    expect(Object.hasOwn(parsed, "attachments")).toBe(false);
  });

  test("attachment-only turns are accepted without inventing content", () => {
    const body = { providerProfileId: "profile_1", attachments: [attachment] };
    const parsed = experienceCopilotStreamRequestSchema.parse(body);
    expect(parsed).toEqual(body);
    expect(Object.hasOwn(parsed, "content")).toBe(false);
    expect(experienceCopilotStreamRequestSchema.parse({ ...body, regenerate: false })).toEqual({ ...body, regenerate: false });
  });

  test("content plus attachments is one valid content mode", () => {
    const body = { providerProfileId: "profile_1", content: "Read this", attachments: [attachment] };
    expect(experienceCopilotStreamRequestSchema.parse(body)).toEqual(body);
  });

  test("attachments with an answer are refused with the attachment-only mode label", () => {
    for (const answer of [{ toolCallId: "call_1", text: "Yes" }, { toolCallId: "call_1", decision: "allow" }]) {
      const result = experienceCopilotStreamRequestSchema.safeParse({ providerProfileId: "profile_1", attachments: [attachment], answer });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual([{
        code: "custom", path: [],
        message: "Provide only one turn mode — got `attachments` + `answer`; `content` (a new message), `answer` (answering the pending question), and `regenerate` (rerunning the last turn) are mutually exclusive.",
      }]);
    }
  });

  test("attachments with regenerate:true are refused with the attachment-only mode label", () => {
    const result = experienceCopilotStreamRequestSchema.safeParse({ providerProfileId: "profile_1", attachments: [attachment], regenerate: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([{
      code: "custom", path: [],
      message: "Provide only one turn mode — got `attachments` + `regenerate`; `content` (a new message), `answer` (answering the pending question), and `regenerate` (rerunning the last turn) are mutually exclusive.",
    }]);
  });

  test("content keeps its original mode label even when attachments are also present", () => {
    const result = experienceCopilotStreamRequestSchema.safeParse({
      providerProfileId: "profile_1", content: "Read this", attachments: [attachment],
      answer: { toolCallId: "call_1", text: "Yes" }, regenerate: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(
      "Provide only one turn mode — got `content` + `answer` + `regenerate`; `content` (a new message), `answer` (answering the pending question), and `regenerate` (rerunning the last turn) are mutually exclusive.",
    );
  });

  test("an empty attachment array alone retains the existing no-mode message", () => {
    const result = experienceCopilotStreamRequestSchema.safeParse({ providerProfileId: "profile_1", attachments: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([{
      code: "custom", path: [],
      message: "Provide either `content` (a new message), `answer` (answering the pending question), or `regenerate` (rerunning the last turn).",
    }]);
  });

  test("an empty attachment array does not add a mode to content, answer or regenerate", () => {
    for (const mode of [{ content: "Hello" }, { answer: { toolCallId: "call_1", text: "Yes" } }, { regenerate: true }]) {
      const body = { providerProfileId: "profile_1", attachments: [], ...mode };
      expect(experienceCopilotStreamRequestSchema.parse(body)).toEqual(body);
    }
  });

  test("the shared send schema accepts five attachments and rejects six and invalid entries", () => {
    const body = { providerProfileId: "profile_1", attachments: Array.from({ length: 5 }, (_, index) => ({ ...attachment, id: `file_${index}` })) };
    expect(experienceCopilotStreamRequestSchema.parse(body)).toEqual(body);
    expect(experienceCopilotStreamRequestSchema.safeParse({ ...body, attachments: [...body.attachments, attachment] }).success).toBe(false);
    expect(experienceCopilotStreamRequestSchema.safeParse({ ...body, attachments: [{ ...attachment, id: "" }] }).success).toBe(false);
    expect(experienceCopilotStreamRequestSchema.safeParse({ ...body, attachments: [{ ...attachment, tokenCount: -1 }] }).success).toBe(false);
  });

  test("a message preserves the full domain attachments, not just the send subset", () => {
    const stored: Attachment = { ...attachment, description: "Summary", summaryTokenCount: 20, includeInPrompt: false };
    const image: Attachment = {
      ...attachment, id: "image_1", type: "image", mimeType: "image/png", name: "portrait.png",
      imageGen: { mode: "portrait", profileId: "profile_1", prompt: "A tower", params: { seed: 7 } },
    };
    const audio: Attachment = { ...attachment, id: "audio_1", type: "audio", mimeType: "audio/webm", purpose: "voice", durationMs: 4200 };
    const body = { ...message, attachments: [stored, image, audio] };
    const parsed = experienceCopilotMessageSchema.parse(body);
    expect(parsed).toEqual(body);
    // Compile-time equality pins the inferred element, not merely assignability.
    type Element = NonNullable<ExperienceCopilotMessageWire["attachments"]>[number];
    type Same = (<T>() => T extends Element ? 1 : 2) extends (<T>() => T extends Attachment ? 1 : 2) ? true : false;
    const same: Same = true;
    expect(same).toBe(true);
  });
});
