/** Attachment-aware model projection for the generic agent loop (CA-4b1).
 * The existing text/tool converter is passed in so the sibling never imports
 * its parent at runtime, and attachment-free calls keep that exact projection. */
import type { ModelMessage } from 'ai';
import type { Attachment } from '@vibe-tavern/domain';
import { prepareAttachmentMedia, type AttachmentMediaInput } from '../../infrastructure/ai/attachment-media.js';
import { resolveMultimodalContent, unseenImagePolicy } from '../../infrastructure/ai/vision-gate.js';
import type { SdkMessage } from '../../infrastructure/ai/provider-executor-utils.js';
import type { ProviderFetch } from '../providers/provider-fetch-factory.js';
import type { AgentPromptMessage, AgentStreamDeps, AgentStreamStoredMessage, AgentStreamStore } from './agent-stream.js';

export type AgentVisionAssets = Pick<AttachmentMediaInput,
  'cachedModels' | 'visionModel' | 'assetLoader' | 'visionDescribePrompt' | 'voiceTranscriber'>;

/** The append port intentionally returns unknown; legacy fakes need no edits. */
function hasMessageId(value: unknown): value is { id: string } {
  return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string';
}

export async function prepareAgentModelMessages(messages: readonly AgentPromptMessage[], input: {
  profile: AttachmentMediaInput['profile'];
  model: string;
  store: Pick<AgentStreamStore, 'updateMessageAttachment'>;
  priorMessages: readonly AgentStreamStoredMessage[];
  appendedRow: unknown;
  currentAttachments?: Attachment[];
  resolveVisionAssets?: AgentStreamDeps['resolveVisionAssets'];
  providerFetch?: ProviderFetch;
  signal?: AbortSignal;
  convert: (messages: readonly AgentPromptMessage[]) => ModelMessage[];
}): Promise<ModelMessage[]> {
  const converted = input.convert(messages);
  if (!messages.some((message) => message.role === 'user' && message.attachments?.length)) return converted;

  const assets = await input.resolveVisionAssets?.(input.profile);
  const owners = new Map<string, string>();
  for (const row of input.priorMessages) {
    for (const attachment of row.attachments ?? []) owners.set(attachment.id, row.id);
  }
  if (hasMessageId(input.appendedRow)) {
    for (const attachment of input.currentAttachments ?? []) owners.set(attachment.id, input.appendedRow.id);
  }
  // The media step sees only user attachments. Non-user messages retain the
  // existing converter's tool-call/result and assistant-content behavior.
  const sdkMessages: SdkMessage[] = messages.map((message) => message.role === 'user'
    ? message : { role: 'system', content: '' });
  const media = await prepareAttachmentMedia(sdkMessages, {
    ...assets, profile: input.profile, model: input.model, signal: input.signal,
    onAttachmentDescriptions: async (descriptions) => {
      if (!input.store.updateMessageAttachment) return;
      for (const description of descriptions) {
        const messageId = owners.get(description.attachmentId);
        if (messageId !== undefined) await input.store.updateMessageAttachment(messageId, description.attachmentId, { description: description.description });
      }
    },
  }, input.providerFetch);
  const loader = assets?.assetLoader ?? (async () => null);
  return Promise.all(converted.map(async (message, index): Promise<ModelMessage> => {
    const original = messages[index];
    if (original.role !== 'user' || !original.attachments?.length) return message;
    return { role: 'user', content: await resolveMultimodalContent(media.messages[index], media.visionGate, loader, {
      unseenImagePolicy: unseenImagePolicy(messages, index),
    }) };
  }));
}
