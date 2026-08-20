import type { ExperienceCopilotRuntimeApi, ExperienceCopilotContextState, ExperienceCopilotCompactResult } from "../contract/runtime-api.js";
import type { StoreContainer, ExperienceCopilotThread, ExperienceCopilotMessage, CopilotContextMetrics } from "@vibe-tavern/db";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextMetrics, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import { resolveModel } from "../../infrastructure/ai/provider-executor-utils.js";
import { COAUTHOR_TRANSPORT } from "@vibe-tavern/domain";
import { notFound } from "../../shared/errors.js";
import type { SkillLibraryService } from "../../domain/coauthor/skills/skill-library.js";
import { CopilotProfileResolver } from "../../domain/interactive/copilot/copilot-profile-resolver.js";
import {
  streamExperienceCopilot,
  type ExperienceCopilotStreamDeps,
} from "../../domain/interactive/copilot/experience-copilot-stream.js";
import { ExperienceCopilotCompactionService } from "../../domain/interactive/copilot/experience-copilot-compaction.js";
import { getCopilotContextItems } from "../../domain/interactive/copilot/experience-copilot-context.js";
import { readSkillFile } from "../../domain/coauthor/skills/skill-read-tool.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
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
  private readonly compaction: ExperienceCopilotCompactionService | null;

  constructor(
    private readonly stores: StoreContainer,
    /** Provider profile service for the compaction service (CM-5). Nullable so
     *  the lifecycle-only test harnesses can construct the adapter without it;
     *  the compaction method throws if absent. */
    private readonly providerProfileService?: ProviderProfileService,
    /** Copilot skill library (CP-5) — supplies the user-skill root for the
     *  two-root catalog the stream's prompt assembler scans. Optional so the
     *  lifecycle-only test harnesses can construct the adapter without it. */
    private readonly copilotSkillService?: SkillLibraryService,
  ) {
    this.profileResolver = new CopilotProfileResolver(stores);
    this.compaction = providerProfileService
      ? new ExperienceCopilotCompactionService(stores.experienceCopilot, providerProfileService)
      : null;
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
      // CX-3: pinned-context resolution over the REAL stores + copilot skill
      // library. getCopilotContextItems is pure over its deps, and the store
      // subset is structural (method syntax → bivariance for branded ids), so
      // the StoreContainer slots in without adapters. The skill arm reads the
      // manifest through the same sandboxed readSkillFile the tool uses (user
      // root first, so a user shadow of a built-in wins — catalog precedence).
      resolveContextItems: (links) => {
        const skillService = this.copilotSkillService!;
        const { userRoot, builtinRoot } = skillService.roots();
        return getCopilotContextItems(links, {
          characters: this.stores.characters,
          personas: this.stores.personas,
          lorebooks: this.stores.lorebooks,
          scripts: this.stores.scripts,
          skills: {
            readCatalogEntry: (id) => skillService.readCatalogEntry(id),
            readFile: async (path) => {
              try {
                return (await readSkillFile(path, [userRoot, builtinRoot])).content;
              } catch {
                // Missing/unreadable manifest — the CX-2 skip contract (the
                // catalog entry exists but its file does not resolve).
                return null;
              }
            },
          },
        });
      },
      // CM-6: fire-and-forget auto-compaction trigger (absent when the adapter
      // has no provider profile service — legacy/lifecycle-only harnesses).
      ...(this.compaction !== null
        ? { autoCompact: (threadId: string) => this.compaction!.autoCompactAfterTurn(threadId) }
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

  experienceCopilotRenameSession = async (
    sessionId: string,
    title: string,
  ): Promise<ExperienceCopilotThreadWire | null> => {
    // Normalize here so every caller (route validator, future callers) gets the
    // same storage semantics: trimmed, empty = "no custom title" (the UI then
    // falls back to the auto-numbered label).
    const thread = await this.stores.experienceCopilot.renameSession(sessionId, title.trim());
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

  experienceCopilotGetContextLinks = async (threadId: string): Promise<ExperienceCopilotContextLink[]> => {
    const thread = await this.stores.experienceCopilot.getById(threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    return thread.contextLinks;
  };

  experienceCopilotSetContextLinks = async (
    threadId: string,
    links: ExperienceCopilotContextLink[],
  ): Promise<ExperienceCopilotContextLink[]> => {
    const thread = await this.stores.experienceCopilot.getById(threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    await this.stores.experienceCopilot.setContextLinks(threadId, links);
    // Re-read so the response reflects the persisted links (full-replace semantics).
    const refreshed = await this.stores.experienceCopilot.getById(threadId);
    return refreshed ? refreshed.contextLinks : links;
  };

  experienceCopilotCompact = async (
    threadId: string,
    body: { providerProfileId?: string; model?: string },
    signal?: AbortSignal,
  ): Promise<ExperienceCopilotCompactResult> => {
    if (!this.compaction) {
      throw notFound("ProviderProfileService", "Copilot compaction is unavailable (no provider profile service).");
    }
    const { digest, metrics } = await this.compaction.compact({
      threadId,
      ...(body.providerProfileId !== undefined ? { providerProfileId: body.providerProfileId } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(signal ? { signal } : {}),
    });
    return { digest: this.toMessageWire(digest), metrics: this.toMetricsWire(metrics) };
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
      contextLinks: t.contextLinks,
      todo: t.todo,
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
      attachedTokens: m.attachedTokens,
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
