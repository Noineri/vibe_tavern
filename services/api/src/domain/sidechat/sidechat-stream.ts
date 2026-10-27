/**
 * Sidechat-OOC streaming (SIDECHAT_PLAN, Wave 1 / SC-4b) — the
 * `sidechat-ooc` kind's wiring into the generic agent turn loop
 * (`agent-stream.ts`), the way `script-agent-stream.ts` supplies the script
 * seams: the loop owns thread load, turn-input persistence, provider stream
 * consumption, SSE relay, ordered persistence and metrics; THIS module owns
 * the kind's turn knowledge — the RP sync + context package (loadContext),
 * the chat-owned profile chain, and the sidechat assembly (base prompt +
 * the SC-3b package as the system message's volatile tail).
 *
 * TURN ORDER (the unit's contract): chat + branch come from the THREAD ROW
 * (never the request); `syncBeforeUserMessage` (SC-2c) runs inside the
 * loadContext seam — BEFORE the generic loop persists the user message and
 * BEFORE the SC-3b loader's `listTimeline` read, so this turn's freshly
 * frozen RP delta sits at a seq BELOW the user message's on the merged
 * timeline; since SC-17 the same seam also freezes the turn's ATTACHED RP
 * VARIANTS (`attachedVariants` → `variants_attached` events, one per
 * attached message in position order, texts transformed through SC-2a's
 * reader, `selected` read from the RP's own state, all-or-nothing on
 * validation) between the sync and the load.
 * Since SC-4d (variant A) the system message carries the loader's
 * STATIC package only (character/persona/active_lore/objectives/
 * current_scene); the frozen events ride the MESSAGE FLOW as their own
 * user-role message bodies, placed by the merged timeline's order (the
 * loader's placement counts), so the OOC conversation reaches the model
 * exactly once — as the real history rows. The reply persists through the
 * generic loop exactly like the other kinds'.
 *
 * Since SC-10 the kind serves its first tools: `search_context` /
 * `read_context_item` (kinds/sidechat/sidechat-search-tools.ts) over a
 * per-turn `ContextSearchSession` built in the buildTools seam — the ONE
 * extracted store-reads mapping (no Co-Author skill catalog), the chat's
 * active scope, and the branch view the turn's sync ALREADY read ("one view
 * per turn" — a search never runs a second branch read or dry RP assembly).
 * Served only when the resolved profile's tool set enables them; absent
 * mapping (tests, legacy harnesses) → no search tools. Since SC-11 the
 * kind also serves `propose_objective` (kinds/sidechat/
 * sidechat-objective-tools.ts) — the proposal-returning twin that needs no
 * per-turn state, so it rides the SAME seam and the SAME profile gating
 * even when the search mapping is absent.
 *
 * NO tools until Wave 3 — since SC-10 the search pair, since SC-11 also the
 * objective-proposal tool, and since SC-12 the closing pair: `todo` (the
 * session checklist — the shared standalone factory, persisted through the
 * thread store's `updateTodo`) and `read_plan` (the shared agent-plan tools
 * in read-only mode — the plan owner is the thread row's chat + branch, and
 * NO plan-write tool exists in the set), both from
 * `kinds/sidechat/sidechat-checklist-tools.ts`. Since SC-23e the kind also
 * serves its PERMISSION tool `read_message_prompt` (the reply-prompt read
 * with the user's ask-first gate — `kinds/sidechat/sidechat-prompt-read-
 * tools.ts`): the turn stops on its awaiting marker and resumes on the
 * user's allow/deny answer, the first consumer of the generalized
 * split-turn mechanism (`agent-split-turn.ts`). Since SC-6 the
 * assembly runs the SHELL's existing budget trim (planHistoryCompaction)
 * over the merged flow: over the shared budget the OLDEST flow entries drop
 * first, RP and discussion alike, in time order. Since SC-8c the flow
 * follows a compaction digest split (the SC-4d count guard is gone — see
 * buildSidechatMessageFlow): the digest rides the flow as its own user-role
 * message after the pre-boundary RP layer, and the kind's auto-compaction
 * measures the discussion against the room left after the static context
 * and the RP layer through the compaction seam.
 *
 * Since DR-4b (DIRECTOR_MODE_PLAN) the stream also serves the kind's
 * DIRECTOR tools — `propose_plan` + `propose_tracker_template`
 * (`kinds/sidechat/sidechat-director-tools.ts`, DR-4a's builders spread
 * into buildTools over the resolved profile's set, closing TAG-1) — and the
 * SHARED `ask_user` factory (owner ruling 2026-10-27, DR-4b ruling B:
 * `domain/agent/agent-ask-user-tool.ts`, the ONE implementation the
 * experience/script kinds also consume), each gated by the resolved
 * profile's toggles exactly like every other sidechat tool. The turn now
 * stops on EITHER wait family: the ask marker (ask_user) or the permission
 * marker (read_message_prompt).
 */

// fork #1 of script-agent-stream.ts (services/api/src/domain/agent/script-agent/script-agent-stream.ts)
// — the seams-wiring skeleton (deps interface shape, the seams object's
// loadContext/resolveProfile/assemble/buildTools entries, the streamDeps
// handoff, the generator tail). The seam BODIES are the sidechat's own: the
// sync+package load, the chat-owned-only profile chain, and the sidechat
// assembly have no script analog. Correspondence map: loadContext ←
// loadScriptAgentContext, resolveProfile ← the script 3-way chain (narrowed:
// sidechat threads are ALWAYS chat-owned), assemble ← the AS-7 assembly call
// (replaced by the SC-4b assembly below, reshaped by SC-4d: the STATIC
// package rides the system message and the frozen events interleave into
// the message flow), buildTools ← buildScriptAgentTools (SC-10: the sidechat
// search pair, profile-gated), limits/logChannelPrefix/streamDeps ← verbatim
// shape.

import { streamText, hasToolCall, type ToolSet } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderProfile, AppDb, ExperienceCopilotStore, ExperienceCopilotThread } from "@vibe-tavern/db";
import type { AgentPlan, AgentPlanOwner } from "@vibe-tavern/domain";
import { brandId, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import type { CopilotProfile, ExperienceCopilotContextLink } from "@vibe-tavern/api-contracts";
import type { ProviderFetch } from "../providers/provider-fetch-factory.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { validation } from "../../shared/errors.js";
import {
  streamAgentTurn, isAgentContentTurn,
  type AgentStreamDeps,
  type AgentStreamSeams,
} from "../agent/agent-stream.js";
import type { AgentOwnModelBinding } from "../agent/agent-own-model.js";
import type { AgentTurnDeleteTurn } from "../agent/agent-regenerate.js";
import { renderAttachedContext, type CopilotContextItem } from "../agent/agent-context.js";
import { isChatOwnedAgentThread } from "../agent/agent-thread-owner.js";
import { getAgentKind } from "../agent/agent-kind-registry.js";
import {
	createContextSearchSession,
	type ContextSearchStoreReads,
} from "../context/context-search-service.js";
import { buildSidechatSearchTools } from "../agent/kinds/sidechat/sidechat-search-tools.js";
import { buildSidechatObjectiveTools } from "../agent/kinds/sidechat/sidechat-objective-tools.js";
import { buildSidechatChecklistTools } from "../agent/kinds/sidechat/sidechat-checklist-tools.js";
import {
  buildSidechatDirectorTools,
} from "../agent/kinds/sidechat/sidechat-director-tools.js";
import { createAskUserTool, AGENT_ASK_USER_TOOL_NAME } from "../agent/agent-ask-user-tool.js";
import type { TrackerDelegate } from "../coauthor/tracker/tracker-delegate.js";
import {
  buildSidechatPromptReadTools,
  runGrantedPromptRead,
  SIDECHAT_PROMPT_READ_TOOL_NAME,
  type SidechatPromptReadTurnState,
} from "../agent/kinds/sidechat/sidechat-prompt-read-tools.js";
import { hasAwaitingPermissionMarker } from "../agent/agent-split-turn.js";
import type { SidechatAutoCompactPressure, SidechatOocCompactionService } from "./sidechat-compaction.js";
// The value import doubles as the side effect: importing the kind module
// registers the `sidechat-ooc` kind at module init, so the descriptor read
// below (the recency anchor) resolves in ANY process that streams a turn
// (tests included — they do not go through server-runtime).
import { resolveBuiltinSidechatOocProfile } from "../agent/kinds/sidechat-ooc-kind.js";
import { COPILOT_CONTEXT_BUDGET_TOKENS, COPILOT_RESPONSE_RESERVE_TOKENS, COPILOT_TOOL_LOOP_CEILING } from "../interactive/copilot/copilot-limits.js";
import { RpSyncThreadNotChatOwnedError, syncBeforeUserMessage, type RpSyncDeps } from "./rp-sync.js";
import { attachVariantsBeforeUserMessage, type VariantAttachDeps } from "./sidechat-variant-attach.js";
import type { AttachedVariantPair, RpBranchView } from "./rp-branch-view.js";
import {
  loadSidechatContext,
  type SidechatContextDeps,
  type SidechatContextPackage,
} from "./sidechat-context.js";
import { assembleSidechatPrompt, type SidechatAssembledPrompt } from "./sidechat-assembly.js";
import type { ExperienceCopilotStreamRequest, ExperienceCopilotStreamEvent } from "../interactive/copilot/experience-copilot-stream-contract.js";
import { buildSidechatCoreDeps } from "./sidechat-core-deps.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface SidechatStreamDeps {
  readonly resolveVisionAssets?: AgentStreamDeps['resolveVisionAssets'];
  /** The shared agent-thread store (thread + message persistence — the
   *  sidechat's threads live in the same store as every kind's). */
  readonly store: ExperienceCopilotStore;
  /** The SC-2c RP-sync writer's deps (chats / messages / assembly /
   *  experienceCopilot) — passed through verbatim to
   *  {@link syncBeforeUserMessage} each turn. */
  readonly sync: RpSyncDeps;
  /** The SC-3b context loader's deps (chats / characters / messages /
   *  traces / experienceCopilot / assembly) — passed through verbatim to
   *  {@link loadSidechatContext} after the sync. */
  readonly context: SidechatContextDeps;
  /** SC-17: the variant-attach freeze's deps (the "discuss in the sidechat"
   *  flow — the SC-2a reader deps + the thread row read + the frozen-event
   *  append) — passed through verbatim to
   *  {@link attachVariantsBeforeUserMessage}
   *  between the sync and the SC-3b load, only on turns that carry
   *  `attachedVariants`. In production the same store instances the sync and
   *  context seams read; the seam exists so the freeze is its own typed
   *  contract, not a widening of the sync's. */
  readonly attach: VariantAttachDeps;
  /** Resolve a raw provider profile by id. */
  readonly getProviderProfile: (id: string) => Promise<ProviderProfile | null>;
  /** Resolve the effective profile (base + per-model overlay). */
  readonly getEffectiveProviderProfile: (id: string, model: string) => Promise<ProviderProfile>;
  /** Resolve a `LanguageModel` from a profile + model name. */
  readonly resolveModel: (
    profile: { providerPreset: string; endpoint: string; apiKey: string | null },
    model: string,
    fetch?: ProviderFetch,
  ) => LanguageModel;
  /** Resolve the profile for the CHAT-OWNED thread (its chatId + agentKind
   *  owner columns — every sidechat thread is chat-owned): the chat's own
   *  choice → the kind default → the kind's built-in seed, with dangling ids
   *  falling through (`CopilotProfileResolver.resolveForChat`, SC-0f).
   *  Absent (tests, legacy harnesses) → the built-in `sidechat-ooc` seed
   *  (with the `sidechat_ooc_base` SP-5 override when `db` is present). */
  readonly resolveProfileForChat?: (thread: {
    readonly chatId: string;
    readonly agentKind: string;
  }) => Promise<CopilotProfile>;
  /** DR-2 (M1): read a resolved profile's own-model binding from the
   *  agent_profile_models store (the adapter's provider-deps wiring — one
   *  source for every kind). Absent (tests, legacy harnesses) → the turn
   *  keeps the request's pair, exactly as before this seam existed. */
  readonly getAgentOwnModel?: (profile: CopilotProfile) => Promise<AgentOwnModelBinding | null>;
  /** CX-3: resolve the thread's pinned-context links into rendered-block
   *  input (the same kind-agnostic loader the other kinds' streams use).
   *  Absent (tests, legacy harnesses) → no attached context. */
  readonly resolveContextItems?: (
    links: readonly ExperienceCopilotContextLink[],
  ) => Promise<CopilotContextItem[]>;
  /** Optional DB handle for the `sidechat_ooc_base` seed override on the
   *  built-in fallback path. */
  readonly db?: AppDb;
  /** SC-10: the store-reads mapping for the turn's context-search session —
   *  the ONE extracted mapping (context-search-store-reads.ts), built WITHOUT
   *  a Co-Author skill catalog (the sidechat's session indexes no skill
   *  records; its own skills come through `@` pins, SC-5). Absent (tests,
   *  legacy harnesses) → the stream serves no search tools. */
  readonly searchStoreReads?: ContextSearchStoreReads;
  /** SC-12: the shared agent-plan store's READ seam for `read_plan`. The
   *  sidechat's plan access is read-only — the branch-plan write belongs to
   *  the director kind (owner ruling 7), so no `plan` tool exists — and the
   *  owner the stream reads through is the THREAD ROW's chat + branch,
   *  never the request. */
  readonly agentPlans: {
    get(owner: AgentPlanOwner): Promise<AgentPlan | null>;
  };
  /** DR-4b: build the tracker-template generator the director's
   *  `propose_tracker_template` delegates to. Production wires the SAME
   *  session binding the Co-Author's tracker generator uses
   *  (`createSessionTrackerDelegate` — the lore pair → Co-Author provider
   *  fallback; NO new setting). A factory, resolved lazily PER CALL, so an
   *  OOC turn (no director toggles) reads no provider settings and a settings
   *  change lands on the next call. Absent (tests, legacy harnesses) → the
   *  stream passes no delegate and the tool refuses loudly at call time (the
   *  Co-Author `set_tracker_template` seam shape). */
  readonly buildTrackerDelegate?: () => Promise<TrackerDelegate | undefined>;
  /** SC-8c: the kind's own compaction service — present → the stream wires
   *  the loop's autoCompact hook to the sidechat rule (the discussion
   *  against the room left after the static context and the RP layer).
   *  Absent (tests, legacy harnesses) → the sidechat's threads never
   *  auto-compact; the manual compact route still works through the
   *  adapter's compactionKinds entry. */
  readonly compaction?: SidechatOocCompactionService;
  /** Injectable streamText (tests substitute a fake without `mock.module("ai")`). */
  readonly streamText?: typeof streamText;
  /** AP-9: the thread's row-deletion seam for regenerate mode (the AP-8 store
   *  sibling over the real db — the adapter supplies it; the sidechat's
   *  event-preservation rule is the store sibling's own). Absent (tests,
   *  legacy harnesses) → regenerate turns are refused, never trimmed. */
  readonly deleteTurn?: AgentTurnDeleteTurn;
}

// ─── Kind context ────────────────────────────────────────────────────────────

/** The turn-start sidechat context — SC-3b's load, reshaped by SC-4d: the
 *  STATIC package string (loaded AFTER the RP sync) + the frozen events as
 *  flow-ready user-message bodies placed by the merged timeline's order.
 *  Since SC-10 the helper also returns the sync's SC-2a branch view: the
 *  turn's search session consumes THIS view ("one view per turn") — never a
 *  second branch read or dry RP assembly per search. The package parts are
 *  the shape SC-4b's assembly below consumes directly.
 *
 *  Since SC-17 the turn may carry attached RP variants (`attachedVariants`,
 *  the request's pairs): they freeze BETWEEN the sync and the SC-3b load —
 *  above the sync's events, below the user message the generic loop persists
 *  next, and already visible to the load's listTimeline read so THIS turn's
 *  prompt carries the frozen `<rp_variants>` rows. */
async function loadSidechatTurnContext(
  deps: SidechatStreamDeps,
  threadId: ExperienceCopilotThread["id"],
  attachedVariants?: readonly AttachedVariantPair[],
): Promise<SidechatContextPackage & { branchView: RpBranchView }> {
  const branchView = await syncBeforeUserMessage(deps.sync, threadId);
  // SC-17: the variant-attach freeze — AFTER SC-2c's sync (its events land at
  // seqs above the sync's delta), BEFORE the loop persists the user message
  // (they anchor below it on the merged timeline) and BEFORE the SC-3b
  // loader's listTimeline read (this turn's prompt already sees them). A
  // foreign pair throws the typed validation before any freeze — the turn
  // refuses, nothing is written.
  if (attachedVariants !== undefined && attachedVariants.length > 0) {
    await attachVariantsBeforeUserMessage(deps.attach, threadId, attachedVariants);
  }
  return { ...(await loadSidechatContext(deps.context, threadId)), branchView };
}

// The ASSEMBLY lives in `sidechat-assembly.ts` since DR-4b (arch-gate
// extraction — `assembleSidechatPrompt` + the flow builder + the meter,
// byte-identical; the seams below call it at the `assemble` entry).

// ─── Main streaming function ─────────────────────────────────────────────────

/**
 * Stream one sidechat-OOC turn: the RP sync + SC-3b load (loadContext),
 * the chat-owned profile chain, and the SC-4b/SC-4d assembly wired into the
 * generic agent turn loop. Yields the same SSE-shaped `{ event, data }`
 * chunks the route relays verbatim; throws `notFound` for a missing thread
 * and `RpSyncThreadNotChatOwnedError` for a thread this kind cannot own (a
 * script-owned/draft row can never resolve to `sidechat-ooc`, so that
 * refusal is the corruption guard, not an expected path).
 */
export async function* streamSidechatTurn(
  request: ExperienceCopilotStreamRequest,
  deps: SidechatStreamDeps,
  signal?: AbortSignal,
): AsyncGenerator<ExperienceCopilotStreamEvent> {
  // The kind's shared owner-fixed limits — one object feeds both consumers
  // (the loop's metrics + tool ceiling, and the assembly's SC-6 trim).
  const limits = {
    contextBudgetTokens: COPILOT_CONTEXT_BUDGET_TOKENS,
    responseReserveTokens: COPILOT_RESPONSE_RESERVE_TOKENS,
    toolLoopCeiling: COPILOT_TOOL_LOOP_CEILING,
  };
  // SC-8c: this turn's auto-compaction pressure — written by the assemble
  // seam, read by the auto hook the generic loop fires after the turn's
  // metrics persist. Per-turn state of THIS generator call only.
  let autoCompactPressure: SidechatAutoCompactPressure | null = null;
  // SC-10: this turn's branch view — written by the loadContext seam (the
  // sync's SC-2a view), read by the buildTools seam's search session. Per-turn
  // state of THIS generator call only, exactly like the pressure above.
  // SC-23e: the turn's held lore set — same capture pattern, read by the
  // reply-prompt read tool's state (the marker's and the granted re-run's
  // held set are the CURRENT turn's, so lore edits show on the next ask).
  let turnBranchView: RpBranchView | null = null;
  let turnHeldLoreEntryIds: ReadonlySet<string> = new Set();
  const seams: AgentStreamSeams<
    ExperienceCopilotStreamRequest,
    ExperienceCopilotThread,
    SidechatContextPackage,
    CopilotProfile,
    SidechatAssembledPrompt
  > = {
    logChannelPrefix: "api.sidechat-ooc",
    threadLabel: "ExperienceCopilotThread",
    limits,

    // ── The kind's turn: RP sync FIRST, then the SC-17 variant-attach freeze
    //  (only on turns that carry `attachedVariants`), then the SC-3b load
    //  (static package + flow-placed events). This seam runs BEFORE the
    //  generic loop persists the user message, which is what puts the frozen
    //  delta — sync and attached variants alike — below the turn's own seq on
    //  the merged timeline. Since SC-10 the sync's branch view is captured for
    //  the turn's search session (below). ──
    loadContext: async (thread) => {
      const loaded = await loadSidechatTurnContext(deps, thread.id, request.attachedVariants);
      turnBranchView = loaded.branchView;
      turnHeldLoreEntryIds = loaded.heldLoreEntryIds;
      return loaded;
    },

    // ── Agent profile: sidechat threads are ALWAYS chat-owned (the kind
    //  owns its threads), so the chat chain is the only path — the SC-0f
    //  seam when wired, the built-in seed otherwise (tests). The owner test
    //  also narrows the thread for the seam AND refuses a non-chat-owned row
    //  (unreachable through the dispatch; the corruption guard). ──
    resolveProfile: (thread) =>
      deps.resolveProfileForChat && isChatOwnedAgentThread(thread)
        ? deps.resolveProfileForChat(thread)
        : resolveBuiltinSidechatOocProfile(deps.db),
    // DR-2 (M1): the resolved profile's own model, consulted by the loop
    // BEFORE the provider resolution so it can take precedence over the
    // request's pair (a dangling provider falls through inside the loop).
    ...(deps.getAgentOwnModel !== undefined ? { resolveOwnModel: deps.getAgentOwnModel } : {}),

    // ── SC-4b/SC-4d assembly (digest-aware since SC-8c): base prompt +
    //  STATIC package in the system message, frozen events interleaved into
    //  the flow, the digest seated after the pre-boundary RP layer (+ pinned
    //  context + anchor before the turn's own user message). The assembly's
    //  auto-compaction pressure is captured for the turn's auto hook — the
    //  loop fires it only after a COMPLETED turn, by which time this seam
    //  has run, so the closure below always reads this turn's numbers. ──
    assemble: async ({ thread, request, kindContext: context, agentProfile, history, model }) => {
      const contextItems =
        deps.resolveContextItems && thread.contextLinks.length > 0
          ? await deps.resolveContextItems(thread.contextLinks)
          : [];
      const attachedContextBlock = renderAttachedContext(contextItems);
      logSendDebug("api.sidechat-ooc.attached-context-resolved", {
        threadId: request.threadId,
        linkCount: thread.contextLinks.length,
        itemCount: contextItems.length,
        blockLength: attachedContextBlock.length,
      });
      const assembled = assembleSidechatPrompt({
        basePrompt: agentProfile.basePrompt,
        context,
        history,
        hasUserPush: isAgentContentTurn(request),
        attachedContextBlock,
        recencyAnchorText: getAgentKind("sidechat-ooc").recencyAnchorText,
        contextBudgetTokens: limits.contextBudgetTokens,
        responseReserveTokens: limits.responseReserveTokens,
        ...(model !== undefined ? { model } : {}),
      });
      autoCompactPressure = assembled.autoCompactPressure;
      return assembled;
    },

    // ── SC-10 + SC-11 + SC-12 + SC-23e: the kind's tools. The search pair
    //  (kinds/sidechat/sidechat-search-tools.ts) over a per-turn session:
    //  the ONE extracted store-reads mapping (NO Co-Author skill catalog —
    //  the sidechat's skills come through `@` pins, SC-5), the chat's active
    //  scope, and THIS turn's branch view (the sync's — never a second
    //  branch read or dry RP assembly). SC-11 adds `propose_objective`
    //  (kinds/sidechat/sidechat-objective-tools.ts), which needs no
    //  per-turn state and therefore rides the same profile gating even
    //  when the search mapping is absent. SC-12 closes that set: `todo`
    //  (the shared session-checklist factory, persisted through the
    //  thread store's `updateTodo` — kinds/sidechat/sidechat-checklist-
    //  tools.ts) and `read_plan` (the shared plan tools READ-ONLY over the
    //  thread row's own chat + branch — no plan-write tool is ever built).
    //  SC-23e adds the kind's PERMISSION tool `read_message_prompt`
    //  (kinds/sidechat/sidechat-prompt-read-tools.ts): the reply-prompt read
    //  over the thread row's own branch, rendered against THIS turn's held
    //  set (the context loader's), asking the user on every call. Served
    //  only when the RESOLVED profile's tool set enables them (a tool
    //  landed with its toggle off is not landed; for the permission tool
    //  the toggle gates availability, never the permission); the ownership
    //  narrowing is the same corruption guard resolveProfile uses. ──
    buildTools: ({ thread, agentProfile, kindContext }) => {
      if (!isChatOwnedAgentThread(thread)) return {};
      // A null branchId on a chat-owned row is corruption — loadContext's
      // sync (SC-2c) already refused it before this seam, so this throw is
      // unreachable in practice; it narrows the type for the plan owner
      // below (never read through, same guard as the context loader).
      if (thread.branchId === null) throw new RpSyncThreadNotChatOwnedError(thread.id);
      // The thread row's own pair, captured ONCE after the null-guard — a
      // const keeps the narrowing inside the loaders' closures below (a
      // `thread.branchId` read inside a closure re-widens to `string | null`).
      const threadOwner = { chatId: thread.chatId, branchId: thread.branchId };
      const promptReadState: SidechatPromptReadTurnState = {
        chatId: brandId<ChatId>(thread.chatId),
        branchId: brandId<ChatBranchId>(thread.branchId),
        heldLoreEntryIds: kindContext.heldLoreEntryIds,
      };
      const search =
        deps.searchStoreReads !== undefined
          ? buildSidechatSearchTools({
              session: createContextSearchSession(
                deps.searchStoreReads,
                async () => {
                  const chat = await deps.context.chats.getById(thread.chatId);
                  return {
                    activeCharacterId: chat?.characterId ?? null,
                    activePersonaId: chat?.personaId ?? null,
                  };
                },
                () => Promise.resolve(turnBranchView),
              ),
              toolSet: agentProfile.toolSet,
            })
          : {};
      const checklist = buildSidechatChecklistTools({
        toolSet: agentProfile.toolSet,
        // The plan owner is the THREAD ROW's own pair — never the request
        // (SC-12's contract; the same row the sync/context seams read).
        owner: { chatId: thread.chatId, branchId: thread.branchId },
        // updateTodo(threadId, items) is the store's structural twin of the
        // checklist factory's `(items) => Promise<void>` dep (the same seam
        // the experience kind wires).
        saveTodo: (items) => deps.store.updateTodo(thread.id, items),
        agentPlans: deps.agentPlans,
      });
      const promptRead = buildSidechatPromptReadTools({
        toolSet: agentProfile.toolSet,
        deps: { messages: deps.context.messages, traces: deps.context.traces },
        state: promptReadState,
      });
      // DR-4b (closes TAG-1): the director's two proposal tools — DR-4a's
      // builders spread here, gated by the RESOLVED profile's set like every
      // other sidechat family (a stored `true` is live from this unit). The
      // loaders close over the turn's own thread row and the host's stores
      // (T1 seams — the same chats/characters/agentPlans reads the other
      // seams use); the tracker delegate resolves lazily PER CALL through the
      // deps' factory, so a turn that never calls the tool pays no
      // provider-settings read, and a binding that resolves to no provider
      // (nothing selected) refuses loudly at call time — the tool's own
      // not-configured contract.
      const buildTrackerDelegate = deps.buildTrackerDelegate;
      const director = buildSidechatDirectorTools({
        toolSet: agentProfile.toolSet,
        // The proposal targets + grounding owner: the THREAD ROW's pair,
        // never the request (the same row the checklist tools read).
        owner: threadOwner,
        ...(buildTrackerDelegate !== undefined
          ? {
              trackerDelegate: async (input, signal) => {
                // Resolved fresh per call — the same freshness the Co-Author's
                // per-assembly build gives its own tracker tool.
                const delegate = await buildTrackerDelegate();
                if (delegate === undefined) {
                  throw new Error(
                    "propose_tracker_template: tracker template generation is not configured — " +
                      "no Co-Author or lore provider is selected",
                  );
                }
                return delegate(input, signal);
              },
            }
          : {}),
        // The host RP chat's card, raw (the delegate's grounding — the same
        // document the Co-Author's tracker tool grounds on); a chat with no
        // character grounds on the empty card.
        loadCharacterProfileMd: async () => {
          const chat = await deps.context.chats.getById(thread.chatId);
          if (chat === null || chat.characterId === null) return "";
          return deps.context.characters.getProfileMdText(chat.characterId);
        },
        loadBranchPlan: () =>
          deps.agentPlans.get({
            kind: "chatBranch",
            chatId: threadOwner.chatId,
            branchId: threadOwner.branchId,
          }),
        // The chat row IS the grounding source (its tracker halves feed
        // trackerTemplateFromChat); a missing chat row (deleted mid-turn)
        // grounds on nothing.
        loadTrackerGrounding: () => deps.context.chats.getById(thread.chatId),
      });
      // DR-4b ruling B: the SHARED ask_user factory (the ONE implementation
      // the experience/script kinds also consume), gated by the resolved
      // profile's toggle — on for the director seed, off for the OOC seed.
      const askUser: ToolSet =
        agentProfile.toolSet[AGENT_ASK_USER_TOOL_NAME] === true
          ? { [AGENT_ASK_USER_TOOL_NAME]: createAskUserTool() }
          : {};
      return {
        ...search,
        ...buildSidechatObjectiveTools({ toolSet: agentProfile.toolSet }),
        ...checklist,
        ...promptRead,
        ...director,
        ...askUser,
      };
    },

    // ── SC-23e + DR-4b: the kind's wait-tool stop conditions — BOTH wait
    //  families the kind now serves. `read_message_prompt` (the permission
    //  tool) stops on its AWAITING MARKER, never on the call (a call that
    //  answers unknown_prompt / unresolved does not stop the turn — the
    //  model relays that answer in the same turn); `ask_user` (owner ruling
    //  2026-10-27) stops on the call — the mechanism's own default condition
    //  for the ask family, whose every call awaits by construction. ──
    waitStopConditions: [
      hasToolCall(AGENT_ASK_USER_TOOL_NAME),
      hasAwaitingPermissionMarker(SIDECHAT_PROMPT_READ_TOOL_NAME),
    ],

    // ── SC-23e: the granted re-run for an allowed permission request — the
    //  same resolution the marker came from, against the ANSWER turn's fresh
    //  held set (loadContext has already run by the time the split-turn
    //  applies the answer). The chat/branch pair comes from the loop's
    //  THREAD row — the same row every other seam reads, never the request. ──
    runWaitTool: (thread, toolName, toolInput) => {
      if (toolName !== SIDECHAT_PROMPT_READ_TOOL_NAME) {
        throw validation(`The sidechat serves no permission tool '${toolName}'.`);
      }
      if (!isChatOwnedAgentThread(thread) || thread.branchId === null) {
        throw new RpSyncThreadNotChatOwnedError(thread.id);
      }
      return runGrantedPromptRead(
        { messages: deps.context.messages, traces: deps.context.traces },
        {
          chatId: brandId<ChatId>(thread.chatId),
          branchId: brandId<ChatBranchId>(thread.branchId),
          heldLoreEntryIds: turnHeldLoreEntryIds,
        },
        toolInput,
      );
    },
  };

  const streamDeps = buildSidechatCoreDeps(deps, () => autoCompactPressure);

  yield* streamAgentTurn(request, streamDeps, seams, signal);
}
