import type { ExperienceCopilotRuntimeApi, ExperienceCopilotContextState } from "../contract/runtime-api.js";
import type { StoreContainer, ExperienceCopilotThread, ExperienceCopilotMessage, CopilotContextMetrics } from "@vibe-tavern/db";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextMetrics } from "@vibe-tavern/api-contracts";
import { resolveModel } from "../../infrastructure/ai/provider-executor-utils.js";
import { COAUTHOR_TRANSPORT } from "@vibe-tavern/domain";
import { notFound } from "../../shared/errors.js";
import type { SkillLibraryService } from "../../domain/coauthor/skills/skill-library.js";
import { CopilotProfileResolver } from "../../domain/interactive/copilot/copilot-profile-resolver.js";
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
  private readonly profileResolver: CopilotProfileResolver;

  constructor(
    private readonly stores: StoreContainer,
    /** Copilot skill library (CP-5) — supplies the user-skill root for the
     *  two-root catalog the stream's prompt assembler scans. Optional so the
     *  lifecycle-only test harnesses can construct the adapter without it. */
    private readonly copilotSkillService?: SkillLibraryService,
  ) {
    this.profileResolver = new CopilotProfileResolver(stores);
  }

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
      // Profile resolution (CP-6): thread → script → copilot_profile_id → row,
      // falling back to the built-in seed. The stream already holds thread.scriptId.
      resolveProfile: (scriptId) => this.profileResolver.resolveForScript(scriptId),
      // Two-root catalog user root (CP-4): absent → built-in root only.
      ...(this.copilotSkillService !== undefined
        ? { skillUserRoot: this.copilotSkillService.roots().userRoot }
        : {}),
      // Skill roots are derived in the prompt assembler from the resolved skill
      // catalog (ER-16) and flow to the tool builder via `assembled.skillRoots`,
      // so no skill-root wiring is needed here.
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

  experienceCopilotListSessions = async (scriptId: string): Promise<ExperienceCopilotThreadWire[]> => {
    const threads = await this.stores.experienceCopilot.listSessions(scriptId);
    return threads.map((t) => this.toThreadWire(t));
  };

  experienceCopilotActivate = async (sessionId: string): Promise<ExperienceCopilotThreadWire | null> => {
    const thread = await this.stores.experienceCopilot.activate(sessionId);
    return thread ? this.toThreadWire(thread) : null;
  };

  experienceCopilotArchive = async (sessionId: string): Promise<ExperienceCopilotThreadWire | null> => {
    const thread = await this.stores.experienceCopilot.archive(sessionId);
    return thread ? this.toThreadWire(thread) : null;
  };

  experienceCopilotGetContext = async (threadId: string): Promise<ExperienceCopilotContextState> => {
    const thread = await this.stores.experienceCopilot.getById(threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    return {
      metrics: thread.contextMetrics ? this.toMetricsWire(thread.contextMetrics) : null,
      autoCompact: thread.autoCompact,
    };
  };

  experienceCopilotPatchContext = async (
    threadId: string,
    body: { autoCompact?: boolean },
  ): Promise<ExperienceCopilotContextState> => {
    const thread = await this.stores.experienceCopilot.getById(threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    if (body.autoCompact !== undefined) {
      await this.stores.experienceCopilot.setAutoCompact(threadId, body.autoCompact);
    }
    // Re-read so the response reflects the persisted toggle (metrics unchanged).
    const refreshed = await this.stores.experienceCopilot.getById(threadId);
    return {
      metrics: refreshed?.contextMetrics ? this.toMetricsWire(refreshed.contextMetrics) : null,
      autoCompact: refreshed?.autoCompact ?? true,
    };
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
      metrics: t.contextMetrics ? this.toMetricsWire(t.contextMetrics) : null,
    };
  }

  /** Map the store's parsed metrics (structurally identical to the wire shape)
   *  into the api-contracts type. Field-for-field so the nullability/union
   *  contract is explicit (never `undefined`). */
  private toMetricsWire(m: CopilotContextMetrics): ExperienceCopilotContextMetrics {
    return {
      systemTokens: m.systemTokens,
      digestTokens: m.digestTokens,
      historyTokens: m.historyTokens,
      totalTokens: m.totalTokens,
      budgetTokens: m.budgetTokens,
      reserveTokens: m.reserveTokens,
      source: m.source,
      measuredAt: m.measuredAt,
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
