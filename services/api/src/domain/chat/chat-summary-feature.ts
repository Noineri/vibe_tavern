import type { FeatureModule, FeatureDeps } from "../../shared/feature-module.js";
import { ChatSummaryService } from "./chat-summary-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import type { EventBus } from "@vibe-tavern/domain";
import type { AttachmentAssetLoader } from "../../infrastructure/ai/vision-gate.js";

// ────────────────────────────────────────────────────────────────────────────
// ChatSummary Feature — wraps ChatSummaryService as a FeatureModule
// ────────────────────────────────────────────────────────────────────────────
// Subscribes to "message.appended" events and triggers auto-summary.
// This replaces direct summary wiring in the shared server runtime.
// ────────────────────────────────────────────────────────────────────────────

export function createChatSummaryFeature(deps: {
  stores: StoreContainer;
  sessionRuntime: SessionRuntime;
  providerProfileService: ProviderProfileService;
  /** Typed bus the service emits background notifications onto (W7). */
  events: EventBus;
  assetLoader: AttachmentAssetLoader;
}): FeatureModule {
  const service = new ChatSummaryService(deps.stores, deps.sessionRuntime, deps.providerProfileService, deps.events, undefined, deps.assetLoader);
  let unsubscribe: (() => void) | null = null;

  return {
    id: "chat-summary",

    activate({ events }: FeatureDeps): void {
      unsubscribe = events.on("message.appended", ({ chatId }) => {
        void service.triggerAutoSummary(chatId);
      });
    },

    deactivate(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
