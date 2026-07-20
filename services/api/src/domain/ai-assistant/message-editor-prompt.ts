import type { MessageVariant } from "@vibe-tavern/db";

export type MessageEditorPromptMode = "message_edit" | "message_merge";

export type MessageEditorPromptInvariant =
  | "edit_source_count"
  | "merge_source_count"
  | "source_message_owner"
  | "unsupported_mode";

export class MessageEditorPromptInvariantError extends Error {
  constructor(readonly invariant: MessageEditorPromptInvariant) {
    super(`Message editor prompt invariant failed: ${invariant}`);
    this.name = "MessageEditorPromptInvariantError";
  }
}

export type MessageEditorPromptSource = Readonly<Pick<
  MessageVariant,
  | "id"
  | "messageId"
  | "variantIndex"
  | "content"
  | "finishReason"
  | "reasoning"
  | "modelId"
  | "presetId"
  | "createdAt"
  | "sceneTracker"
>> & {
  readonly presetName: string | null;
};

export interface ComposeMessageEditorPromptInput {
  readonly mode: MessageEditorPromptMode;
  readonly targetMessageId: string;
  readonly resolvedModePrompt: string;
  readonly sources: readonly MessageEditorPromptSource[];
  readonly userInstruction: string;
}

function assertNever(value: never): never {
  void value;
  throw new MessageEditorPromptInvariantError("unsupported_mode");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function metadataValue(value: string | null): string {
  return escapeXml(value ?? "null");
}

function validateOperation(input: ComposeMessageEditorPromptInput): void {
  switch (input.mode) {
    case "message_edit":
      if (input.sources.length !== 1) {
        throw new MessageEditorPromptInvariantError("edit_source_count");
      }
      break;
    case "message_merge":
      if (input.sources.length < 2) {
        throw new MessageEditorPromptInvariantError("merge_source_count");
      }
      break;
    default:
      assertNever(input.mode);
  }

  for (const source of input.sources) {
    if (source.messageId !== input.targetMessageId) {
      throw new MessageEditorPromptInvariantError("source_message_owner");
    }
  }
}

function formatSource(source: MessageEditorPromptSource): string {
  const attributes = [
    `variant-id="${escapeXml(source.id)}"`,
    `display-number="${source.variantIndex + 1}"`,
    `model-id="${metadataValue(source.modelId)}"`,
    `preset-id="${metadataValue(source.presetId)}"`,
    `preset-name="${metadataValue(source.presetName)}"`,
    `finish-reason="${metadataValue(source.finishReason)}"`,
    `created-at="${escapeXml(source.createdAt)}"`,
  ].join(" ");
  return [
    `<message-editor-source ${attributes}>`,
    "<visible-content>",
    escapeXml(source.content),
    "</visible-content>",
    "</message-editor-source>",
  ].join("\n");
}

export function composeMessageEditorPrompt(input: ComposeMessageEditorPromptInput): string {
  validateOperation(input);
  const sourceBlocks = [...input.sources]
    .sort((left, right) => left.variantIndex - right.variantIndex)
    .map(formatSource)
    .join("\n\n");
  return [
    input.resolvedModePrompt,
    `<message-editor-sources>\n${sourceBlocks}\n</message-editor-sources>`,
    `<message-editor-instruction>\n${input.userInstruction}\n</message-editor-instruction>`,
  ].join("\n\n");
}
