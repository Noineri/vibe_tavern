// The sidechat's generic-loop dependency projection, extracted at the size
// cap (CA-4b2). Pressure stays a late read of the current turn's assembly.
import type { ExperienceCopilotThread } from '@vibe-tavern/db';
import type { AgentStreamDeps } from '../agent/agent-stream.js';
import type { SidechatStreamDeps } from './sidechat-stream.js';
import type { SidechatAutoCompactPressure } from './sidechat-compaction.js';

export function buildSidechatCoreDeps(deps: SidechatStreamDeps, getPressure: () => SidechatAutoCompactPressure | null): AgentStreamDeps<ExperienceCopilotThread> {
  return {
    store: deps.store,
    getProviderProfile: deps.getProviderProfile,
    getEffectiveProviderProfile: deps.getEffectiveProviderProfile,
    resolveModel: deps.resolveModel,
    // SC-8c auto-compaction: the kind's own rule — the discussion against
    // the room left after the static context and the RP layer — through the
    // sidechat compaction service, with THIS turn's assembly pressure. The
    // generic loop fires the hook fire-and-forget after the metrics persist;
    // absent service (tests, legacy harnesses) → the sidechat never
    // auto-compacts (the manual route still serves the kind).
    ...(deps.compaction !== undefined
      ? {
          autoCompact: (threadId: string) => {
            const pressure = getPressure();
            if (pressure === null) return Promise.resolve();
            return deps.compaction!.autoCompactAfterSidechatTurn(threadId, pressure);
          },
        }
      : {}),
    ...(deps.streamText !== undefined ? { streamText: deps.streamText } : {}),
    ...(deps.deleteTurn !== undefined ? { deleteTurn: deps.deleteTurn } : {}),
    ...(deps.resolveVisionAssets !== undefined ? { resolveVisionAssets: deps.resolveVisionAssets } : {}),
  };
}
