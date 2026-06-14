import type { Hono } from "hono";
import type { EventBus } from "@vibe-tavern/domain";

// ────────────────────────────────────────────────────────────────────────────
// FeatureModule — self-contained feature registration
// ────────────────────────────────────────────────────────────────────────────
// Each feature (Insights, Context Memory, Attachments, etc.) implements this
// interface. Features register their routes, event handlers, and other
// extensions through a single activate() call in FeatureDeps.
//
// Lifecycle:
//   1. Server creates FeatureRegistry
//   2. Server calls registry.register(feature) for each feature
//   3. Server calls registry.activateAll(deps) during startup
//   4. On shutdown: registry.deactivateAll() (optional, for clean tests)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies provided to a feature during activation.
 * All services the feature needs without direct coupling to server internals.
 */
export interface FeatureDeps {
  /** Typed event bus for subscribing to chat events. */
  events: EventBus;
  /**
   * Hono sub-router for mounting feature API routes.
   * Routes mounted here are relative to the app root.
   * Example: router.post("/api/chats/:chatId/memory/summaries", handler)
   */
  router: Hono;
}

/**
 * A self-contained feature module.
 *
 * Features call registerMessageSlot(), registerBuildPanel(), events.on(),
 * and mount routes during activate(). They clean up during deactivate().
 */
export interface FeatureModule {
  /** Unique feature identifier (e.g., "chat-summary", "insights", "context-memory"). */
  readonly id: string;

  /**
   * Activate the feature: register routes, subscribe to events, etc.
   * Called once during server startup.
   */
  activate(deps: FeatureDeps): void;

  /**
   * Deactivate the feature: unsubscribe, unmount, clean up.
   * Called during shutdown or tests.
   */
  deactivate(): void;
}
