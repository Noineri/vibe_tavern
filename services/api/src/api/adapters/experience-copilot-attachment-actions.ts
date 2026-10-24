// fork #1 of chat-attachment-actions.ts — same service/port/executor shape.
// Agent differences: strict thread membership, compaction's profile ladder,
// and reference-aware asset cleanup (SC-20 forks share physical assets).
import type { ExperienceCopilotStore } from '@vibe-tavern/db';
import { clearSummary, setIncluded, summarize, type AttachmentMessagePort } from '../../domain/attachment/attachment-actions-service.js';
import { resolveEffectiveSummaryProfile } from '../../domain/chat/summary-generation-seam.js';
import type { ProviderProfileService } from '../../domain/providers/provider-profile-service.js';
import { nonstreamingProviderExecute } from '../../infrastructure/ai/nonstreaming-provider-executor.js';
import { buildOneShotPrompt } from '../../infrastructure/ai/one-shot-prompt.js';
import type { AttachmentAssetLoader } from '../../infrastructure/ai/vision-gate.js';
import { notFound, validation } from '../../shared/errors.js';
import type { AttachmentSummaryExecutor } from './chat-attachment-actions.js';

export type AgentAttachmentSummaryOptions = { providerProfileId?: string; model?: string };
export type AttachmentAssetCleanup = (assetId: string) => void | Promise<void>;

/** One cleanup path for attachment delete and turn delete (CA-4d2). */
export async function cleanupUnreferencedAgentAssets(
  store: Pick<ExperienceCopilotStore, 'hasMessageAttachmentAssetReference'>,
  assetIds: readonly string[],
  cleanup?: AttachmentAssetCleanup,
): Promise<void> {
  if (!cleanup) return;
  for (const assetId of new Set(assetIds)) {
    if (!await store.hasMessageAttachmentAssetReference(assetId)) await cleanup(assetId);
  }
}

export function createAgentAttachmentActions(deps: {
  store: ExperienceCopilotStore;
  providers?: ProviderProfileService;
  assetLoader?: AttachmentAssetLoader;
  cleanup?: AttachmentAssetCleanup;
  execute?: AttachmentSummaryExecutor;
}) {
  const port: AttachmentMessagePort = {
    find: (messageId, attachmentId) => deps.store.findMessageAttachment(messageId, attachmentId),
    update: async (messageId, attachmentId, patch) => {
      const attachment = await deps.store.updateMessageAttachment(messageId, attachmentId, patch);
      if (!attachment) throw notFound('Attachment');
      return attachment;
    },
  };
  const execute = deps.execute ?? nonstreamingProviderExecute;
  async function requireMessage(threadId: string, messageId: string) {
    const thread = await deps.store.getById(threadId);
    if (!thread) throw notFound('ExperienceCopilotThread', `Copilot thread '${threadId}' was not found.`);
    if (!(await deps.store.listMessages(threadId)).some((message) => message.id === messageId)) throw notFound('Message');
    return thread;
  }
  return {
    async summarizeAttachment(threadId: string, messageId: string, attachmentId: string, options: AgentAttachmentSummaryOptions, signal?: AbortSignal) {
      const thread = await requireMessage(threadId, messageId);
      const providers = deps.providers;
      if (!providers) throw notFound('ProviderProfile', `Provider profile service is unavailable.`);
      const providerProfileId = (options.providerProfileId ?? thread.lastProviderProfileId ?? '').trim();
      if (!providerProfileId) throw validation('Provider profile is required to summarize the attachment (no prior turn to inherit).');
      const profile = await providers.getProviderProfile(providerProfileId);
      if (!profile) throw notFound('ProviderProfile', `Provider profile '${providerProfileId}' was not found.`);
      const model = (options.model ?? thread.lastModel ?? profile.defaultModel ?? '').trim();
      if (!model) throw validation('Select a model to summarize the attachment.');
      const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, providers);
      return summarize(port, {
        messageId, attachmentId, signal, assetLoader: deps.assetLoader ?? (async () => null),
        generate: async ({ systemPrompt, text, signal }) => (await execute({
          profile: effectiveProfile, model, prompt: buildOneShotPrompt(systemPrompt, text), signal,
        })).text,
      });
    },
    async clearAttachmentSummary(threadId: string, messageId: string, attachmentId: string) {
      await requireMessage(threadId, messageId);
      return clearSummary(port, { messageId, attachmentId });
    },
    async setIncluded(threadId: string, messageId: string, attachmentId: string, included: boolean) {
      await requireMessage(threadId, messageId);
      await setIncluded(port, { messageId, attachmentId, included });
      return { ok: true as const };
    },
    async deleteAttachment(threadId: string, messageId: string, attachmentId: string) {
      await requireMessage(threadId, messageId);
      const attachment = await deps.store.removeMessageAttachment(messageId, attachmentId);
      if (attachment) await cleanupUnreferencedAgentAssets(deps.store, [attachment.assetId], deps.cleanup);
      return { ok: true as const };
    },
  };
}
