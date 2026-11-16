/**
 * The sidechat kind's DIRECTOR proposal tools (DIRECTOR_MODE_PLAN Wave 1 /
 * DR-4a; widened by DIRECTOR_DECK_CALENDAR_PLAN DK-5a) — `propose_plan`,
 * `propose_tracker_template` and `propose_deck`, the toggles the schema
 * knows. The director (a sidechat profile) never
 * writes the plan, tracker or deck itself: every proposal is a `RecordProposal`
 * the user reviews on an Accept/Reject card (A4), and the apply/reject routes
 * (DR-5's `recordType` dispatch) are the only writers.
 *
 * NOT YET SERVED (DR-4a scope): the stream does not spread this builder yet —
 * the `builtin-director` seed still carries the OOC shell set, and no wiring
 * exists for the tracker delegate's host binding. DR-4b turns the seed's
 * toggles on and wires `buildSidechatDirectorTools` into the stream's
 * buildTools seam; until then a stored `true` for either key is inert at the
 * stream (the TAG-1 pattern — the schema knows the key before the tool is
 * served). The builder is complete and gated here so DR-4b wires it without
 * touching tool logic.
 *
 * `propose_plan({ plan, summary? })` — the branch-plan proposal: validate
 * with the plan schema (the tool input, the same `agentPlanSchema` the
 * `plan` tool takes) + `normalizeAgentPlan`; a rejected plan THROWS the
 * model-correctable text (the `plan` tool's own pattern — the loop surfaces
 * the message as the tool's error result); the normalized plan rides the
 * proposal payload (the card and the apply see the validated plan, never the
 * raw model output).
 *
 * `propose_tracker_template({ action, focusNotes, withClock? })` — the Scene Tracker
 * proposal: delegates generation to `createTrackerDelegate`'s ONE generator
 * (`domain/coauthor/tracker/tracker-delegate.ts`, the Co-Author's own — no
 * copy), grounded in the host RP chat's character card, with the branch
 * plan's premise + rules prepended into `focusNotes` and the chat's current
 * template through `trackerTemplateFromChat` as the refine base. A9: only
 * the `scene` part of the generated template is proposed — goals come from
 * the plan, so the objective part is dropped; a scene-less generation
 * returns error TEXT to the model (self-correction), as a delegate failure
 * does (the Co-Author `set_tracker_template` pattern: tell the model, let it
 * retry or relay). DK-5a: the optional `withClock` flag rides the PROPOSAL
 * PAYLOAD verbatim (the tool never touches the scene) — the registry's
 * tracker-scene APPLY runs the domain's `withStoryClockFields` on the scene
 * being applied, so the canonical story clock fields land exactly once.
 *
 * `propose_deck({ cards, summary? })` — the story-deck proposal (DK-5a, the
 * DMT-34 land-together pattern): the model proposes one or more twist cards
 * for the branch's deck; the payload is `{ cards, summary? }` and the
 * registry's `story-deck` APPLY appends them with FRESH ids (the model's
 * proposed ids are never reused). An EMPTY deck (or any card-shape miss)
 * is refused by the input schema at the loop (the model-correctable
 * validation text — the `propose_plan` self-correction pattern); the
 * execute itself needs no grounding and cannot fail.
 *
 * The proposal `id` is the tool call's own `toolCallId` (the objective tool's
 * convention): one stable id shared by the persisted tool row and the route
 * that resolves it.
 */

// fork #1 of sidechat-objective-tools.ts
// (services/api/src/domain/agent/kinds/sidechat/sidechat-objective-tools.ts —
// forks: 1 there) — the same builder skeleton. Correspondence: the wire-name
// constant, the exported input schema, the allTools + per-key toolSet filter,
// the RecordProposal emission shape (`kind: "record"`, `id: toolCallId`,
// `status: "pending"`), and the IN/OK observability lines. Deviations: TWO
// tools (plan + tracker); validation/delegate failure paths return
// model-facing text; the tracker tool reads its grounding through injected
// loaders and takes the shared `TrackerDelegate`.
// forks: 1 — sidechat-message-tools.ts (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-21:
// the three message tools' builder skeleton + delegate-failure text pattern).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  log,
  normalizeAgentPlan,
  trackerTemplateFromChat,
  type AgentPlan,
  type InsightsConfig,
  type ObjectiveState,
  type TrackerTemplate,
} from "@vibe-tavern/domain";
import {
  agentPlanSchema,
  storyCardSchema,
  type RecordProposal,
} from "@vibe-tavern/api-contracts";
import type { TrackerDelegate } from "../../../coauthor/tracker/tracker-delegate.js";

/** Same observability discipline as the objective tool (CA-17/CANARY). */
const logger = log.tag("sidechat.tool");

/** The plan-proposal tool's wire name — the tool-set toggle key and the
 *  `toolName` the persisted proposal row carries (one spelling, the
 *  objective tool's convention). */
export const SIDECHAT_PROPOSE_PLAN_TOOL_NAME = "propose_plan";

/** The tracker-proposal tool's wire name (same convention). */
export const SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME = "propose_tracker_template";

/** The deck-proposal tool's wire name (same convention; DK-5a). */
export const SIDECHAT_PROPOSE_DECK_TOOL_NAME = "propose_deck";

/** The plan proposal's record type — the DR-5 dispatch table's `story-plan`
 *  key (one spelling shared by the tool, the card and the apply route). */
export const STORY_PLAN_RECORD_TYPE = "story-plan";

/** The tracker proposal's record type — DR-5's `tracker-scene` key. */
export const TRACKER_SCENE_RECORD_TYPE = "tracker-scene";

/** The deck proposal's record type — the dispatch table's `story-deck` key
 *  (DK-5a; one spelling shared by the tool, the card and the apply route). */
export const STORY_DECK_RECORD_TYPE = "story-deck";

/** The plan proposal's input contract: the complete plan object (the same
 *  `agentPlanSchema` the shared `plan` tool validates against) plus an
 *  optional one-line summary for the user's review card. Exported so
 *  validation pins run against the schema the loop enforces. */
export const sidechatPlanProposalInputSchema = z.object({
  plan: agentPlanSchema.describe(
    "The complete story plan: premise, story rules, and the events in order. At most one event may be active.",
  ),
  summary: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("One line for the user explaining what this plan changes. Omit when the plan speaks for itself."),
});

/** The tracker proposal's input contract — `set_tracker_template`'s intent
 *  pair minus everything the director does not own: no `modeHint` (goals come
 *  from the plan — A9), no `summary` (the card composes its own line).
 *  DK-5a adds the optional `withClock` ask: true = the ACCEPTED scene should
 *  carry the canonical story clock fields (day / part of day / date label).
 *  The flag rides the proposal payload verbatim — the apply (the registry's
 *  tracker-scene handler) runs the domain's `withStoryClockFields`, never
 *  duplicating a field the schema already carries. */
export const sidechatTrackerProposalInputSchema = z.object({
  action: z
    .enum(["create", "refine"])
    .describe("Whether to create a new Scene Tracker setup or refine the chat's current one."),
  focusNotes: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "The self-contained brief for the background generator: what to track about the scene, in what words, or what to adjust. The story plan's premise and rules are added automatically — do not repeat them.",
    ),
  withClock: z
    .boolean()
    .optional()
    .describe(
      "Set true when the story should run on a calendar: the accepted tracker schema gains the story clock fields (story day, part of day, date label). Fields the schema already carries are never duplicated.",
    ),
});

/** The deck proposal's input contract (DK-5a): the proposed twist cards
 *  (the wire `storyCardSchema` — one shape source, no hand mirror) plus an
 *  optional one-line summary for the user's review card. The cards must
 *  number at least ONE — an empty deck is a self-correction error the loop
 *  reports as the call's validation text. The card `id`s are the wire
 *  shape's requirement; the APPLY mints fresh deck ids and never reuses a
 *  proposed one. Exported so the registry's parse gate (a safeParse, the
 *  DMT-22 pattern) pins against the same schema the loop enforces. */
export const sidechatDeckProposalInputSchema = z.object({
  cards: z
    .array(storyCardSchema)
    .min(1)
    .describe(
      "The proposed twist cards, each with its suit, title, body and a throwaway id (ids are NOT kept — fresh deck ids are minted when the user accepts). Propose the whole set you want added, in play order.",
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("One line for the user explaining what these twists set up. Omit when the cards speak for themselves."),
});

/** The chat-side grounding the tracker proposal reads through (structural —
 *  the concrete chat row satisfies it; the derivation stays testable here). */
export interface SidechatTrackerGroundingSource {
  readonly insightsConfig: InsightsConfig;
  readonly insightsObjectiveState: ObjectiveState;
}

/** What the builder needs beyond the resolved profile's toggles. The loaders
 *  are injected seams (T1): the stream closes over the turn's thread row and
 *  the host's stores; the delegate is the ONE generator, bound by the host
 *  wiring (absent → the tool serves but refuses loudly at call time, the
 *  Co-Author's own seam shape). */
export interface SidechatDirectorToolsInput {
  /** The RESOLVED profile's tool set (the kind's toggles): only enabled keys
   *  are served — the same filter every sidechat builder applies. */
  readonly toolSet: Record<string, boolean>;
  /** The thread row's own chat + branch pair — the proposal targets
   *  (`story-plan` → the branchId, `tracker-scene` → the chatId) and the
   *  grounding reads' owner. Never the request. */
  readonly owner: { readonly chatId: string; readonly branchId: string };
  /** The shared tracker-template generator (no copy). Absent → invoking the
   *  tracker tool throws "not configured" (the `set_tracker_template`
   *  pattern for unwired hosts). */
  readonly trackerDelegate?: TrackerDelegate;
  /** The host RP chat's character card markdown (the delegate's grounding). */
  readonly loadCharacterProfileMd: () => Promise<string>;
  /** The thread's branch plan — the premise + rules prepended into the
   *  delegate's focus notes. */
  readonly loadBranchPlan: () => Promise<AgentPlan | null>;
  /** The chat row's tracker halves, projected through
   *  `trackerTemplateFromChat` into the delegate's refine base. */
  readonly loadTrackerGrounding: () => Promise<SidechatTrackerGroundingSource | null>;
}

/** Compose the delegate's `focusNotes`: the branch plan's premise + rules
 *  PREPENDED (the generator must know the story it tracks for), then the
 *  model's own notes. Pure. */
function composeTrackerFocusNotes(plan: AgentPlan | null, focusNotes: string | undefined): string {
  const lines: string[] = [];
  const premise = plan?.goal.trim();
  if (premise) lines.push(`Story premise: ${premise}`);
  const rules = plan?.constraints.filter((rule) => rule.trim().length > 0) ?? [];
  if (rules.length > 0) lines.push(`Story rules:\n- ${rules.join("\n- ")}`);
  const notes = focusNotes?.trim();
  if (notes) lines.push(`Focus notes: ${notes}`);
  return lines.join("\n");
}

/** Build the director's three proposal tools. Gated by the resolved profile's
 *  tool set exactly like the objective/checklist builders: a tool whose key
 *  is not enabled is not served. */
export function buildSidechatDirectorTools(input: SidechatDirectorToolsInput): ToolSet {
  const allTools = {
    [SIDECHAT_PROPOSE_PLAN_TOOL_NAME]: tool({
      description:
        "Propose replacing the story plan for this chat branch — the premise, the story rules, and the events in order. " +
        "This is a PROPOSAL: the user reviews it and decides; the plan changes nothing until they accept it, so never assume it was applied. " +
        "Send the complete plan object every time (it replaces the whole plan, it is not a patch). At most one event may be active. " +
        "For reading the current plan use `read_plan` instead.",
      inputSchema: sidechatPlanProposalInputSchema,
      execute: async ({ plan, summary }, options): Promise<RecordProposal> => {
        logger.info(
          "propose_plan IN tasks=%d summary=%s",
          plan.tasks.length,
          summary === undefined ? "(none)" : "yes",
        );
        // The plan tool's own self-correction pattern: normalize, and a
        // rejected plan throws the model-correctable text (the loop surfaces
        // it as the call's error result).
        const normalized = normalizeAgentPlan(plan);
        if (normalized === null) {
          throw new Error("at most one task can be active");
        }
        const proposal: RecordProposal = {
          kind: "record",
          id: options.toolCallId,
          recordType: STORY_PLAN_RECORD_TYPE,
          op: "update",
          targetId: input.owner.branchId,
          payload: summary !== undefined ? { plan: normalized, summary } : { plan: normalized },
          status: "pending",
        };
        logger.info("propose_plan OK id=%s tasks=%d", options.toolCallId, normalized.tasks.length);
        return proposal;
      },
    }),

    [SIDECHAT_PROPOSE_TRACKER_TEMPLATE_TOOL_NAME]: tool({
      description:
        "Propose the Scene Tracker setup for this chat — the schema of scene facts the RP model keeps track of. " +
        "Generation is delegated to a background assistant grounded in the character card and the story plan: describe WHAT to track, never tracker JSON. " +
        "Use `create` for a new setup or `refine` to adjust the chat's current one; carry the user's request in focusNotes. " +
        "Only the Scene Tracker part is proposed — goal tracking comes from the story plan. Nothing is persisted until the user accepts the proposal.",
      inputSchema: sidechatTrackerProposalInputSchema,
      execute: async ({ action, focusNotes, withClock }, options): Promise<RecordProposal | string> => {
        logger.info(
          "propose_tracker_template IN action=%s focusNotesLen=%d withClock=%s",
          action,
          focusNotes?.length ?? 0,
          withClock === undefined ? "(none)" : String(withClock),
        );
        if (!input.trackerDelegate) {
          // The Co-Author's own seam shape: an unwired host serves the tool
          // but refuses loudly at call time.
          throw new Error("propose_tracker_template: tracker template generation is not configured");
        }
        const [characterProfileMd, plan, grounding] = await Promise.all([
          input.loadCharacterProfileMd(),
          input.loadBranchPlan(),
          input.loadTrackerGrounding(),
        ]);
        const currentTemplate: TrackerTemplate | null = grounding === null
          ? null
          : trackerTemplateFromChat(grounding.insightsConfig, grounding.insightsObjectiveState);
        try {
          const result = await input.trackerDelegate({
            action,
            focusNotes: composeTrackerFocusNotes(plan, focusNotes),
            characterProfileMd,
            currentTemplate,
          });
          // A9: keep ONLY the scene part — a generated objective section is
          // dropped (goals come from the plan), and a scene-less generation
          // is a miss the model can correct, not a failure to relay.
          const scene = result.trackerTemplate.scene;
          if (scene === null) {
            logger.warn("propose_tracker_template NO_SCENE id=%s", options.toolCallId);
            return (
              "propose_tracker_template: the generated setup had no scene section to propose. " +
              "Call again with focusNotes that clearly describe WHICH scene facts to track."
            );
          }
          // DK-5a: the withClock ask rides the payload VERBATIM (absent when
          // the model omitted it) — the flag itself is the proposal's
          // contract; the apply owns the scene transformation.
          const proposal: RecordProposal = {
            kind: "record",
            id: options.toolCallId,
            recordType: TRACKER_SCENE_RECORD_TYPE,
            op: "update",
            targetId: input.owner.chatId,
            payload: withClock !== undefined ? { scene, withClock } : { scene },
            status: "pending",
          };
          logger.info("propose_tracker_template OK id=%s sceneEnabled=%s withClock=%s", options.toolCallId, scene.enabled, withClock === true);
          return proposal;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          logger.warn("propose_tracker_template FAILED reason=%s", reason);
          return (
            `propose_tracker_template: tracker template generation failed: ${reason}. ` +
            "Please tell the user and ask whether they want to try again."
          );
        }
      },
    }),

    [SIDECHAT_PROPOSE_DECK_TOOL_NAME]: tool({
      description:
        "Propose twist cards for this chat branch's story deck — the deck the user draws from to steer the story. " +
        "Each card is one twist: its suit (threat, encounter, discovery, mystery or change), a short title, and a body saying what happens when it is played. " +
        "This is a PROPOSAL: the user reviews it and decides; the deck changes nothing until they accept it, so never assume the cards were added. " +
        "Propose complete, ready-to-play cards — an empty proposal is refused.",
      inputSchema: sidechatDeckProposalInputSchema,
      execute: async ({ cards, summary }, options): Promise<RecordProposal> => {
        logger.info(
          "propose_deck IN cards=%d summary=%s",
          cards.length,
          summary === undefined ? "(none)" : "yes",
        );
        const proposal: RecordProposal = {
          kind: "record",
          id: options.toolCallId,
          recordType: STORY_DECK_RECORD_TYPE,
          op: "update",
          targetId: input.owner.branchId,
          payload: summary !== undefined ? { cards, summary } : { cards },
          status: "pending",
        };
        logger.info("propose_deck OK id=%s cards=%d", options.toolCallId, cards.length);
        return proposal;
      },
    }),
  };

  // The kind's toggles (the resolved profile's set): only enabled keys are
  // served — the same filter the objective and checklist builders apply.
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => input.toolSet[name] === true),
  ) as typeof allTools;
}
