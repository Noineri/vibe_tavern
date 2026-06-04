import type { Hono } from "hono";
import type { EventBus } from "@vibe-tavern/domain";
import type { FeatureModule, FeatureDeps } from "./feature-module.js";

// ────────────────────────────────────────────────────────────────────────────
// FeatureRegistry — manages feature module lifecycle
// ────────────────────────────────────────────────────────────────────────────
// Created during server startup. Features are registered then activated.
// The registry holds shared deps (EventBus, Hono router) and passes them
// to each feature during activation.
// ────────────────────────────────────────────────────────────────────────────

export class FeatureRegistry {
  private readonly features = new Map<string, FeatureModule>();
  private readonly cleanupFns = new Map<string, () => void>();
  private activated = false;

  /**
   * Register a feature module. Must be called before activateAll().
   * If a feature with the same id was already registered, it is replaced.
   */
  register(feature: FeatureModule): void {
    if (this.activated) {
      throw new Error(`Cannot register feature "${feature.id}" after activation. Register features before calling activateAll().`);
    }
    this.features.set(feature.id, feature);
  }

  /**
   * Activate all registered features. Called once during server startup.
   * Each feature receives the shared deps (events, router).
   */
  activateAll(deps: { events: EventBus; router: Hono }): void {
    if (this.activated) {
      throw new Error("FeatureRegistry.activateAll() called more than once.");
    }
    this.activated = true;

    const featureDeps: FeatureDeps = {
      events: deps.events,
      router: deps.router,
    };

    for (const [id, feature] of this.features) {
      try {
        feature.activate(featureDeps);
        this.cleanupFns.set(id, () => feature.deactivate());
      } catch (err) {
        // Log but don't crash — one feature failure shouldn't prevent others
        console.error(`[feature-registry] Failed to activate feature "${id}":`, err);
      }
    }
  }

  /**
   * Deactivate all features. Useful for tests and clean shutdown.
   */
  deactivateAll(): void {
    for (const [id, cleanup] of this.cleanupFns) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[feature-registry] Error deactivating feature "${id}":`, err);
      }
    }
    this.cleanupFns.clear();
    this.activated = false;
  }

  /**
   * Check if a feature is registered and activated.
   */
  isActive(featureId: string): boolean {
    return this.cleanupFns.has(featureId);
  }

  /**
   * List all registered feature IDs.
   */
  get featureIds(): string[] {
    return [...this.features.keys()];
  }
}
