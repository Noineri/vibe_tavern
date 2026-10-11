import { eq } from 'drizzle-orm';
import { log, normalizeAgentPlan, type AgentPlan, type AgentPlanOwner } from '@vibe-tavern/domain';
import { agentPlans } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

const logger = log.tag('agent-plan-store');

/** Persistence for the one agent plan owned by each saved script. */
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
    const row = await this.db
      .select()
      .from(agentPlans)
      .where(eq(agentPlans.scriptId, owner.scriptId))
      .get();
    if (!row) return null;

    try {
      return normalizeAgentPlan(JSON.parse(row.contentJson));
    } catch (error) {
      logger.warn(
        'get(%s): malformed content_json for row %s (%s)',
        owner.scriptId,
        row.id,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /** Full-replace save. The script_id unique index makes this one row per owner. */
  async save(owner: AgentPlanOwner, plan: AgentPlan): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insert(agentPlans)
      .values({
        id: this.idGen.next('agent_plan'),
        scriptId: owner.scriptId,
        contentJson: JSON.stringify(plan),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentPlans.scriptId,
        set: {
          contentJson: JSON.stringify(plan),
          updatedAt: now,
        },
      })
      .run();
  }
}
