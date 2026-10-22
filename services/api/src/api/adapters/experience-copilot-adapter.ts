import type { ExperienceCopilotRuntimeApi, ExperienceCopilotContextState, ExperienceCopilotCompactResult, ExperienceCopilotTurnDeleteRequest, ExperienceCopilotTurnDeleteResult } from "../contract/experience-copilot-contracts.js";
import type { StoreContainer, ExperienceCopilotThread, ExperienceCopilotMessage } from "@vibe-tavern/db";
import type { ExperienceCopilotThreadWire, ExperienceCopilotMessageWire, ExperienceCopilotContextLink, AgentKindSettingsWire, AgentKindSettingsPatchRequest, AgentChatSettingsWire, AgentChatSettingsPatchRequest, AgentThreadEventWire, AgentBranchForkSidechatResult, AgentBranchSidechatSummary } from "@vibe-tavern/api-contracts";
import {
  toThreadWire,
  toMetricsWire,
  toMessageWire,
  toKindSettingsWire,
  toChatSettingsWire,
} from "./experience-copilot-wire-mappers.js";
import { resolveModel } from "../../infrastructure/ai/provider-executor-utils.js";
import { COAUTHOR_TRANSPORT } from "@vibe-tavern/domain";
import { notFound } from "../../shared/errors.js";
import { requireChatBranch } from "../../domain/chat/chat-branch-ownership.js";
import type { SkillLibraryService } from "../../domain/coauthor/skills/skill-library.js";
import { CopilotProfileResolver } from "../../domain/interactive/copilot/copilot-profile-resolver.js";
import {
  streamExperienceCopilot,
  type ExperienceCopilotStreamDeps,
} from "../../domain/interactive/copilot/experience-copilot-stream.js";
import {
  streamScriptAgentTurn,
  type ScriptAgentStreamDeps,
} from "../../domain/agent/script-agent/script-agent-stream.js";
import {
  streamSidechatTurn,
  type SidechatStreamDeps,
} from "../../domain/sidechat/sidechat-stream.js";
import { buildContextSearchStoreReads } from "../../domain/context/context-search-store-reads.js";
import { PromptAssemblyService } from "../../domain/prompt/prompt-assembly-service.js";
import { StaticPromptResolver } from "../../domain/prompt/prompt-resolver.js";
import { RegexHookService } from "../../domain/regex/regex-hook-service.js";
import { ExperienceCopilotCompactionService } from "../../domain/interactive/copilot/experience-copilot-compaction.js";
import { ScriptAgentCompactionService } from "../../domain/agent/script-agent/script-agent-compaction.js";
import { SidechatOocCompactionService } from "../../domain/sidechat/sidechat-compaction.js";
import { listAgentThreadEvents } from "../../domain/sidechat/sidechat-events.js";
import { forkBranchSidechat, summarizeBranchSidechat } from "../../domain/sidechat/branch-sidechat-fork.js";
import { readContextLinks, replaceContextLinks } from "./experience-copilot-context-links.js";
import { deleteCopilotTurnWire } from "./experience-copilot-turn-delete.js";
import type { AgentCompactionService } from "../../domain/agent/agent-compaction.js";
import { getCopilotContextItems } from "../../domain/agent/agent-context.js";
import type { CopilotContextItem } from "../../domain/agent/agent-context.js";
import type { ScriptAgentContextCard } from "../../domain/agent/kinds/script-kind.js";
import type { ExperienceCopilotStreamEvent } from "../../domain/interactive/copilot/experience-copilot-stream-contract.js";
import { readSkillFile } from "../../domain/coauthor/skills/skill-read-tool.js";
import {
  resolveKindForScript,
  getAgentKind,
  getChatOwnedAgentKind,
  requireKindServesChatMode,
  kindServesChatMode,
  AgentKindNotWiredError,
} from "../../domain/agent/agent-kind-registry.js";
import type { AgentKind, AgentKindId } from "../../domain/agent/agent-kind.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import { resolveEffectiveSettings } from "@vibe-tavern/domain";

type StreamBody = Parameters<ExperienceCopilotRuntimeApi["experienceCopilotStream"]>[1];

/** One kind's stream wiring: thread id + request body → the SSE-shaped event
 *  generator the route relays verbatim. */
type KindStream = (
  threadId: string,
  body: StreamBody,
  signal?: AbortSignal,
) => AsyncGenerator<ExperienceCopilotStreamEvent>;

/** The kind a thread resolves to when it has NO script row to resolve
 *  through — a draft (`scriptId === null`, pre-save) or a dangling soft link.
 *  Drafts have no script kind: today's draft semantics keep the experience
 *  wiring. */
const DRAFT_THREAD_KIND: AgentKindId = "experience";

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
  private readonly scriptCompaction: ScriptAgentCompactionService | null;
  private readonly sidechatCompaction: SidechatOocCompactionService | null;
  /** Per-kind stream wiring, built once (see constructor). Adding a kind =
   *  one entry here; the dispatch and the assert step read this table. */
  private readonly streamKinds: ReadonlyMap<AgentKindId, KindStream>;
  /** Per-kind manual-compaction services (only kinds that compact; empty
   *  when the adapter has no provider profile service). */
  private readonly compactionKinds: ReadonlyMap<AgentKindId, AgentCompactionService<ExperienceCopilotMessage>>;

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
    /** Script-agent skill library (AS-8d1) — supplies the SCRIPT kind's own
     *  user-skill root for its stream's two-root catalog scan (the experience
     * kind never reads it). Optional so the lifecycle-only test harnesses can
     *  construct the adapter without it. */
    private readonly scriptSkillService?: SkillLibraryService,
    /** Sidechat skill library (SIDECHAT_PLAN SC-5) — supplies the
     * `sidechat-ooc` kind's own user-skill root for its stream's
     * pinned-context skill arm (no other kind reads it; the sidechat's
     * assembly scans no skill catalog — SC-4b's shape). Optional so the
     * lifecycle-only test harnesses can construct the adapter without it
     * (then the sidechat stream attaches no context, the same contract the
     * script kind has without ITS library). */
    private readonly sidechatSkillService?: SkillLibraryService,
  ) {
    this.profileResolver = new CopilotProfileResolver(stores);
    this.compaction = providerProfileService
      ? new ExperienceCopilotCompactionService(stores.experienceCopilot, providerProfileService, undefined, stores.db)
      : null;
    this.scriptCompaction = providerProfileService
      ? new ScriptAgentCompactionService(stores.experienceCopilot, providerProfileService, undefined, stores.db)
      : null;
    this.sidechatCompaction = providerProfileService
      ? new SidechatOocCompactionService(stores.experienceCopilot, providerProfileService, undefined, stores.db)
      : null;
    this.streamKinds = new Map<AgentKindId, KindStream>([
      ["experience", (threadId, body, signal) => this.streamExperienceThread(threadId, body, signal)],
      ["script", (threadId, body, signal) =>
        streamScriptAgentTurn({ ...body, threadId }, this.buildScriptAgentStreamDeps(), signal)],
      ["sidechat-ooc", (threadId, body, signal) =>
        streamSidechatTurn({ ...body, threadId }, this.buildSidechatStreamDeps(), signal)],
    ]);
    this.compactionKinds = new Map<AgentKindId, AgentCompactionService<ExperienceCopilotMessage>>([
      ...(this.compaction !== null ? [["experience", this.compaction] as const] : []),
      ...(this.scriptCompaction !== null ? [["script", this.scriptCompaction] as const] : []),
      // SC-8c: the sidechat's own discussion digest — the manual compact
      //  button un-400s for the kind (the route dispatches through this
      //  table).
      ...(this.sidechatCompaction !== null ? [["sidechat-ooc", this.sidechatCompaction] as const] : []),
    ]);
  }

  /** The ONE thread → agent-kind resolution (used by the assert step, the
   *  stream dispatch and manual compaction). SC-0b: a thread that carries an
   *  `agent_kind` (a chat-owned thread) resolves to THAT kind through the
   *  registry — `getAgentKind` throws `UnknownAgentKindError` when nothing is
   *  registered under the stored slug (the typed-error path; the route maps
   *  it to the same 400 as an unserved script kind). Everything else keeps
   *  today's script path: thread → script row →
   *  `resolveKindForScript(script.scriptKind)`. A missing thread is a
   *  `notFound`; a draft thread (`scriptId === null`) and a dangling script
   *  link resolve to the draft kind (today's draft semantics); an unserved
   *  script kind throws `NoAgentKindForScriptKindError` from the registry. */
  private async resolveThreadKind(threadId: string): Promise<AgentKindId> {
    const thread = await this.stores.experienceCopilot.getById(threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    if (thread.agentKind !== null) return getAgentKind(thread.agentKind).id;
    if (thread.scriptId === null) return DRAFT_THREAD_KIND;
    const script = await this.stores.scripts.getById(thread.scriptId);
    if (script === null) return DRAFT_THREAD_KIND;
    return resolveKindForScript(script.scriptKind).id;
  }

  /** The stream wiring a resolved kind runs through. A kind the registry
   *  serves but this adapter has no table entry for is a typed
   *  `AgentKindNotWiredError` (the route maps it to the same 400 as an
   *  unserved kind) — never a silent fallback to another kind's wiring. */
  private getKindStream(kindId: AgentKindId): KindStream {
    const entry = this.streamKinds.get(kindId);
    if (entry === undefined) throw new AgentKindNotWiredError(kindId, "stream");
    return entry;
  }

  /** AS-2c kind resolution at the stream-turn start, through the ONE
   *  {@link resolveThreadKind}. Since AS-8b the STREAM dispatches by that
   *  resolution — a prompt/dice script's thread runs the `script` kind's
   *  assembly + tools, an interactive script's thread the experience ones —
   *  so this assert only rejects what the thread cannot be served by: an
   *  unserved script kind (`NoAgentKindForScriptKindError`), a resolved kind
   *  with no stream-table entry (`AgentKindNotWiredError`), plus a missing
   *  thread (`notFound`). It no longer pins the thread to the experience
   *  kind (the pre-dispatch mismatch 400 `copilot_thread_kind_mismatch` was
   *  removed with the dispatch). Draft threads and dangling script links
   *  resolve to the draft kind (today's draft semantics — the turn streams as
   *  before). */
  experienceCopilotAssertStreamKind = async (threadId: string): Promise<void> => {
    this.getKindStream(await this.resolveThreadKind(threadId));
  };

  /** Resolve a script's linked owners (names) PLUS the request's build-panel
   *  character/persona into full cards (AS-8e1 — the card text is the same
   *  source the @-pin loader uses: a character's full profile markdown,
   *  a persona's description). The script kind's context package lists the
   *  names so the model knows whom the script binds to, then renders every
   *  card in full — the assistant sees what a human author would need, not
   *  just a name. Deduped by type+id (a request id that is also a linked
   *  owner renders once); dangling targets and missing rows are skipped,
   *  never fatal. `scriptId === null` (a draft thread) still resolves the
   *  request ids. */
  private async getScriptContextCards(input: {
    scriptId: string | null;
    contextCharacterId?: string;
    contextPersonaId?: string;
  }): Promise<{ ownerNames: string[]; cards: ScriptAgentContextCard[] }> {
    const names: string[] = [];
    const cards: ScriptAgentContextCard[] = [];
    const seen = new Set<string>();
    const pushCharacter = async (id: string): Promise<void> => {
      const key = `character:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const character = await this.stores.characters.getById(id);
      if (!character) return;
      names.push(character.name);
      cards.push({
        type: "character",
        id: character.id,
        name: character.name,
        content: await this.stores.characters.getProfileMdText(id),
      });
    };
    const pushPersona = async (id: string, countAsOwner: boolean): Promise<void> => {
      const key = `persona:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const persona = await this.stores.personas.getById(id);
      if (!persona) return;
      if (countAsOwner) names.push(persona.name);
      cards.push({ type: "persona", id: persona.id, name: persona.name, content: persona.description });
    };
    if (input.scriptId !== null) {
      const links = await this.stores.scripts.getLinks(input.scriptId);
      for (const link of links) {
        if (link.targetType === "character") {
          await pushCharacter(link.targetId);
        } else {
          await pushPersona(link.targetId, true);
        }
      }
    }
    // The request's build-panel ids are context, not ownership: their cards
    // render, but their names never join the «Linked owners» line.
    if (input.contextCharacterId !== undefined) await pushCharacter(input.contextCharacterId);
    if (input.contextPersonaId !== undefined) await pushPersona(input.contextPersonaId, false);
    return { ownerNames: names, cards };
  }

  /** The kind-agnostic pinned-context loader (CX-3) over the REAL stores +
   *  the GIVEN skill library, shared by every kind's stream deps (each kind
   *  passes its OWN library — the script kind reads the script library, the
   *  experience kind the copilot one — so a pinned skill resolves from the
   *  library the turn's catalog was scanned from).
   *  `getCopilotContextItems` is pure over its deps, and the store subset is
   *  structural (method syntax → bivariance for branded ids), so the
   *  StoreContainer slots in without adapters. The skill arm reads the
   *  manifest through the same sandboxed `readSkillFile` the tool uses (user
   *  root first, so a user shadow of a built-in wins — catalog precedence).
   *  `undefined` when the skill library is absent (lifecycle-only harnesses
   *  construct the adapter without one) → the stream attaches no context. */
  private buildContextItemsResolver(
    skillService: SkillLibraryService | undefined,
  ):
    | ((links: readonly ExperienceCopilotContextLink[]) => Promise<CopilotContextItem[]>)
    | undefined {
    if (skillService === undefined) return undefined;
    return (links) => {
      const { userRoot, builtinRoot } = skillService.roots();
      return getCopilotContextItems(links, {
        characters: this.stores.characters,
        personas: this.stores.personas,
        lorebooks: this.stores.lorebooks,
        scripts: this.stores.scripts,
        skills: {
          readCatalogEntry: (id: string) => skillService.readCatalogEntry(id),
          readFile: async (path: string) => {
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
    };
  }

  /** AS-8b: the `script` kind's stream deps — the same store/provider seams
   *  the experience wiring uses, with the script-owned context (owner names
   *  + full cards, trust), the shared kind-agnostic pinned-context loader
   *  over the SCRIPT skill library (AS-8e1 — a skill pinned in a script
   *  session resolves from the script library, never the experience one),
   *  and the script kind's own auto-compaction (script-authoring summarizer). */
  private buildScriptAgentStreamDeps(): ScriptAgentStreamDeps {
    const contextItemsResolver = this.buildContextItemsResolver(this.scriptSkillService);
    return {
      store: this.stores.experienceCopilot,
      agentPlans: this.stores.agentPlans,
      getScript: (scriptId: string) => this.stores.scripts.getById(scriptId),
      getContextCards: (input: {
        scriptId: string | null;
        contextCharacterId?: string;
        contextPersonaId?: string;
      }) => this.getScriptContextCards(input),
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
      // Kind-aware fallback (AS-8b): prompt/dice scripts seed the `script`
      // kind's builtin, interactive scripts the experience one.
      resolveProfile: (scriptId) => this.profileResolver.resolveForScript(scriptId),
      // SC-0f: a chat-owned thread's profile chain (the chat's own choice →
      // the kind default → the kind's built-in) — the stream consults it only
      // when the thread's owner columns say chat-owned.
      resolveProfileForChat: (thread) =>
        this.profileResolver.resolveForChat(thread.chatId, thread.agentKind),
      // Two-root catalog user root for the SCRIPT kind (AS-8d1 — the script
      // service's own root, never the experience copilot one): absent →
      // built-in root only.
      ...(this.scriptSkillService !== undefined
        ? { skillUserRoot: this.scriptSkillService.roots().userRoot }
        : {}),
      db: this.stores.db,
      // Same kind-agnostic pinned-context loader as the experience wiring —
      // only wired when the skill library is present.
      ...(contextItemsResolver !== undefined ? { resolveContextItems: contextItemsResolver } : {}),
      // CM-6: fire-and-forget auto-compaction through the SCRIPT service
      // (absent when the adapter has no provider profile service).
      ...(this.scriptCompaction !== null
        ? { autoCompact: (threadId: string) => this.scriptCompaction!.autoCompactAfterTurn(threadId) }
        : {}),
      stores: this.stores,
    };
  }

  // ─── Sidechat-OOC stream wiring (SIDECHAT_PLAN SC-4b) ─────────────────────

  /** The RP assembly service the sidechat seams read through (SC-2a's
   *  branch view and SC-3b's package loader both go through
   *  `buildPipelineContext` — the send path's own input source). Built lazily
   *  with the SAME construction recipe session-runtime uses for its instance
   *  (`StaticPromptResolver` + `RegexHookService` over the same stores);
   *  session-runtime's own instance is private to it, and the service is
   *  stateless over the stores, so this instance is behaviorally identical —
   *  the same standalone construction every sidechat test performs. Lazy so
   *  lifecycle-only harnesses that never stream a sidechat turn pay nothing. */
  private sidechatAssembly: PromptAssemblyService | null = null;
  private getSidechatAssembly(): PromptAssemblyService {
    if (this.sidechatAssembly === null) {
      this.sidechatAssembly = new PromptAssemblyService(
        this.stores,
        new StaticPromptResolver(this.stores, new RegexHookService(this.stores)),
        this.stores.content.fileStore,
      );
    }
    return this.sidechatAssembly;
  }

  /** SC-4b/SC-5: the `sidechat-ooc` kind's stream deps — the shared
   *  store/provider seams, the SC-2c sync + SC-3b package deps over the real
   *  stores and the RP assembly service, the chat-owned profile chain (the
   *  only kind of thread this stream can run for), and since SC-5 the SHARED
   *  kind-agnostic pinned-context resolver (`buildContextItemsResolver`)
   *  over the sidechat's OWN skill library — a pinned skill resolves from
   *  the sidechat roots, never another kind's (SC-4b's inert skill arm is
   *  gone). Since SC-8c the compaction service rides along so the stream
   *  wires the kind's auto-compaction rule (the discussion against the room
   *  left after the static context and the RP layer; absent → the kind never
   *  auto-compacts). No streamText (production runs the real one). */
  private buildSidechatStreamDeps(): SidechatStreamDeps {
    const assembly = this.getSidechatAssembly();
    const contextItemsResolver = this.buildContextItemsResolver(this.sidechatSkillService);
    return {
      store: this.stores.experienceCopilot,
      sync: {
        chats: this.stores.chats,
        messages: this.stores.messages,
        assembly,
        experienceCopilot: this.stores.experienceCopilot,
      },
      context: {
        chats: this.stores.chats,
        characters: this.stores.characters,
        messages: this.stores.messages,
        traces: this.stores.traces,
        chatSummaries: this.stores.chatSummaries,
        experienceCopilot: this.stores.experienceCopilot,
        // SC-23c: pinned-preset existence for the RP prompt view arm.
        presets: this.stores.presets,
        assembly,
      },
      // SC-17: the variant-attach freeze — the same stores/assembly the sync
      // and context seams read, plus the store's frozen-event append.
      attach: {
        chats: this.stores.chats,
        messages: this.stores.messages,
        assembly,
        experienceCopilot: this.stores.experienceCopilot,
      },
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
      resolveProfileForChat: (thread) =>
        this.profileResolver.resolveForChat(thread.chatId, thread.agentKind),
      ...(contextItemsResolver !== undefined ? { resolveContextItems: contextItemsResolver } : {}),
      db: this.stores.db,
      // SC-10: the ONE extracted store-reads mapping, built WITHOUT the
      // Co-Author skill catalog — the sidechat's search session indexes the
      // library + the branch only (its own skills come through `@` pins).
      searchStoreReads: buildContextSearchStoreReads(this.stores),
      // SC-12: the shared agent-plan store's READ seam — `read_plan` over the
      // thread row's own branch plan (read-only; no plan-write tool exists).
      agentPlans: this.stores.agentPlans,
      // SC-8c: the sidechat's own compaction service — the stream wires the
      //  auto hook to its discussion-against-room rule.
      ...(this.sidechatCompaction !== null ? { compaction: this.sidechatCompaction } : {}),
    };
  }

  /** AS-8b kind dispatch: the thread resolves to its agent kind through the
   *  ONE {@link resolveThreadKind} and runs THAT kind's table entry
   *  ({@link streamKinds}) — no per-kind branch here. A resolved kind without
   *  an entry throws `AgentKindNotWiredError` (the route's assert step already
   *  rejected it before the SSE headers). */
  experienceCopilotStream = async function* (
    this: ExperienceCopilotAdapter,
    threadId: string,
    body: StreamBody,
    signal?: AbortSignal,
  ) {
    const stream = this.getKindStream(await this.resolveThreadKind(threadId));
    yield* stream(threadId, body, signal);
  };

  /** The `experience` table entry: the experience kind's stream deps over the
   *  ER-3 store + script/visual fetchers + provider/model resolution. */
  private async *streamExperienceThread(
    threadId: string,
    body: StreamBody,
    signal?: AbortSignal,
  ): AsyncGenerator<ExperienceCopilotStreamEvent> {
    const contextItemsResolver = this.buildContextItemsResolver(this.copilotSkillService);
    const deps: ExperienceCopilotStreamDeps = {
      store: this.stores.experienceCopilot,
      agentPlans: this.stores.agentPlans,
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
      // SC-0f: a chat-owned thread's profile chain (the chat's own choice →
      // the kind default → the kind's built-in) — the stream consults it only
      // when the thread's owner columns say chat-owned; script/draft threads
      // keep the CP-6 path above byte-identically.
      resolveProfileForChat: (thread) =>
        this.profileResolver.resolveForChat(thread.chatId, thread.agentKind),
      // Two-root catalog user root (CP-4): absent → built-in root only.
      ...(this.copilotSkillService !== undefined
        ? { skillUserRoot: this.copilotSkillService.roots().userRoot }
        : {}),
      // CX-3: pinned-context resolution (shared loader — see
      // buildContextItemsResolver).
      ...(contextItemsResolver !== undefined ? { resolveContextItems: contextItemsResolver } : {}),
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
  }

  experienceCopilotGetActive = async (scriptId: string): Promise<ExperienceCopilotThreadWire | null> => {
    const thread = await this.stores.experienceCopilot.getActive(scriptId);
    return thread ? toThreadWire(thread) : null;
  };

  experienceCopilotListMessages = async (threadId: string): Promise<ExperienceCopilotMessageWire[]> => {
    const messages = await this.stores.experienceCopilot.listMessages(threadId);
    return messages.map((m) => toMessageWire(m));
  };

  experienceCopilotStartNewSession = async (
    scriptId: string,
    title?: string,
  ): Promise<ExperienceCopilotThreadWire> => {
    const thread = await this.stores.experienceCopilot.startNewSession(scriptId, title);
    return toThreadWire(thread);
  };

  experienceCopilotListSessions = async (scriptId: string): Promise<ExperienceCopilotThreadWire[]> => {
    const threads = await this.stores.experienceCopilot.listSessions(scriptId);
    return threads.map((t) => toThreadWire(t));
  };

  experienceCopilotActivate = async (sessionId: string): Promise<ExperienceCopilotThreadWire | null> => {
    const thread = await this.stores.experienceCopilot.activate(sessionId);
    return thread ? toThreadWire(thread) : null;
  };

  experienceCopilotArchive = async (sessionId: string): Promise<ExperienceCopilotThreadWire | null> => {
    const thread = await this.stores.experienceCopilot.archive(sessionId);
    return thread ? toThreadWire(thread) : null;
  };

  experienceCopilotRenameSession = async (
    sessionId: string,
    title: string,
  ): Promise<ExperienceCopilotThreadWire | null> => {
    // Normalize here so every caller (route validator, future callers) gets the
    // same storage semantics: trimmed, empty = "no custom title" (the UI then
    // falls back to the auto-numbered label).
    const thread = await this.stores.experienceCopilot.renameSession(sessionId, title.trim());
    return thread ? toThreadWire(thread) : null;
  };

  // ─── Chat-owner lifecycle (SIDECHAT_PLAN SC-0b) ────────────────────────────

  /** The kind param of the chat-owner routes: a REGISTERED kind that owns its
   *  threads. Both failures are the registry's typed errors
   *  (`UnknownAgentKindError` / `AgentKindNotChatOwnedError`) — the route maps
   *  them to a 400; validated FIRST because it needs no store I/O. Returns
   *  the resolved kind so the caller can read further descriptor facts
   *  (SC-7b's `servesChatModes`) without a second lookup. */
  private requireChatOwnedKind(kindId: string): AgentKind {
    return getChatOwnedAgentKind(kindId);
  }

  agentChatGetActive = async (
    chatId: string,
    branchId: string,
    kind: string,
  ): Promise<ExperienceCopilotThreadWire | null> => {
    const agentKind = this.requireChatOwnedKind(kind);
    const { chat } = await requireChatBranch(this.stores.chats, chatId, branchId);
    // SC-7b: a chat whose mode the kind does not serve READS empty — the
    // active twin of the sessions list's empty array, so a chat whose mode
    // changed after its sessions were born never shows an active session
    // its own list omits (the rows stay; the mode may change back).
    if (!kindServesChatMode(agentKind, chat.mode)) return null;
    const thread = await this.stores.experienceCopilot.getActiveForChat(chatId, branchId, kind);
    return thread ? toThreadWire(thread) : null;
  };

  agentChatListSessions = async (
    chatId: string,
    branchId: string,
    kind: string,
  ): Promise<ExperienceCopilotThreadWire[]> => {
    const agentKind = this.requireChatOwnedKind(kind);
    const { chat } = await requireChatBranch(this.stores.chats, chatId, branchId);
    // SC-7b: listing on a chat whose mode the kind does not serve answers
    // EMPTY, not an error — reads never 400 on the mode (only the create
    // path does; see agentChatStartNewSession).
    if (!kindServesChatMode(agentKind, chat.mode)) return [];
    const threads = await this.stores.experienceCopilot.listSessionsForChat(chatId, branchId, kind);
    return threads.map((t) => toThreadWire(t));
  };

  agentChatStartNewSession = async (
    chatId: string,
    branchId: string,
    kind: string,
    title?: string,
  ): Promise<ExperienceCopilotThreadWire> => {
    const agentKind = this.requireChatOwnedKind(kind);
    const { chat } = await requireChatBranch(this.stores.chats, chatId, branchId);
    // SC-7b: a chat-owned session is born only on a mode the kind serves —
    // the registry's typed error, mapped by the route to the shared 400
    // `{ error, code }` shape naming the kind and the mode. Runs before the
    // store write, so a refused create leaves no row behind.
    requireKindServesChatMode(agentKind, chat.mode);
    const thread = await this.stores.experienceCopilot.startNewChatSession(chatId, branchId, kind, title);
    return toThreadWire(thread);
  };

  // ─── Per-kind model settings (SIDECHAT_PLAN SC-0d) ──────────────────────

  /** Any REGISTERED kind is addressable here (no chat-owner restriction — a
   *  kind's remembered default exists regardless of who owns its threads);
   *  an unregistered kind is the registry's typed `UnknownAgentKindError`,
   *  validated FIRST (no store I/O) and mapped by the route to the shared
   *  400 shape. Returns the resolved kind so the caller reads further
   *  descriptor facts (SC-7b's `servesChatModes`) without a second lookup. */
  private requireRegisteredKind(kindId: string): AgentKind {
    return getAgentKind(kindId);
  }

  agentKindGetSettings = async (kind: string): Promise<AgentKindSettingsWire> => {
    const agentKind = this.requireRegisteredKind(kind);
    // SC-7: the legacy-pair fallback/seed applies only to the pre-split
    // kinds — the descriptor field is the one source of that fact.
    const settings = await this.stores.agentKindSettings.get(kind, {
      inheritLegacyPair: agentKind.inheritsLegacyCopilotPair,
    });
    // SC-7b: the entry carries the kind's served chat modes (the wire map
    // SC-13 hides the sidechat entry from) — read from the descriptor, the
    // one source, never stored.
    return toKindSettingsWire(settings, agentKind.servesChatModes);
  };

  agentKindPatchSettings = async (
    kind: string,
    body: AgentKindSettingsPatchRequest,
  ): Promise<AgentKindSettingsWire> => {
    const agentKind = this.requireRegisteredKind(kind);
    const settings = await this.stores.agentKindSettings.patch(kind, body, {
      inheritLegacyPair: agentKind.inheritsLegacyCopilotPair,
    });
    return toKindSettingsWire(settings, agentKind.servesChatModes);
  };

  // ─── Per-(chat, kind) profile choice (SIDECHAT_PLAN SC-0f) ──────────────

  /** The chat path segment of the SC-0f chat-settings routes: the chat must
   *  exist (404) — these routes carry no branch segment, so there is no
   *  branch-ownership check to pair with it (unlike the shared
   *  requireChatBranch pair check in domain/chat/chat-branch-ownership). */
  private async requireChat(chatId: string): Promise<void> {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) {
      throw notFound("Chat", `Chat '${chatId}' was not found.`);
    }
  }

  agentChatGetSettings = async (
    chatId: string,
    kind: string,
  ): Promise<AgentChatSettingsWire> => {
    // The SC-0b validation order: the kind is chat-owner-validated FIRST
    // (400 class, no store I/O — a script-owned kind on a chat route is the
    // 400 AGENT_KIND_NOT_CHAT_OWNED), then the chat's existence (404).
    this.requireChatOwnedKind(kind);
    await this.requireChat(chatId);
    return toChatSettingsWire(await this.stores.chatAgentSettings.get(chatId, kind));
  };

  agentChatPatchSettings = async (
    chatId: string,
    kind: string,
    body: AgentChatSettingsPatchRequest,
  ): Promise<AgentChatSettingsWire> => {
    this.requireChatOwnedKind(kind);
    await this.requireChat(chatId);
    return toChatSettingsWire(await this.stores.chatAgentSettings.patch(chatId, kind, body));
  };

  /** SC-19a: the events route's read — thin wiring over the domain walk
   *  (sidechat-events.ts): ownership, the loader's own payload mapper, and
   *  the one-pass anchor computation all live there. */
  agentThreadListEvents = async (threadId: string): Promise<AgentThreadEventWire[]> =>
    listAgentThreadEvents({ store: this.stores.experienceCopilot }, threadId);

  // ─── Branch-sidechat fork + summary (SIDECHAT_PLAN SC-20) ────────────────

  /** SC-20: the fork + summary pair — thin wiring over the domain module
   *  (branch-sidechat-fork.ts), which owns the ownership guards, the typed
   *  400, the id remap, the store copy, and the plan copy. */
  private forkDeps() {
    return {
      chats: this.stores.chats,
      messages: this.stores.messages,
      experienceCopilot: this.stores.experienceCopilot,
      plans: this.stores.agentPlans,
    };
  }

  agentBranchForkSidechat = async (
    chatId: string,
    sourceBranchId: string,
    targetBranchId: string,
  ): Promise<AgentBranchForkSidechatResult> => {
    const copied = await forkBranchSidechat(this.forkDeps(), chatId, sourceBranchId, targetBranchId);
    return { copiedThreads: copied.map((thread) => ({ threadId: thread.threadId, agentKind: thread.agentKind })) };
  };

  agentBranchSidechatSummary = async (
    chatId: string,
    branchId: string,
  ): Promise<AgentBranchSidechatSummary> =>
    summarizeBranchSidechat(this.forkDeps(), chatId, branchId);

  experienceCopilotGetContext = async (threadId: string): Promise<ExperienceCopilotContextState> => {
    const thread = await this.stores.experienceCopilot.getById(threadId);
    if (!thread) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
    return {
      metrics: thread.contextMetrics ? toMetricsWire(thread.contextMetrics) : null,
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
      metrics: refreshed?.contextMetrics ? toMetricsWire(refreshed.contextMetrics) : null,
      autoCompact: refreshed?.autoCompact ?? true,
    };
  };

  experienceCopilotGetContextLinks = async (threadId: string): Promise<ExperienceCopilotContextLink[]> =>
    readContextLinks(this.stores.experienceCopilot, threadId);

  experienceCopilotSetContextLinks = async (
    threadId: string,
    links: ExperienceCopilotContextLink[],
  ): Promise<ExperienceCopilotContextLink[]> =>
    replaceContextLinks(this.stores.experienceCopilot, threadId, links);

  experienceCopilotCompact = async (
    threadId: string,
    body: { providerProfileId?: string; model?: string },
    signal?: AbortSignal,
  ): Promise<ExperienceCopilotCompactResult> => {
    if (this.compactionKinds.size === 0) {
      throw notFound("ProviderProfileService", "Copilot compaction is unavailable (no provider profile service).");
    }
    // Dispatch by the thread's kind: a script thread summarizes with the
    // SCRIPT service's prompt, never the experience one.
    const kindId = await this.resolveThreadKind(threadId);
    const compaction = this.compactionKinds.get(kindId);
    if (compaction === undefined) throw new AgentKindNotWiredError(kindId, "compaction");
    const { digest, metrics } = await compaction.compact({
      threadId,
      ...(body.providerProfileId !== undefined ? { providerProfileId: body.providerProfileId } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(signal ? { signal } : {}),
    });
    return { digest: toMessageWire(digest), metrics: toMetricsWire(metrics) };
  };

  /** AP-8: delete one turn — thin wiring over adapters/experience-copilot-
   *  turn-delete.ts (the store sibling call + the error mapping live there;
   *  this file sits at its size cap). */
  experienceCopilotDeleteTurn = (
    threadId: string,
    body: ExperienceCopilotTurnDeleteRequest,
  ): Promise<ExperienceCopilotTurnDeleteResult> =>
    deleteCopilotTurnWire(this.stores.db, threadId, body);

}
