/**
 * Story-plan ↔ goal-tracker sync (DIRECTOR_MODE_PLAN DR-3a).
 *
 * Owner rulings this module implements (Russian verbatim quotes live in the
 * plan document, DIRECTOR_MODE_PLAN.md — the code repo stays Cyrillic-free):
 *  - 3a (2026-10-16 (3)): the tracker executes the task — the current event
 *    becomes the active goal, the tracker injects and checks it, and a
 *    completed goal advances the plan with no extra model calls. The
 *    projection maps plan events onto goals-mode short-term goals; a
 *    completed goal flows back into the plan (follow-back).
 *  - A2: the premise never reaches the RP prompt — the projection always
 *    nulls the tracker's long-term goal; the RP model sees only the current
 *    event.
 *  - A3: a projected goal's text is the event title, plus "\n" and the body
 *    when the body is non-blank.
 *  - A5: applying a plan to the ACTIVE branch switches the tracker to goals
 *    mode, replaces its goals with the plan's events, and turns the tracker
 *    on when events exist.
 *  - A8: an empty plan projects to an empty goals list and leaves the
 *    `objectiveEnabled` toggle as is.
 *  - R2 (2026-10-25): the plan belongs to the branch — the tracker (one per
 *    chat) is re-filled from the ACTIVE branch's plan
 *    (`reconcileActiveBranch`); statuses live in the plan, so a branch switch
 *    loses nothing.
 *  - R3: an objective proposal under a plan becomes the next plan event —
 *    `insertNextEvent` inserts it right after the current event.
 *  - K6/DK-4a: playing a deck card appends it as a NEW event and promotes it
 *    to the current event (`playCard`); a plan-less branch gets a born
 *    one-event plan, refusing foreign tracker goals unless overridden.
 *  - DK-4b: the branch's story clock (readStoryClock over the branch's latest
 *    valid scene record via the ONE store reader) gates the projection — a
 *    NOT-YET-DUE dated pending event stays OUT of the projected goals, so the
 *    tracker never advances into a future event — and drives advancement:
 *    the tracker-service record observer (registered at wiring) runs
 *    `advanceByClock` after every successful scene write, which promotes the
 *    earliest due dated event to the current event through the existing
 *    applyPlan machinery (no extra model call). With clock null every rule
 *    here reproduces the pre-clock behavior byte-identically (pinned).
 *
 * State flow — one direction per write, never a cycle:
 *   plan save (`applyPlan`) ──project──▶ objective state (goals mode)
 *   objective commit (observer) ──follow-back──▶ plan statuses
 * The follow-back writes the plan through the agent-plan STORE directly,
 * never through `applyPlan`: it never re-enters the projection, so the
 * projection → observer → plan-write path terminates after one round — each
 * direction's write leaves the other a no-op at the fixpoint (statuses agree
 * between plan and goals, so both `followGoalStatuses` and a re-projection
 * return "unchanged"). See the "loop termination" tests.
 *
 * KNOWN ACCEPTED BYPASS (owner-accepted in the plan; log, do not reroute):
 * the tracker template apply (`ChatStore.replaceTrackerSetup`, driven by the
 * insights adapter's applyCharacterTrackerTemplate — the "take from
 * character" button) writes the objective state DIRECTLY, not through
 * `commitState` — so applying a character template can overwrite
 * plan-projected goals until the next plan write or reconcile re-projects.
 * The bypass also skips the state observer; the projection source field
 * survives it, so follow-back keeps targeting the right branch.
 *
 * DR-3b (wired): the branch-change call sites (activate, create,
 * delete, the load-time fallbacks — chat-application-service.ts, via the
 * late-bound registerActiveBranchReconciler hook) call
 * `reconcileActiveBranch`, and the branch-plan PUT (agent-plan-adapter.ts)
 * routes through `applyPlan`. Nothing here calls them.
 */
import {
  AGENT_PLAN_TASK_STATUS,
  EMPTY_AGENT_PLAN,
  EMPTY_STORY_DECK,
  OBJECTIVE_MODE,
  brandId,
  compareStoryTime,
  isStoryEventDue,
  log,
  normalizeSceneTrackerConfig,
  pickCurrentPlanTask,
  promoteStoryEvent,
  readStoryClock,
  type AgentPlan,
  type AgentPlanOwner,
  type AgentPlanTask,
  type ChatBranchId,
  type ChatId,
  type ObjectiveState,
  type StoryClock,
  type StoryDeck,
  type StoryEventTime,
} from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { requireChatBranch } from "../chat/chat-branch-ownership.js";
import { normalizePlanForSave } from "../agent-plan/agent-plan-validation.js";
import type { ObjectiveService } from "../insights/objective-service.js";
import { conflict, internal, notFound, unprocessable } from "../../shared/errors.js";

const logger = log.tag("story-plan-sync");

/** The chat record the chat store hands back (`chats.getById`'s non-null
 *  shape — the store-level view with `insightsConfig`); derived, not imported,
 *  since the db package does not re-export the interface (the repo's derived-
 *  type idiom, as in tracker-service.ts's profile derivation). */
type ChatRecord = NonNullable<Awaited<ReturnType<StoreContainer["chats"]["getById"]>>>;

/**
 * THE one server-side derivation of a branch plan's CURRENT event (G2 seam,
 * DIRECTOR_MODE_PLAN): a delegation to the DK-1 domain rule
 * {@link pickCurrentPlanTask} — the first `active` task, else the first
 * `pending` one that is due, else null. `clock === null` (the default) makes
 * every dated task due, which reproduces the pre-clock rule exactly — first
 * active, else first pending — the rule the DR-3/DR-5 suites pin and the
 * same rule as the web `AgentPlanPanel`'s `pickCurrent`
 * (apps/web/src/components/shared/agent-plan/AgentPlanPanel.tsx) and the
 * tracker's own `selectActiveTask`. With a clock, a not-yet-due pending is
 * skipped in favor of the first pending that IS due. `insertNextEvent` and
 * `playCard` insert right after it (every caller that has a clock available
 * passes it), the projected goals carry plan statuses 1:1, and
 * {@link advancePlanToClock} promotes against it, so the tracker's selected
 * goal IS the current event without a second derivation. Later per-event
 * features — lore activation, a model per event, a multi-draft trigger —
 * read THIS function and never re-derive the rule.
 */
export function pickCurrentStoryEvent(plan: AgentPlan, clock: StoryClock | null = null): AgentPlanTask | null {
  return pickCurrentPlanTask(plan.tasks, clock ?? null);
}

/**
 * A3: the projected goal text = the event title, plus "\n" and the body when
 * the body is non-blank (a whitespace-only body contributes nothing — the
 * body is the direction the RP model reads while the event is current).
 */
export function storyEventGoalText(task: AgentPlanTask): string {
  const body = task.body.trim();
  return body ? `${task.title}\n${body}` : task.title;
}

/**
 * The provenance test the sync already applies everywhere (R2 — statuses live
 * in the plan): a tracker is plan-driven only when `planProjectedFromBranchId`
 * names the branch its goals were projected from; null means the plan
 * machinery never drove it — {@link StoryPlanSync.reconcileActiveBranch}'s
 * "FOREIGN goals" (left alone unless the plan takes the tracker over) and the
 * follow-back's no-op gate. Every "is this tracker state plan-owned?" read
 * goes through THIS predicate — playCard's foreign-goals refusal reuses it
 * rather than deriving provenance a second time.
 */
function isPlanDriven(state: ObjectiveState): boolean {
  return (state.planProjectedFromBranchId ?? null) !== null;
}

/**
 * The play route's 409 code (DK-4a) — the plan routes' `details.code`
 * convention (agent-plan-validation.ts's two 422 codes): the code is the
 * routes' public contract and must not drift between the service and the
 * wire assertions.
 */
export const STORY_DECK_FOREIGN_GOALS_CODE = "story_deck_foreign_goals";

/**
 * The projection (pure): `next` — the plan just saved for `branchId` —
 * becomes the tracker's goals-mode state.
 *
 *  - `mode: "goals"` and `longTermGoal: null` always (A2/A5 — the premise
 *    lives in the plan, never in the tracker's long-term slot).
 *  - `shortTermGoals` = `next.tasks` in plan order, one goal per task:
 *    `{ id: task.id, description: storyEventGoalText(task), status }`.
 *  - Status precedence (owner rule; a stale editor save never reverts a
 *    check): a task whose status CHANGED between `previous` and `next` takes
 *    `next`'s (the user just chose it in the editor); otherwise the
 *    tracker's current status for that id survives (a check or manual edit
 *    that landed after the editor opened); a task the tracker has never seen
 *    starts at the plan's own status. `previous` null (first apply, or a
 *    branch switch) means no change can be detected — tracker-by-id, else
 *    the plan's.
 *  - `planProjectedFromBranchId` records the source branch (R2) — follow-back
 *    and reconcile read it; null means "not plan-driven".
 *  - Every other ObjectiveState field passes through untouched (config,
 *    prompts, the route-mode task list).
 *  - DK-4b: with a clock, a pending event whose story time has not arrived
 *    is left OUT of the projected goals — the tracker never advances into a
 *    future event. Active, completed and abandoned tasks, and every due or
 *    undated pending, still project 1:1 in plan order. `clock === null` (the
 *    default) leaves nothing out — the projection is byte-identical to the
 *    pre-clock rule (pinned by an explicit equivalence test).
 *
 * NOTE on the one-active invariant: mixing an explicit plan-active task with
 * a tracker-active goal for a DIFFERENT id can momentarily produce two
 * `active` goals; the chat store's read normalization
 * (`normalizeObjectiveItems`) collapses every active after the first — the
 * same collapse every other objective write gets on read-back.
 */
export function projectStoryPlanGoals(
  previous: AgentPlan | null,
  next: AgentPlan,
  objective: ObjectiveState,
  projectedFromBranchId: string,
  clock: StoryClock | null = null,
): ObjectiveState {
  const previousStatusById = new Map(
    (previous?.tasks ?? []).map((task) => [task.id, task.status] as const),
  );
  const trackerStatusById = new Map(
    objective.shortTermGoals.map((goal) => [goal.id, goal.status] as const),
  );
  const shortTermGoals = next.tasks
    // DK-4b: only a PENDING event can be "not yet due" — the current, done and
    // dropped events project as before. With no clock every task is due, so
    // this filter keeps the array byte-identical to the pre-clock projection.
    .filter((task) => task.status !== AGENT_PLAN_TASK_STATUS.pending || isStoryEventDue(task, clock))
    .map((task) => {
      const previousStatus = previousStatusById.get(task.id);
      const trackerStatus = trackerStatusById.get(task.id);
      const status =
        previousStatus !== undefined && previousStatus !== task.status
          ? task.status
          : trackerStatus ?? task.status;
      return { id: task.id, description: storyEventGoalText(task), status };
    });
  return {
    ...objective,
    mode: OBJECTIVE_MODE.goals,
    longTermGoal: null,
    shortTermGoals,
    planProjectedFromBranchId: projectedFromBranchId,
  };
}

/** The objective fields the projection owns; everything else passes through.
 *  Used to make an unchanged re-projection a no-write (JSON like the service
 *  revision helpers — order-sensitive on purpose: plan order is goal order). */
function projectionOwnedRevision(state: ObjectiveState): string {
  return JSON.stringify({
    mode: state.mode,
    longTermGoal: state.longTermGoal,
    shortTermGoals: state.shortTermGoals,
    planProjectedFromBranchId: state.planProjectedFromBranchId ?? null,
  });
}

/**
 * The follow-back (pure): copy committed tracker statuses into the plan —
 * every plan task whose id matches a goal takes that goal's status (R2:
 * statuses live in the plan). Goal/constraints and tasks without a matching
 * goal pass through unchanged; ids the plan does not know are ignored.
 * Returns null when nothing changed.
 *
 * Two `active` results (the tracker kept one goal active while the plan
 * declares another task active) resolve the owner's way: keep the TRACKER's
 * active task, demote the other to pending — so the result always passes
 * `normalizeAgentPlan`.
 */
export function followGoalStatuses(plan: AgentPlan, objective: ObjectiveState): AgentPlan | null {
  const goalStatusById = new Map(
    objective.shortTermGoals.map((goal) => [goal.id, goal.status] as const),
  );
  let changed = false;
  const tasks = plan.tasks.map((task) => {
    const status = goalStatusById.get(task.id);
    if (status === undefined || status === task.status) return task;
    changed = true;
    return { ...task, status };
  });
  if (!changed) return null;
  const trackerActiveId = objective.shortTermGoals.find(
    (goal) => goal.status === AGENT_PLAN_TASK_STATUS.active,
  )?.id;
  const activeCount = tasks.filter((task) => task.status === AGENT_PLAN_TASK_STATUS.active).length;
  const resolved =
    activeCount > 1
      ? tasks.map((task) =>
          task.status === AGENT_PLAN_TASK_STATUS.active && task.id !== trackerActiveId
            ? { ...task, status: AGENT_PLAN_TASK_STATUS.pending }
            : task,
        )
      : tasks;
  return { goal: plan.goal, constraints: plan.constraints, tasks: resolved };
}

/**
 * R3: insert one pending event right after the current one (the
 * {@link pickCurrentStoryEvent} rule); with no current event (everything
 * done/abandoned, or an empty plan) the new event appends at the end. Pure —
 * the caller (`StoryPlanSync.insertNextEvent`) supplies the fresh id and
 * saves the result through `applyPlan`. DK-4b: `clock` (default null) selects
 * the current event with the same time-aware rule the projection uses, so a
 * new event lands after the event the clock considers current; null keeps the
 * pre-clock insertion point.
 */
export function insertStoryEventAfterCurrent(
  plan: AgentPlan,
  event: { id: string; title: string; body: string },
  clock: StoryClock | null = null,
): AgentPlan {
  const current = pickCurrentStoryEvent(plan, clock);
  const currentIndex = current
    ? plan.tasks.findIndex((task) => task.id === current.id)
    : -1;
  const index = currentIndex >= 0 ? currentIndex + 1 : plan.tasks.length;
  const tasks = plan.tasks.slice();
  tasks.splice(index, 0, { ...event, status: AGENT_PLAN_TASK_STATUS.pending });
  return { ...plan, tasks };
}

/**
 * DK-4b — the clock-advancement rule (pure; null = nothing to advance). The
 * branch's story clock has reached at least one DATED pending event that is
 * not already the current event: promote the EARLIEST due one.
 *
 * The exact ordering construction, named (the packet's "the other due events
 * move directly after it in time order"):
 *  1. The due set is the plan's pending tasks carrying a valid `at` stamp
 *     whose time has arrived (`isStoryEventDue` with this clock). Undated
 *     pendings NEVER auto-promote — they are already reachable by the current
 *     rule and carry no story time to arrive.
 *  2. "Earliest" is STORY time (`compareStoryTime` ascending), not plan
 *     order; ties keep plan order (the sort is stable over the plan-ordered
 *     list).
 *  3. The earliest due event is promoted through K3's interrupt
 *     ({@link promoteStoryEvent}): it takes the current event's position and
 *     turns `active`; the interrupted event turns `pending` directly after it
 *     (with no active event present it just turns `active` in place). When
 *     the earliest due event already IS the current event (no active event
 *     existed and the first due pending was picked), nothing changes — the
 *     null that pins idempotence: a second call with the same clock recomputes
 *     the same null.
 *  4. The remaining due events ("the due-front") are relocated to sit DIRECTLY
 *     after the promoted one, in that same story-time order; every other task
 *     keeps its relative position. Goal order = plan order, so the projected
 *     tracker reads [..., promoted (active), due-front ..., everything else],
 *     with not-yet-due futures left out of the projection entirely.
 *
 * `at` stamps are never touched (promotion is positional, not temporal — K3);
 * the result carries exactly one active task, so it passes `normalizeAgentPlan`.
 */
export function advancePlanToClock(plan: AgentPlan, clock: StoryClock): AgentPlan | null {
  const due: Array<{ task: AgentPlanTask; at: StoryEventTime }> = [];
  for (const task of plan.tasks) {
    if (task.status !== AGENT_PLAN_TASK_STATUS.pending) continue;
    if (task.at === undefined) continue;
    if (!isStoryEventDue(task, clock)) continue;
    due.push({ task, at: task.at });
  }
  if (due.length === 0) return null;
  due.sort((a, b) => compareStoryTime(a.at, b.at)); // stable: ties keep plan order
  const target = due[0].task;
  const current = pickCurrentStoryEvent(plan, clock);
  if (current && current.id === target.id) return null;
  const promoted = promoteStoryEvent(plan, target.id);
  const rest = due.slice(1);
  if (rest.length === 0) return promoted;
  // The due-front: pull the other due events out, reinsert directly after the
  // promoted one in the sorted order; everything else keeps its order.
  const restIds = new Set(rest.map((entry) => entry.task.id));
  const tasks = promoted.tasks.filter((task) => !restIds.has(task.id));
  const targetIndex = tasks.findIndex((task) => task.id === target.id);
  tasks.splice(targetIndex + 1, 0, ...rest.map((entry) => entry.task));
  return { ...promoted, tasks };
}

/**
 * The service half of the sync. Constructed once at wiring
 * (server/server-runtime.ts, next to ObjectiveService); two observers are
 * registered there: the ObjectiveService state observer as
 * `(chatId, state) => storyPlanSync.onObjectiveStateCommitted(chatId, state)`
 * (the follow-back), and — DK-4b — the SceneTrackerService record observer as
 * `(chatId, branchId) => storyPlanSync.advanceByClock(chatId, branchId)`
 * (the story clock driving the plan forward).
 */
export class StoryPlanSync {
  // fork #2 of ObjectiveKeyedCoordinator
  // (services/api/src/domain/insights/objective-service.ts — forks: 2 there;
  // fork #1: domain/sidechat/sidechat-objective-proposal.ts) — the same
  // promise-tail FIFO. Correspondence: previous/tail chaining, failure
  // isolation on enqueue, map cleanup on the tail identity. Deviations: the
  // key is per-chat; the tail is also the wait target for
  // waitForFollowBack; each stored tail is pre-caught so a detached failure
  // never surfaces as an unhandled rejection (it is logged instead).
  private readonly followBackTails = new Map<string, Promise<void>>();

  constructor(
    private readonly stores: StoreContainer,
    private readonly objectives: ObjectiveService,
  ) {}

  /**
   * Normalize (the plan routes' two 422 codes — the same shared
   * normalize-or-422 path the adapter runs) and save the branch plan; when
   * `branchId` is the chat's ACTIVE branch, project it into the tracker
   * (A5: goals mode + goal replacement, tracker ON when events exist; A8: an
   * empty plan empties the goals and leaves the toggle). A non-active
   * branch's plan is saved but never touches the tracker. Unknown or foreign
   * (chat, branch) pairs 404 through the shared ownership check. DR-3b
   * routes the branch-plan PUT through this method.
   */
  async applyPlan(chatId: ChatId, branchId: ChatBranchId, plan: unknown): Promise<AgentPlan> {
    const normalized = normalizePlanForSave(plan);
    const { chat } = await requireChatBranch(this.stores.chats, chatId, branchId);
    const owner: AgentPlanOwner = { kind: "chatBranch", chatId: chat.id, branchId };
    const previous = await this.stores.agentPlans.get(owner);
    await this.stores.agentPlans.save(owner, normalized);
    if (chat.activeBranchId === branchId) {
      // DK-4b: the projection reads the branch's story clock fresh — a
      // not-yet-due pending event stays out of the goals (null clock = the
      // byte-identical pre-clock projection).
      const clock = await this.readBranchClock(chat, branchId);
      await this.projectForBranch(brandId<ChatId>(chat.id), branchId, previous, normalized, clock);
    }
    return normalized;
  }

  /**
   * R3: an objective proposal under a plan becomes the NEXT plan event — a
   * pending task inserted right after the current event
   * ({@link pickCurrentStoryEvent}'s rule), then the plan applies through
   * {@link applyPlan} (save +, on the active branch, projection). The caller
   * (the proposal card's apply, DR-3b/DR-5) maps the proposal to
   * `{ title, body }`.
   */
  async insertNextEvent(
    chatId: ChatId,
    branchId: ChatBranchId,
    event: { title: string; body: string },
  ): Promise<AgentPlan> {
    const title = event.title.trim();
    if (!title) {
      throw unprocessable("The event title is required.");
    }
    const { chat } = await requireChatBranch(this.stores.chats, chatId, branchId);
    const owner: AgentPlanOwner = { kind: "chatBranch", chatId, branchId };
    const current = (await this.stores.agentPlans.get(owner)) ?? EMPTY_AGENT_PLAN;
    // DK-4b: the insertion point follows the branch's clock-aware current
    // event (null clock = the pre-clock insertion point).
    const clock = await this.readBranchClock(chat, branchId);
    const next = insertStoryEventAfterCurrent(current, {
      // The web plan editor's id convention (`task_` + uuid).
      id: `task_${crypto.randomUUID()}`,
      title,
      body: event.body.trim(),
    }, clock);
    return this.applyPlan(chatId, branchId, next);
  }

  /**
   * DK-4a: play one deck card into the branch's plan (the deck routes' POST
   * `deck/:cardId/play`). The card leaves the deck EXACTLY once and enters
   * the plan as a NEW event — fresh id (insertNextEvent's `task_` + uuid
   * convention, the web plan editor's), title/body from the card, no `at`
   * stamp (cards carry no story time) — that {@link promoteStoryEvent}
   * promotes to the CURRENT event (K3's interrupt: the interrupted active
   * event turns pending directly after). A branch with no plan yet (no
   * stored plan, or a stored plan without events — the plan routes'
   * no-plan-yet convention) gets a born-this-way one-event plan (K6) with
   * EMPTY_AGENT_PLAN's goal/constraints defaults: the card is the plan's
   * seed; the owner writes the premise later in the plan editor. BEFORE that
   * first creation the foreign-goals guard runs: when the chat's tracker
   * holds goals the plan machinery never drove (`isPlanDriven` false —
   * reconcileActiveBranch's R2 notion), the projection the play triggers
   * would silently replace them, so the call refuses with the typed 409
   * `story_deck_foreign_goals` unless `options.replaceForeignGoals` is set.
   *
   * The deck write and the plan write are ONE unit of work: a single
   * synchronous bun:sqlite transaction over the shared DB handle through the
   * stores' `saveInTx` cores (the repo's cross-store InTx convention —
   * db-connection.ts: an `await` inside `db.transaction` suspends past the
   * commit, so the callback awaits nothing and a synchronous throw rolls both
   * writes back). The tracker projection runs AFTER the transaction: it is
   * async through ObjectiveService and cannot join a synchronous transaction,
   * and a projection failure leaves deck + plan consistent (the next plan
   * write or branch reconcile re-projects — the module header's one-way
   * state flow).
   *
   * The ACTIVE branch's plan then projects exactly as an ordinary plan PUT —
   * applyPlan's tail, the shared {@link projectForBranch} entry — passing the
   * pre-play plan as `previous` so the interrupted event's active→pending
   * change wins the projection's status precedence in the same write (no
   * two-active window left to the read-collapse). A non-active branch's plan
   * is saved but never touches the tracker (applyPlan's documented rule).
   * Unknown/foreign (chat, branch) pairs 404 through the shared ownership
   * check; an unknown cardId is the typed 404 with NO write anywhere.
   */
  async playCard(
    chatId: ChatId,
    branchId: ChatBranchId,
    cardId: string,
    options: { replaceForeignGoals?: boolean } = {},
  ): Promise<{ deck: StoryDeck; event: AgentPlanTask }> {
    const { chat } = await requireChatBranch(this.stores.chats, chatId, branchId);
    // DK-4b: read the branch's story clock once — it selects the insertion
    // point (after the clock-aware current event) and, on the active branch,
    // gates the projection below. Null clock = the pre-clock behavior.
    const clock = await this.readBranchClock(chat, branchId);
    const deck = (await this.stores.storyDecks.get(chatId, branchId)) ?? EMPTY_STORY_DECK;
    const card = deck.cards.find((candidate) => candidate.id === cardId);
    if (!card) {
      throw notFound("StoryCard", `Story card '${cardId}' is not in branch '${branchId}' deck.`);
    }
    const owner: AgentPlanOwner = { kind: "chatBranch", chatId, branchId };
    const previous = await this.stores.agentPlans.get(owner);
    if (previous === null || previous.tasks.length === 0) {
      // K6's born-this-way moment: the first played card founds the plan.
      // The guard runs BEFORE the creation — the projection it triggers would
      // replace tracker goals the plan machinery never drove.
      const state = await this.objectives.getState(chatId);
      if (
        !isPlanDriven(state) &&
        state.shortTermGoals.length > 0 &&
        options.replaceForeignGoals !== true
      ) {
        throw conflict(
          "The branch has no plan, and the goal tracker holds goals not from a plan; playing a card would replace them.",
          { code: STORY_DECK_FOREIGN_GOALS_CODE, foreignGoalCount: state.shortTermGoals.length },
        );
      }
    }
    const event = {
      // The web plan editor's id convention (`task_` + uuid) — insertNextEvent's.
      id: `task_${crypto.randomUUID()}`,
      title: card.title,
      body: card.body,
    };
    const withEvent = insertStoryEventAfterCurrent(previous ?? EMPTY_AGENT_PLAN, event, clock);
    const nextPlan = normalizePlanForSave(promoteStoryEvent(withEvent, event.id));
    const nextDeck: StoryDeck = {
      cards: deck.cards.filter((candidate) => candidate.id !== cardId),
    };
    // ONE unit of work — the deck removal and the plan event commit or roll
    // back together (synchronous callback, no awaits: the InTx convention).
    this.stores.db.transaction((tx) => {
      this.stores.storyDecks.saveInTx(tx, chatId, branchId, nextDeck);
      this.stores.agentPlans.saveInTx(tx, owner, nextPlan);
    });
    const played = nextPlan.tasks.find((task) => task.id === event.id);
    if (played === undefined) {
      // Unreachable by construction (the event was inserted and the plan is
      // normalized), but the response contract needs the stored task.
      throw internal("The played event vanished from the saved plan.");
    }
    if (chat.activeBranchId === branchId) {
      await this.projectForBranch(brandId<ChatId>(chat.id), branchId, previous, nextPlan, clock);
    }
    return { deck: nextDeck, event: played };
  }

  /**
   * R2: re-fill the tracker from the ACTIVE branch's plan. Idempotent — a
   * no-op when the tracker is already projected from the active branch.
   * Switching away from plan-projected goals empties them when the new
   * active branch has no plan (A8's release rule); FOREIGN goals (a tracker
   * the plan never drove — `planProjectedFromBranchId` null) are left alone
   * unless the active branch HAS events (the plan then takes the tracker
   * over). Task ids shared across branches (a fork copies the plan) keep the
   * tracker's statuses — the chat's lived progress follows the ids. DR-3b
   * calls this from every active-branch change — one call site per path.
   */
  async reconcileActiveBranch(chatId: ChatId): Promise<void> {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) return;
    const activeBranchId = chat.activeBranchId;
    const state = await this.objectives.getState(chatId);
    if ((state.planProjectedFromBranchId ?? null) === activeBranchId) return;
    const plan =
      (await this.stores.agentPlans.get({
        kind: "chatBranch",
        chatId: chat.id,
        branchId: activeBranchId,
      })) ?? EMPTY_AGENT_PLAN;
    if (plan.tasks.length === 0 && !isPlanDriven(state)) return;
    // DK-4b: the re-fill projects with the ACTIVE branch's clock.
    const clock = await this.readBranchClock(chat, activeBranchId);
    await this.projectForBranch(brandId<ChatId>(chat.id), activeBranchId, null, plan, clock);
  }

  /**
   * ObjectiveService's post-commit observer (registered at wiring). Sync by
   * contract (the lane never awaits it): the follow-back work is chained per
   * chat on {@link followBackTails} and runs detached, serialized per chat so
   * interleaved commits cannot interleave plan writes. A tracker the plan
   * never drove (`planProjectedFromBranchId` null) has nothing to follow
   * back into.
   */
  onObjectiveStateCommitted(chatId: ChatId, nextState: ObjectiveState): void {
    if (!isPlanDriven(nextState)) return;
    const key = chatId as string;
    const run = (this.followBackTails.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runFollowBack(chatId, nextState));
    const parked = run.catch((error: unknown) => {
      logger.warn(
        "follow-back failed for chat %s: %s",
        chatId as string,
        error instanceof Error ? error.message : String(error),
      );
    });
    this.followBackTails.set(key, parked);
  }

  /**
   * Resolve when every follow-back enqueued for the chat so far has settled —
   * a deterministic wait (no polling) for tests and for later DR-3b wiring
   * that must not answer a request before statuses landed in the plan.
   */
  async waitForFollowBack(chatId: ChatId): Promise<void> {
    await this.followBackTails.get(chatId as string)?.catch(() => undefined);
  }

  /**
   * DK-4b — the ONE clock read (the plan's one time source): the chat's
   * tracker schema (the DK-2 clock markers live there) over the branch's
   * latest valid record through the ONE existing reader
   * (`MessageStore.getCurrentSceneTarget` — the same derivation the
   * current-Scene cache rebuild runs), read through the domain's
   * {@link readStoryClock}. Null without a marked schema, a readable latest
   * record or a valid day — and every consumer treats null as "no clock":
   * the pre-clock rules apply unchanged. The clock is never stored anywhere;
   * each projection reads it fresh at the moment of the write.
   */
  private async readBranchClock(chat: ChatRecord, branchId: string): Promise<StoryClock | null> {
    const config = normalizeSceneTrackerConfig(chat.insightsConfig.tracker);
    const target = await this.stores.messages.getCurrentSceneTarget(branchId as string);
    if (!target) return null;
    return readStoryClock(config.schema, target.record.sceneState);
  }

  /**
   * DK-4b — the Scene record observer's consumer (registered at wiring,
   * server-runtime.ts, exactly like the objective-state observer): a scene
   * record write has moved the branch's story clock; when a dated pending
   * event's time has arrived and it is not the current event, promote the
   * earliest due one ({@link advancePlanToClock}'s rule — the other due
   * events land directly after it in story-time order) and let the result
   * flow through {@link applyPlan} (save +, on the active branch, the
   * clock-aware projection). No extra model call anywhere.
   *
   * Guards, in order:
   *  - ACTIVE branch only — a non-active branch's record changes nothing
   *    (pinned): its plan could never project while it is not active.
   *  - No clock (unmarked schema / no latest valid record) → no-op: nothing
   *    is time-driven without a time.
   *  - No stored plan, or nothing due-and-promotable → no write; a second
   *    call with the same clock recomputes the same no-op (idempotent —
   *    pinned by a test).
   *
   * LOOP GUARD (structural): this method writes the PLAN (agent-plan store,
   * via applyPlan) and projects the goal state — it never writes a scene
   * record, so the tracker-service record observer cannot re-fire from its
   * own work. Pinned by a test (promote → apply → projection produces no
   * scene write and no observer re-entry).
   */
  async advanceByClock(chatId: ChatId, branchId: ChatBranchId): Promise<void> {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat || chat.activeBranchId !== (branchId as string)) return;
    const clock = await this.readBranchClock(chat, branchId);
    if (!clock) return;
    const owner: AgentPlanOwner = { kind: "chatBranch", chatId: chatId as string, branchId };
    const plan = await this.stores.agentPlans.get(owner);
    if (!plan) return;
    const advanced = advancePlanToClock(plan, clock);
    if (!advanced) return;
    await this.applyPlan(chatId, branchId, advanced);
  }

  /**
   * The one projection entry (applyPlan + reconcileActiveBranch + playCard
   * share it): replace the tracker's plan-owned fields with the projection of
   * `next` (source `branchId`) unless it already matches (an unchanged re-save
   * writes nothing), then turn the tracker ON when the plan has events (A5).
   * An empty plan leaves the toggle as is (A8). DK-4b: `clock` (the branch's
   * story clock, read fresh by the caller) filters not-yet-due pending events
   * out of the goals; null keeps the byte-identical pre-clock projection.
   */
  private async projectForBranch(
    chatId: ChatId,
    branchId: string,
    previous: AgentPlan | null,
    next: AgentPlan,
    clock: StoryClock | null,
  ): Promise<void> {
    await this.objectives.replaceShortTermGoalsFromPlan(chatId, (current) => {
      const projected = projectStoryPlanGoals(previous, next, current, branchId, clock);
      return projectionOwnedRevision(current) === projectionOwnedRevision(projected)
        ? null
        : projected;
    });
    if (next.tasks.length > 0) {
      const chat = await this.stores.chats.getById(chatId);
      if (chat && !chat.insightsConfig.objectiveEnabled) {
        await this.stores.chats.updateInsightsConfig(chatId, {
          insightsConfig: { ...chat.insightsConfig, objectiveEnabled: true },
        });
      }
    }
  }

  /**
   * The follow-back half of 3a: copy committed goal statuses into the plan of
   * the branch the state was projected from — a DIRECT agent-plan store
   * write, never `applyPlan`, so the sync cannot cycle (module header). The
   * branch or its plan row may be gone (deleted mid-flight) — then there is
   * nothing to write into and the run is a no-op.
   */
  private async runFollowBack(chatId: ChatId, state: ObjectiveState): Promise<void> {
    const branchId = state.planProjectedFromBranchId ?? null;
    if (!branchId) return;
    const owner: AgentPlanOwner = { kind: "chatBranch", chatId: chatId as string, branchId };
    const plan = await this.stores.agentPlans.get(owner);
    if (!plan) return;
    const followed = followGoalStatuses(plan, state);
    if (followed) await this.stores.agentPlans.save(owner, followed);
  }
}
