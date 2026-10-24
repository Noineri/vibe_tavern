/** Shared media step (CA-4b0), moved from the two chat executors.
 * Callers: stream-provider-executor.ts, nonstreaming-provider-executor.ts;
 * the agent core will be the third. Describe -> persist -> downgrade ->
 * transcribe -> persist -> patch; the caller then runs the multimodal gate. */
import { modelSeesImages } from '@vibe-tavern/domain';
import type { ProviderFetch } from '../../domain/providers/provider-fetch-factory.js';
import type { ProviderExecutionInput } from './provider-execution-types.js';
import type { SdkMessage } from './provider-executor-utils.js';

export type AttachmentMediaInput = Pick<ProviderExecutionInput,
  'profile' | 'model' | 'cachedModels' | 'visionModel' | 'assetLoader' |
  'visionDescribePrompt' | 'voiceTranscriber' | 'signal' | 'onAttachmentDescriptions'>;

export async function prepareAttachmentMedia(messages: SdkMessage[], input: AttachmentMediaInput, providerFetch?: ProviderFetch) {
  // --- Vision attachment handling ---
  const hasVision = modelSeesImages(input.cachedModels, input.model);
  const visionModelSlug = input.visionModel ?? null;
  const hasAttachments = messages.some((m) => m.attachments?.length);

  let visionDescriptions: Array<{ attachmentId: string; name: string; type: "image" | "video"; description: string }> | undefined;
  const shouldDescribe = hasAttachments && visionModelSlug;

  if (shouldDescribe) {
    // Collect all image/video attachments from user messages
    const allAttachments = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.attachments ?? [])
      .filter((a) => (a.type === "image" || a.type === "video") && !a.description?.trim());
    if (allAttachments.length > 0 && input.assetLoader) {
      const { describeAttachments } = await import("./vision-gate.js");
      const descriptions = await describeAttachments(
        allAttachments,
        visionModelSlug,
        input.profile,
        input.assetLoader,
        input.visionDescribePrompt,
        input.signal,
        providerFetch,
      );
      visionDescriptions = allAttachments
        .map((att) => {
          const description = descriptions.get(att.id);
          return description
            ? { attachmentId: att.id, name: att.name, type: att.type, description }
            : null;
        })
        .filter((item): item is { attachmentId: string; name: string; type: "image" | "video"; description: string } => item !== null);

      // Always persist descriptions back to the message
      if (input.onAttachmentDescriptions && visionDescriptions.length > 0) {
        await input.onAttachmentDescriptions(visionDescriptions.map(d => ({ attachmentId: d.attachmentId, description: d.description })));
      }

      // Only replace image attachments with text when the model lacks native vision
      if (!hasVision) {
        messages = messages.map((m) => ({
          ...m,
          attachments: m.attachments?.map((att) => {
            const desc = descriptions.get(att.id);
            if (desc) {
              return { ...att, type: "file" as const, description: desc };
            }
            return att;
          }),
        }));
      }
    }
  }

  const visionGate = { hasVision, visionModel: visionModelSlug };

  // --- Voice-note transcription (STT_PLAN ST-6) ---
  // Mirror of the describe step above: voice notes are ALWAYS transcribed
  // before assembly (no capability routing — the transcript is prompt input
  // for every model). Music/ambient clips are skipped inside
  // transcribeAttachments (playback-only). Absent voiceTranscriber = no STT
  // profile configured — the undescribed note then fails at assembly with
  // VoiceTranscribeUnavailableError (the honest configuration error).
  const voiceNotes = messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.attachments ?? [])
    .filter((a) => a.type === "audio" && (a.purpose ?? "voice") === "voice" && !a.description?.trim());

  if (voiceNotes.length > 0 && input.voiceTranscriber && input.assetLoader) {
    const { transcribeAttachments } = await import("./stt-gate.js");
    const transcripts = await transcribeAttachments(voiceNotes, input.voiceTranscriber, input.assetLoader, input.signal);
    const audioDescriptions = voiceNotes
      .map((att) => {
        const transcript = transcripts.get(att.id);
        return transcript !== undefined && transcript !== ""
          ? { attachmentId: att.id, name: att.name, type: "audio" as const, description: transcript }
          : null;
      })
      .filter((item): item is { attachmentId: string; name: string; type: "audio"; description: string } => item !== null);

    // Persist transcripts through the SAME seam image descriptions use.
    if (input.onAttachmentDescriptions && audioDescriptions.length > 0) {
      await input.onAttachmentDescriptions(audioDescriptions.map((d) => ({ attachmentId: d.attachmentId, description: d.description })));
    }

    // Patch the in-memory copies so this turn's assembly sees the
    // transcripts (the DB row was written above via the callback).
    messages = messages.map((m) => ({
      ...m,
      attachments: m.attachments?.map((att) => {
        const transcript = transcripts.get(att.id);
        return transcript !== undefined ? { ...att, description: transcript } : att;
      }),
    }));
  }

  return { messages, visionGate, hasAttachments, visionDescriptions };
}
