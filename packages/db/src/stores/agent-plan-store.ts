import { and, eq } from 'drizzle-orm';
import { log, normalizeAgentPlan, type AgentPlan, type AgentPlanOwner } from '@vibe-tavern/domain';
import { agentBranchPlans, agentPlans } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

const logger = log.tag('agent-plan-store');

/** The two owners' row shapes differ only in their key columns — the shared
 *  content column is validated identically, so the read paths collapse onto
 *  this common projection after the owner switch picks the table. */
interface PlanRow {
  id: string;
  contentJson: string;
}

/** `agent_plan`-prefixed ids for both owners — the id namespace is shared
 *  (both are agent plans; the owner columns, not the id, carry ownership). */
function ownerLabel(owner: AgentPlanOwner): string {
  return owner.kind === 'script'
    ? owner.scriptId
    : `${owner.chatId}/${owner.branchId}`;
}

/** Persistence for the one agent plan owned by each plan owner: a saved
 *  script (agent_plans, soft-link script_id) or an RP chat branch
 *  (agent_branch_plans, hard FK cascade — SIDECHAT_PLAN SC-0h). The script
 *  table and its script-path behavior are untouched; the owner switch below
 *  is the only place that knows which table an owner's plan lives in. */
export class AgentPlanStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  async get(owner: AgentPlanOwner): Promise<AgentPlan | null> {
    const row: PlanRow | undefined = owner.kind === 'script'
      ? await this.db
        .select()
        .from(agentPlans)
        .where(eq(agentPlans.scriptId, owner.scriptId))
        .get()
      : await this.db
        .select()
        .from(agentBranchPlans)
        .where(
          and(
            eq(agentBranchPlans.chatId, owner.chatId),
            eq(agentBranchPlans.branchId, owner.branchId),
          ),
        )
        .get();
    if (!row) return null;

    try {
      return normalizeAgentPlan(JSON.parse(row.contentJson));
    } catch (error) {
      logger.warn(
        'get(%s): malformed content_json for row %s (%s)',
        ownerLabel(owner),
        row.id,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /** Full-replace save. Each table's unique index (script_id; the
   *  (chat_id, branch_id) pair) makes this one row per owner. */
  async save(owner: AgentPlanOwner, plan: AgentPlan): Promise<void> {
    const now = this.clock.now();
    const contentJson = JSON.stringify(plan);
    if (owner.kind === 'chatBranch') {
      await this.db
        .insert(agentBranchPlans)
        .values({
          id: this.idGen.next('agent_plan'),
          chatId: owner.chatId,
          branchId: owner.branchId,
          contentJson,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentBranchPlans.chatId, agentBranchPlans.branchId],
          set: {
            contentJson,
            updatedAt: now,
          },
        })
        .run();
      return;
    }
    await this.db
      .insert(agentPlans)
      .values({
        id: this.idGen.next('agent_plan'),
        scriptId: owner.scriptId,
        contentJson,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentPlans.scriptId,
        set: {
          contentJson,
          updatedAt: now,
        },
      })
      .run();
  }
}
