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
  ExperienceSessionRow,
  ExperienceVisualRow,
} from "@vibe-tavern/db";
import { BUILTIN_EXPERIENCE_CATALOG } from "./builtin-experiences/index.js";

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
  contextSourceCharacterId?: string | null;
  contextSourceChatId?: string | null;
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
    // Empty source is ALLOWED (2026-08-17): a visual can be saved as a draft
    // placeholder and filled in later — the frame simply renders blank. The
    // user's flow creates the visual draft together with the new app.
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
    // Empty source patches are allowed too (draft placeholders) — see createVisual.
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
    // Fix item 12: deleting a built-in visual records a dismissal so the seed
    // never re-creates/re-binds what the user explicitly removed.
    const entry = BUILTIN_EXPERIENCE_CATALOG.find((e) => e.visualStableKey === existing.stableKey);
    if (entry !== undefined) {
      await this.stores.experienceResources.dismissBuiltinExperience(entry.id, entry.visualStableKey);
    }
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
      contextSourceCharacterId: input.contextSourceCharacterId,
      contextSourceChatId: input.contextSourceChatId,
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

  // ─── Session-scoped prompt overrides (IR-70D) ──────────────────────────────

  /**
   * Read both prompt-override layers for the session's current-chat character.
   * Requires immutable session grant `model`. Returns independent null layers
   * when no override is persisted for that scope — never collapses to only the
   * effective winner.
   */
  async getOverridesForSession(sessionId: string): Promise<ExperienceResult<SessionPromptOverrides>> {
    const resolved = await this.resolveSessionToLayers(sessionId);
    if (!resolved.ok) return resolved;
    const { characterId } = resolved.data;
    const globalRow = await this.stores.experienceResources.getGlobalOverride();
    const characterRow = characterId
      ? await this.stores.experienceResources.getOverrideForCharacter(characterId)
      : null;
    return ok({
      global: globalRow ? rowToDto(globalRow) : null,
      character: characterRow ? rowToDto(characterRow) : null,
    });
  }

  /**
   * Write the global prompt-override layer for the session. Requires `model`.
   * Returns the updated combined layers.
   */
  async setGlobalOverrideForSession(sessionId: string, content: string): Promise<ExperienceResult<SessionPromptOverrides>> {
    const resolved = await this.resolveSessionToLayers(sessionId);
    if (!resolved.ok) return resolved;
    const { characterId } = resolved.data;
    const globalRow = await this.stores.experienceResources.setGlobalOverride(content);
    const characterRow = characterId
      ? await this.stores.experienceResources.getOverrideForCharacter(characterId)
      : null;
    return ok({
      global: rowToDto(globalRow),
      character: characterRow ? rowToDto(characterRow) : null,
    });
  }

  /**
   * Write the current-character prompt-override layer. Requires `model` + the
   * session's chat must have a character (otherwise typed 422). Derives the
   * character from session → chat; never accepts an arbitrary characterId.
   * Returns the updated combined layers.
   */
  async setCharacterOverrideForSession(sessionId: string, content: string): Promise<ExperienceResult<SessionPromptOverrides>> {
    const resolved = await this.resolveSessionToLayers(sessionId);
    if (!resolved.ok) return resolved;
    const { characterId } = resolved.data;
    if (!characterId) {
      return err({ status: 422, code: "no_character", message: "The session's chat has no character; character-scoped operations are not available." });
    }
    const characterRow = await this.stores.experienceResources.setOverrideForCharacter(characterId, content);
    const globalRow = await this.stores.experienceResources.getGlobalOverride();
    return ok({
      global: globalRow ? rowToDto(globalRow) : null,
      character: rowToDto(characterRow),
    });
  }

  // ─── Private: session → chat → character resolution + capability gate ──────

  private async resolveSessionToLayers(sessionId: string): Promise<ExperienceResult<{ characterId: string | null }>> {
    const session = await this.stores.experiences.getSessionById(sessionId);
    if (!session) {
      return err({ status: 404, code: "session_not_found", message: `Experience session '${sessionId}' was not found.` });
    }
    const grantErr = checkModelGrant(session);
    if (grantErr) return err(grantErr);
    const chat = await this.stores.chats.getById(session.chatId);
    if (!chat) {
      return err({ status: 404, code: "chat_not_found", message: `Chat '${session.chatId}' not found` });
    }
    return ok({ characterId: chat.characterId ?? null });
  }
}

// ─── IR-70D: Session prompt-override DTOs ────────────────────────────────────

/** Both independent prompt-override layers for a session (IR-70D). */
export interface SessionPromptOverrides {
  global: PromptOverrideDto | null;
  character: PromptOverrideDto | null;
}

/** One prompt-override layer — scope, content, optional characterId, timestamps. */
export interface PromptOverrideDto {
  scope: 'global' | 'character';
  content: string;
  characterId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToDto(row: ExperiencePromptOverrideRow): PromptOverrideDto {
  return {
    scope: row.scopeType === 'character' ? 'character' : 'global',
    content: row.content,
    characterId: row.characterId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Validate that the session grants the `model` capability; throws on deny. */
function checkModelGrant(session: ExperienceSessionRow): ExperienceApiError | null {
  const grants: ExperienceCapability[] = (() => { try { return JSON.parse(session.capabilityGrantsJson) as ExperienceCapability[]; } catch { return []; } })();
  if (!grants.includes("model")) {
    return {
      status: 422,
      code: "capability_denied",
      message: "The experience session does not grant the 'model' capability.",
      granted: grants,
      needs: ["model" as ExperienceCapability],
    };
  }
  return null;
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
