// fork #1 of chat-attachment-actions.ts — same service/port/executor shape.
// Agent differences: strict thread membership, compaction's profile ladder,
// and reference-aware asset cleanup (SC-20 forks share physical assets).
import type { ExperienceCopilotStore, AppDb } from '@vibe-tavern/db';
import { clearSummary, setIncluded, summarize, type AttachmentMessagePort } from '../../domain/attachment/attachment-actions-service.js';
import { resolveEffectiveSummaryProfile } from '../../domain/chat/summary-generation-seam.js';
import type { ProviderProfileService } from '../../domain/providers/provider-profile-service.js';
import { resolveProviderFetchForProfile } from '../../domain/providers/provider-fetch-factory.js';
import { nonstreamingProviderExecute } from '../../infrastructure/ai/nonstreaming-provider-executor.js';
import { buildOneShotPrompt } from '../../infrastructure/ai/one-shot-prompt.js';
import { describeAttachments, resolveVisionDescribePrompt, type AttachmentAssetLoader } from '../../infrastructure/ai/vision-gate.js';
import { notFound, validation } from '../../shared/errors.js';
import type { AttachmentSummaryExecutor } from './chat-attachment-actions.js';

export type AgentAttachmentSummaryOptions = { providerProfileId?: string; model?: string };
export type AttachmentAssetCleanup = (assetId: string) => void | Promise<void>;
/** The describe seam regenerate routes through (vision-gate's real fn). */
export type AttachmentDescribeExecutor = typeof describeAttachments;

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
  db: AppDb;
  store: ExperienceCopilotStore;
  providers?: ProviderProfileService;
  assetLoader?: AttachmentAssetLoader;
  cleanup?: AttachmentAssetCleanup;
  execute?: AttachmentSummaryExecutor;
  /** CA-4g1 test seam — the describe call regenerate routes through;
   *  production runs the real `describeAttachments`. */
  describe?: typeof describeAttachments;
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
  /** CA-4g1: the ONE profile + model ladder (body → the thread's last-used
   *  pair → the profile default, resolved onto the effective profile) shared
   *  by summarize and regenerate-description. Behavior and messages are
   *  summarize's, unchanged. */
  async function resolveProfileLadder(
    thread: { lastProviderProfileId: string | null; lastModel: string | null },
    options: AgentAttachmentSummaryOptions,
  ) {
    const providers = deps.providers;
    if (!providers) throw notFound('ProviderProfile', `Provider profile service is unavailable.`);
    const providerProfileId = (options.providerProfileId ?? thread.lastProviderProfileId ?? '').trim();
    if (!providerProfileId) throw validation('Provider profile is required to summarize the attachment (no prior turn to inherit).');
    const profile = await providers.getProviderProfile(providerProfileId);
    if (!profile) throw notFound('ProviderProfile', `Provider profile '${providerProfileId}' was not found.`);
    const model = (options.model ?? thread.lastModel ?? profile.defaultModel ?? '').trim();
    if (!model) throw validation('Select a model to summarize the attachment.');
    const effectiveProfile = await resolveEffectiveSummaryProfile(profile, model, providers);
    return { effectiveProfile, model };
  }
  return {
    async summarizeAttachment(threadId: string, messageId: string, attachmentId: string, options: AgentAttachmentSummaryOptions, signal?: AbortSignal) {
      const thread = await requireMessage(threadId, messageId);
      const { effectiveProfile, model } = await resolveProfileLadder(thread, options);
      return summarize(port, {
        messageId, attachmentId, signal, assetLoader: deps.assetLoader ?? (async () => null),
        generate: async ({ systemPrompt, text, signal }) => (await execute({
          profile: effectiveProfile, model, prompt: buildOneShotPrompt(systemPrompt, text), signal,
        })).text,
      });
    },
    async updateDescription(threadId: string, messageId: string, attachmentId: string, description: string) {
      await requireMessage(threadId, messageId);
      const updated = await deps.store.updateMessageAttachment(messageId, attachmentId, { description });
      if (!updated) throw notFound('Attachment');
      return { ok: true as const };
    },
    async regenerateDescription(threadId: string, messageId: string, attachmentId: string, options: AgentAttachmentSummaryOptions = {}, signal?: AbortSignal) {
      // CA-4g1: the chat twin's rules (chat-adapter regenerateAttachmentDescription)
      // over the agent store — except the request's abort signal reaches the
      // describe call.
      const thread = await requireMessage(threadId, messageId);
      const attachment = await deps.store.findMessageAttachment(messageId, attachmentId);
      if (!attachment) throw notFound('Attachment', `Attachment '${attachmentId}' was not found.`);
      if (attachment.type !== 'image' && attachment.type !== 'video') {
        throw validation('Only image or video attachments can be described.');
      }
      const { effectiveProfile } = await resolveProfileLadder(thread, options);
      if (!effectiveProfile.visionModel) {
        throw validation('No vision model configured in the active provider profile. Set one in Provider settings.');
      }
      const describe = deps.describe ?? describeAttachments;
      const prompt = await resolveVisionDescribePrompt(deps.db);
      const providerFetch = await resolveProviderFetchForProfile(effectiveProfile);
      const descriptions = await describe(
        [attachment],
        effectiveProfile.visionModel,
        effectiveProfile,
        deps.assetLoader ?? (async () => null),
        prompt,
        signal,
        providerFetch,
      );
      const description = descriptions.get(attachment.id)?.trim() ?? '';
      await deps.store.updateMessageAttachment(messageId, attachmentId, { description });
      return { description };
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
