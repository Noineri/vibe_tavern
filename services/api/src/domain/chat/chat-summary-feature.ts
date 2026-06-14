import type { FeatureModule, FeatureDeps } from "../../shared/feature-module.js";
import { ChatSummaryService } from "./chat-summary-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";

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
}): FeatureModule {
  const service = new ChatSummaryService(deps.stores, deps.sessionRuntime, deps.providerProfileService);
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
