/**
 * Experience resource service (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 3 / IR-31).
 *
 * Owns the non-session resource surface: visual CRUD + source hashes, the
 * per-chat Chat Add-on configuration, global/per-character prompt overrides,
 * rules-source validation, visual/rules compatibility checks, and the starter-
 * clone primitive (Wave 8 supplies starter content; this service supplies the
 * clone operation). It wraps {@link ExperienceResourceStore} for visuals/
 * configs/overrides and {@link ScriptStore} + the IR-12 discovery for rules.
 *
 * Isolation invariant (mirrors DiceScriptService): this module imports only the
 * resource store, the script store, the chat store, the IR-12 kernel, and the
 * shared error helpers. It performs NO prompt assembly, NO provider calls, NO
 * EventBus publish. The lifecycle service consumes {@link resolveEffectiveSetup}
 * to capture pinned source snapshots at session start.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTEXT_MODE,
  type ExperienceCapability,
  type ExperienceContextMode,
} from "@vibe-tavern/domain";

import { discoverExperienceDefinition, type ExperienceDefinition } from "./experience-kernel.js";
import {
  type ExperienceApiError,
  type ExperienceResult,
  err,
  fromKernelError,
  isValidCapability,
  numericRevisionFromHash,
  ok,
  undeclaredGrantedCapabilities,
} from "./experience-shared.js";
import type {
  ExperienceChatConfigRow,
  ExperiencePromptOverrideRow,
  ExperienceVisualRow,
} from "@vibe-tavern/db";

// ─── Resolved setup (the lifecycle entry point) ─────────────────────────────

/** A rules script resolved to its discovered, validated definition + snapshot. */
export interface ResolvedRulesSource {
  scriptId: string;
  scriptName: string;
  code: string;
  definition: ExperienceDefinition;
  sourceHash: string;
  revision: number;
}

/** A visual resolved to its pinned source snapshot. */
export interface ResolvedVisualSource {
  visualId: string;
  name: string;
  source: string;
  sourceHash: string;
  revision: number;
  apiVersion: number;
  compatibleManifestIds: string[];
}

/** Everything the lifecycle service needs to start a session for a chat. */
export interface ResolvedExperienceSetup {
  enabled: boolean;
  rules: ResolvedRulesSource | null;
  visual: ResolvedVisualSource | null;
  capabilityGrants: ExperienceCapability[];
  contextMode: ExperienceContextMode;
}

/** The pure result of validating a rules source (no I/O). */
export type RulesValidation =
  | { ok: true; definition: ExperienceDefinition; sourceHash: string }
  | { ok: false; error: { kind: string; message: string } };

// ─── Input types ─────────────────────────────────────────────────────────────

export interface CreateVisualInput {
  name: string;
  source: string;
  apiVersion: number;
  compatibleManifestIds?: string[];
  scopeType?: string;
  characterId?: string | null;
}

export interface UpdateConfigInput {
  enabled?: boolean;
  scriptId?: string | null;
  visualId?: string | null;
  capabilityGrants?: ExperienceCapability[];
  contextMode?: ExperienceContextMode;
  launcherVisible?: boolean;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ExperienceResourceService {
  private readonly stores: StoreContainer;

  constructor(stores: StoreContainer) {
    this.stores = stores;
  }

  // ─── Rules validation + compatibility ─────────────────────────────────────

  /**
   * Validate a rules source through the real VM discovery (synchronous). Used
   * at session start (to capture the definition + source hash) and by authoring
   * surfaces to test a script before saving. Returns the discovered definition
   * and the SHA-256 source hash used for snapshot isolation + trust invalidation.
   */
  validateRulesSource(code: string, scriptName: string): RulesValidation {
    const result = discoverExperienceDefinition(code, scriptName);
    if (!result.ok) {
      return { ok: false, error: { kind: result.kind, message: result.message } };
    }
    return { ok: true, definition: result.definition, sourceHash: result.sourceHash };
  }

  /**
   * Whether a visual is compatible with a rules manifest. A visual with no
   * declared compatible ids is universally compatible; otherwise the rules
   * manifest id must appear in the visual's list.
   */
  checkVisualCompatibility(visual: { compatibleManifestIds: string[] }, rulesManifestId: string): boolean {
    if (visual.compatibleManifestIds.length === 0) return true;
    return visual.compatibleManifestIds.includes(rulesManifestId);
  }

  // ─── Resolved setup ───────────────────────────────────────────────────────

  /**
   * Resolve the effective interactive setup for a chat: the enabled flag, the
   * discovered+validated rules source, the pinned visual source, the granted
   * capabilities, and the RP-context mode. This is the single entry point the
   * lifecycle service uses to capture snapshots at session start. A disabled
   * chat returns enabled:false with null sources (not an error).
   */
  async resolveEffectiveSetup(chatId: string): Promise<ExperienceResult<ResolvedExperienceSetup>> {
    const chat = await this.stores.chats.getById(chatId);
    if (chat === null) {
      return err({ status: 404, code: "chat_not_found", message: `Chat '${chatId}' not found` });
    }

    const config = await this.stores.experienceResources.getOrCreateConfigForChat(chatId);
    const contextMode = parseContextMode(config.contextMode);
    const granted = parseCapabilityList(config.capabilityGrants);

    if (!config.enabled) {
      return ok({ enabled: false, rules: null, visual: null, capabilityGrants: granted, contextMode });
    }

    // Enabled but no rules selected — cannot start.
    if (config.scriptId === null) {
      return err({
        status: 409,
        code: "not_enabled",
        message: "Interactive experience is enabled for this chat but no rules script is selected",
      });
    }

    const script = await this.stores.scripts.getById(config.scriptId);
    if (script === null) {
      return err({ status: 404, code: "script_not_found", message: `Rules script '${config.scriptId}' not found` });
    }
    if (script.scriptKind !== "interactive") {
      return err({
        status: 422,
        code: "validation_error",
        message: `Script '${script.name}' is kind '${script.scriptKind}', not 'interactive'`,
      });
    }

    const validation = this.validateRulesSource(script.code, script.name);
    if (!validation.ok) {
      return err({
        status: 422,
        code: "vm_error",
        message: validation.error.message,
        kind: validation.error.kind,
      });
    }

    const rules: ResolvedRulesSource = {
      scriptId: script.id,
      scriptName: script.name,
      code: script.code,
      definition: validation.definition,
      sourceHash: validation.sourceHash,
      revision: numericRevisionFromHash(validation.sourceHash),
    };

    // Visual is optional.
    let visual: ResolvedVisualSource | null = null;
    if (config.visualId !== null) {
      const visualRow = await this.stores.experienceResources.getVisualById(config.visualId);
      if (visualRow === null) {
        return err({ status: 404, code: "visual_not_found", message: `Visual '${config.visualId}' not found` });
      }
      visual = {
        visualId: visualRow.id,
        name: visualRow.name,
        source: visualRow.source,
        sourceHash: visualRow.sourceHash,
        revision: numericRevisionFromHash(visualRow.sourceHash),
        apiVersion: visualRow.apiVersion,
        compatibleManifestIds: visualRow.compatibleManifestIds,
      };
      if (!this.checkVisualCompatibility(visual, rules.definition.manifest.id)) {
        return err({
          status: 422,
          code: "incompatible_visual",
          message: `Visual '${visual.name}' is not compatible with rules manifest '${rules.definition.manifest.id}'`,
          manifestId: rules.definition.manifest.id,
          compatible: visual.compatibleManifestIds,
        });
      }
    }

    // Granted capabilities must be a subset of declared (IR-12 deferred check).
    const undeclared = undeclaredGrantedCapabilities(rules.definition.declaredCapabilities, granted);
    if (undeclared.length > 0) {
      return err({
        status: 422,
        code: "capability_denied",
        message: `Granted capabilities not declared by the rules: ${undeclared.join(", ")}`,
        granted,
        needs: undeclared,
      });
    }

    return ok({ enabled: true, rules, visual, capabilityGrants: granted, contextMode });
  }

  // ─── Visuals ──────────────────────────────────────────────────────────────

  async createVisual(input: CreateVisualInput): Promise<ExperienceResult<ExperienceVisualRow>> {
    if (input.source.trim().length === 0) {
      return err({ status: 422, code: "validation_error", message: "Visual source must not be empty" });
    }
    const row = await this.stores.experienceResources.createVisual({
      name: input.name,
      source: input.source,
      apiVersion: input.apiVersion,
      compatibleManifestIds: input.compatibleManifestIds,
      scopeType: input.scopeType,
      characterId: input.characterId ?? null,
    });
    return ok(row);
  }

  /**
   * Clone a visual from arbitrary source (the starter-clone primitive). Wave 8
   * supplies the starter templates and calls this with the chosen starter's
   * source; the result is a user-owned editable copy whose source is independent
   * of the starter (edits do not mutate the starter).
   */
  async cloneVisualFromStarter(input: {
    name: string;
    source: string;
    apiVersion: number;
    compatibleManifestIds?: string[];
    scopeType?: string;
    characterId?: string | null;
  }): Promise<ExperienceResult<ExperienceVisualRow>> {
    return this.createVisual(input);
  }

  async updateVisual(
    id: string,
    patch: { name?: string; source?: string; apiVersion?: number; compatibleManifestIds?: string[] },
  ): Promise<ExperienceResult<ExperienceVisualRow>> {
    const existing = await this.stores.experienceResources.getVisualById(id);
    if (existing === null) {
      return err({ status: 404, code: "visual_not_found", message: `Visual '${id}' not found` });
    }
    if (patch.source !== undefined && patch.source.trim().length === 0) {
      return err({ status: 422, code: "validation_error", message: "Visual source must not be empty" });
    }
    // A source edit changes the sourceHash (trust-invalidation signal); the
    // store recomputes it inline.
    const row = await this.stores.experienceResources.updateVisual(id, patch);
    return ok(row);
  }

  async deleteVisual(id: string): Promise<ExperienceResult<void>> {
    const existing = await this.stores.experienceResources.getVisualById(id);
    if (existing === null) {
      return err({ status: 404, code: "visual_not_found", message: `Visual '${id}' not found` });
    }
    await this.stores.experienceResources.deleteVisual(id);
    return ok(undefined);
  }

  async getVisual(id: string): Promise<ExperienceVisualRow | null> {
    return this.stores.experienceResources.getVisualById(id);
  }

  async listVisualsForScope(scopeType: string, ownerId: string | null): Promise<ExperienceVisualRow[]> {
    return this.stores.experienceResources.listVisualsForScope(scopeType, ownerId);
  }

  // ─── Chat configuration ───────────────────────────────────────────────────

  async getConfig(chatId: string): Promise<ExperienceChatConfigRow> {
    return this.stores.experienceResources.getOrCreateConfigForChat(chatId);
  }

  async updateConfig(chatId: string, input: UpdateConfigInput): Promise<ExperienceResult<ExperienceChatConfigRow>> {
    const chat = await this.stores.chats.getById(chatId);
    if (chat === null) {
      return err({ status: 404, code: "chat_not_found", message: `Chat '${chatId}' not found` });
    }
    // Validate typed fields before persisting.
    let capabilityGrants: ExperienceCapability[] | undefined;
    if (input.capabilityGrants !== undefined) {
      const bad = input.capabilityGrants.filter((c) => !isValidCapability(c));
      if (bad.length > 0) {
        return err({
          status: 422,
          code: "validation_error",
          message: `Unknown capability values: ${bad.join(", ")}`,
        });
      }
      capabilityGrants = input.capabilityGrants;
    }
    let contextMode: ExperienceContextMode | undefined;
    if (input.contextMode !== undefined) {
      contextMode = parseContextMode(input.contextMode);
    }
    const row = await this.stores.experienceResources.updateConfig(chatId, {
      enabled: input.enabled,
      scriptId: input.scriptId,
      visualId: input.visualId,
      capabilityGrants,
      contextMode: contextMode as string | undefined,
      launcherVisible: input.launcherVisible,
    });
    return ok(row);
  }

  // ─── Prompt overrides ─────────────────────────────────────────────────────

  async setGlobalOverride(content: string): Promise<ExperiencePromptOverrideRow> {
    return this.stores.experienceResources.setGlobalOverride(content);
  }

  async setCharacterOverride(
    characterId: string,
    content: string,
  ): Promise<ExperiencePromptOverrideRow> {
    return this.stores.experienceResources.setOverrideForCharacter(characterId, content);
  }

  async deleteCharacterOverride(characterId: string): Promise<void> {
    await this.stores.experienceResources.deleteOverrideForCharacter(characterId);
  }

  async getEffectiveOverride(characterId: string | null): Promise<ExperiencePromptOverrideRow | null> {
    return this.stores.experienceResources.getEffectiveOverride(characterId);
  }
}

// ─── Parse helpers (DB stores free-text enums; validate at the boundary) ─────

function parseContextMode(value: string): ExperienceContextMode {
  const valid = Object.values(EXPERIENCE_CONTEXT_MODE) as readonly string[];
  return (valid.includes(value) ? value : EXPERIENCE_CONTEXT_MODE.none) as ExperienceContextMode;
}

function parseCapabilityList(values: string[]): ExperienceCapability[] {
  return values.filter((v): v is ExperienceCapability => isValidCapability(v));
}

// Re-export the error vocabulary for the service consumers (routes/adapter).
export type { ExperienceApiError, ExperienceResult } from "./experience-shared.js";
