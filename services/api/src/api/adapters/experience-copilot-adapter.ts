import type { ExperienceCopilotRuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer, ExperienceCopilotThread, ExperienceCopilotMessage } from "@vibe-tavern/db";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { resolveModel } from "../../infrastructure/ai/provider-executor-utils.js";
import { COAUTHOR_TRANSPORT } from "@vibe-tavern/domain";
import { notFound } from "../../shared/errors.js";
import {
  streamExperienceCopilot,
  type ExperienceCopilotStreamDeps,
} from "../../domain/interactive/copilot/experience-copilot-stream.js";
import { resolveEffectiveSettings } from "@vibe-tavern/domain";

/**
 * Experience-Copilot adapter (EXPERIENCE_EDITOR_REFACTOR_PLAN, Wave 2 / ER-6).
 *
 * Thin wiring between the route contract and the domain stream module. Owns the
 * dependency assembly: it hands the stream module the ER-3 store + script/visual
 * fetchers (from {@link StoreContainer}) + provider/model resolution (mirroring
 * the AI-assistant deps factory). No business logic lives here.
 */
export class ExperienceCopilotAdapter implements ExperienceCopilotRuntimeApi {
  constructor(private readonly stores: StoreContainer) {}

  experienceCopilotStream = async function* (
    this: ExperienceCopilotAdapter,
    threadId: string,
    body: Parameters<ExperienceCopilotRuntimeApi["experienceCopilotStream"]>[1],
    signal?: AbortSignal,
  ) {
    const deps: ExperienceCopilotStreamDeps = {
      store: this.stores.experienceCopilot,
      getScript: (scriptId: string) => this.stores.scripts.getById(scriptId),
      getBoundVisualIds: (scriptId: string) => this.stores.scripts.getBoundVisualIds(scriptId),
      getVisual: (id: string) => this.stores.experienceResources.getVisualById(id),
      getProviderProfile: (id: string) => this.stores.providers.getById(id),
      getEffectiveProviderProfile: async (id: string, model: string) => {
        const profile = await this.stores.providers.getById(id);
        if (!profile) {
          throw notFound("ProviderProfile", `Provider profile '${id}' was not found.`);
        }
        if (!profile.bindPerModel) return profile;
        const overlay = await this.stores.providers.getModelSettings(id, model);
        return resolveEffectiveSettings(profile, overlay?.settings ?? null);
      },
      resolveModel: (
        profile,
        model,
        fetch,
      ) => resolveModel(profile, model, COAUTHOR_TRANSPORT.chatCompletions, fetch),
      // Skill roots are not wired yet (the copilot's own skill library is a
      // later unit). The read_skill_file tool then rejects reads; the four
      // authoring/diagnostic tools work fully.
      skillRoots: [],
    };
    yield* streamExperienceCopilot({ ...body, threadId }, deps, signal);
  };

  experienceCopilotGetActive = async (scriptId: string): Promise<ExperienceCopilotThreadWire | null> => {
    const thread = await this.stores.experienceCopilot.getActive(scriptId);
    return thread ? this.toThreadWire(thread) : null;
  };

  experienceCopilotListMessages = async (threadId: string): Promise<ExperienceCopilotMessageWire[]> => {
    const messages = await this.stores.experienceCopilot.listMessages(threadId);
    return messages.map((m) => this.toMessageWire(m));
  };

  experienceCopilotStartNewSession = async (
    scriptId: string,
    title?: string,
  ): Promise<ExperienceCopilotThreadWire> => {
    const thread = await this.stores.experienceCopilot.startNewSession(scriptId, title);
    return this.toThreadWire(thread);
  };

  // ─── Domain → wire mappers (ER-7) ────────────────────────────────────────
  //
  // Field-for-field: the store's branded ids are phantom string brands (already
  // `string`-assignable), so the only job here is the explicit object literal
  // that pins the nullability contract (nullable fields stay `null`, never
  // `undefined`).

  private toThreadWire(t: ExperienceCopilotThread): ExperienceCopilotThreadWire {
    return {
      id: t.id,
      scriptId: t.scriptId,
      draftSessionId: t.draftSessionId,
      title: t.title,
      archivedAt: t.archivedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private toMessageWire(m: ExperienceCopilotMessage): ExperienceCopilotMessageWire {
    return {
      id: m.id,
      threadId: m.threadId,
      role: m.role,
      content: m.content,
      toolCallsJson: m.toolCallsJson,
      toolCallId: m.toolCallId,
      createdAt: m.createdAt,
    };
  }
}
