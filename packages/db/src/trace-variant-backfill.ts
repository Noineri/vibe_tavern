import type { Database } from 'bun:sqlite';

/**
 * One-time data migration: link legacy prompt_traces to the swipe
 * (message_variants row) that produced them (SC-23b, SIDECHAT_PLAN Wave 5b).
 *
 * A JS pass, not a drizzle SQL migration, because the structural rules need
 * per-message ordering analysis across three tables. Runs after `migrate()`
 * in `createDb()`, right after the trace-chunk dedupe pass
 * (trace-chunk-migration.ts).
 *
 * Owner insight (2026-10-21): both the trace and its swipe carry model +
 * preset name, so matching is STRUCTURAL — creation ordering plus those two
 * scalars. No time-tolerance windows anywhere.
 *
 * Rules (anything ambiguous or unmatched stays null — a null link must mean
 * "the exact prompt of that reply is unknown", never a guess):
 *
 * 1. Original messages: a trace belongs to the variant of the same message
 *    created LAST at or before the trace (the writer saves the trace right
 *    after the variant, before any later swipe) AND only when model and
 *    preset name match (a variant's NULL preset normalizes to the writers'
 *    "(none)" trace sentinel). When a deleted variant leaves several traces
 *    in one variant's interval, only the EARLIEST matching trace belongs to
 *    that variant; the others stay null.
 *
 * 2. Forked copies (forkBranch stamps copied variants with the fork time but
 *    copies traces with their original createdAt): a copied trace matches its
 *    source trace in the parent branch — identical createdAt + model + preset
 *    at the same message position, within the forked range (position <= the
 *    fork point) — and resolves to the copy's variant at the SOURCE trace's
 *    variantIndex (forks preserve indexes), still guarded by model + preset.
 *    Several distinct source matches = ambiguous = null. Parents resolve
 *    before children (branch tree order), so the source's own link is final.
 *
 * Traces that fail rule 2 fall through to rule 1: a post-fork swipe on a
 * copied message finds no source match (its createdAt postdates every parent
 * trace), while a copied trace whose source is gone finds no rule-1 owner
 * either (every copied variant carries the fork time, later than the copied
 * trace's original timestamp) — it stays null.
 *
 * Safety properties:
 * - **Idempotent / crash-resumable.** Only `variant_id IS NULL` rows are
 *   examined; updates commit in batches (one transaction per batch); the
 *   `app_data_migrations` marker is written only after the full pass. A crash
 *   mid-pass re-runs it on the next boot and skips already-linked rows.
 * - **Never guesses.** Every unresolved trace keeps NULL; deletes never
 *   happen — the pass only fills a nullable column.
 */

const MARKER_TABLE = 'app_data_migrations';
const MIGRATION_NAME = 'prompt_trace_variant_backfill_v1';
const UPDATE_BATCH_SIZE = 200;
/** The preset-name sentinel `saveTrace` callers substitute when no preset
 *  resolved — variants store NULL in that case (see the two generation
 *  writers in session-runtime-chat.ts). */
const NO_PRESET_SENTINEL = '(none)';

export interface TraceVariantBackfillStats {
  /** Legacy (null-variant) traces examined. */
  traces: number;
  /** Rows linked to their producing variant. */
  linked: number;
  /** Rows examined but deliberately left null. */
  leftNull: number;
}

interface BranchRow { id: string; chatId: string; parentBranchId: string | null; forkedFromMessageId: string | null }
interface MessageRow { id: string; branchId: string; position: number }
interface VariantRow { id: string; messageId: string; variantIndex: number; modelId: string | null; presetName: string | null; createdAt: string }
interface TraceRow { id: string; branchId: string; messageId: string; model: string; presetName: string; createdAt: string; variantId: string | null }

function tableExists(sqlite: Database, name: string): boolean {
  // bun:sqlite returns null (not undefined) when no row matches.
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined && row !== null;
}

function columnExists(sqlite: Database, table: string, column: string): boolean {
  const row = sqlite.prepare('SELECT name FROM pragma_table_info(?) WHERE name = ?').get(table, column);
  return row !== undefined && row !== null;
}

export function isTraceVariantBackfillApplied(sqlite: Database): boolean {
  try {
    if (!tableExists(sqlite, MARKER_TABLE)) return false;
    const row = sqlite.prepare(`SELECT name FROM ${MARKER_TABLE} WHERE name = ?`).get(MIGRATION_NAME);
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

const byCreatedThenIndex = (a: VariantRow, b: VariantRow): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.variantIndex - b.variantIndex;

const byCreatedThenId = (a: TraceRow, b: TraceRow): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Variant preset names normalize to the trace-side "(none)" sentinel. */
const presetMatches = (variant: VariantRow, trace: TraceRow): boolean =>
  (variant.presetName ?? NO_PRESET_SENTINEL) === trace.presetName && variant.modelId === trace.model;

/**
 * Fill `prompt_traces.variant_id` for legacy rows. Returns null when the pass
 * already completed (marker present) or the expected tables/columns are absent
 * (fresh DB still being created, or a legacy DB an earlier boot phase will
 * heal).
 */
export function backfillTraceVariants(sqlite: Database): TraceVariantBackfillStats | null {
  for (const table of ['prompt_traces', 'message_variants', 'messages', 'chat_branches']) {
    if (!tableExists(sqlite, table)) return null;
  }
  if (!columnExists(sqlite, 'prompt_traces', 'variant_id')) return null;

  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  if (isTraceVariantBackfillApplied(sqlite)) return null;

  // Scalar shape only — payload JSON columns are never touched by this pass.
  const branches = sqlite.prepare('SELECT id, chat_id AS chatId, parent_branch_id AS parentBranchId, forked_from_message_id AS forkedFromMessageId FROM chat_branches').all() as BranchRow[];
  const messageRows = sqlite.prepare('SELECT id, branch_id AS branchId, position FROM messages').all() as MessageRow[];
  const variantRows = sqlite.prepare('SELECT id, message_id AS messageId, variant_index AS variantIndex, model_id AS modelId, preset_name AS presetName, created_at AS createdAt FROM message_variants').all() as VariantRow[];
  const traceRows = sqlite.prepare('SELECT id, branch_id AS branchId, message_id AS messageId, model, preset_name AS presetName, created_at AS createdAt, variant_id AS variantId FROM prompt_traces').all() as TraceRow[];

  const branchById = new Map(branches.map((b) => [b.id, b]));
  const messageById = new Map(messageRows.map((m) => [m.id, m]));
  // (branchId, position) → message: the fork rule's same-position source lookup.
  const messageAtPosition = new Map<string, MessageRow>(messageRows.map((m) => [`${m.branchId} ${m.position}`, m]));
  const variantsByMessage = new Map<string, VariantRow[]>();
  for (const v of variantRows) {
    const list = variantsByMessage.get(v.messageId);
    if (list) list.push(v);
    else variantsByMessage.set(v.messageId, [v]);
  }
  const tracesByMessage = new Map<string, TraceRow[]>();
  for (const t of traceRows) {
    const list = tracesByMessage.get(t.messageId);
    if (list) list.push(t);
    else tracesByMessage.set(t.messageId, [t]);
  }
  const messagesByBranch = new Map<string, MessageRow[]>();
  for (const m of messageRows) {
    const list = messagesByBranch.get(m.branchId);
    if (list) list.push(m);
    else messagesByBranch.set(m.branchId, [m]);
  }

  // Branch tree order: parents before children, so a copied trace reads its
  // source's final link. Branches unreachable from a root (corrupt cycle) go
  // last with the fork rule disabled — their parent's links may not be final.
  const childrenOf = new Map<string, BranchRow[]>();
  const roots: BranchRow[] = [];
  for (const b of branches) {
    const parent = b.parentBranchId !== null ? branchById.get(b.parentBranchId) : undefined;
    if (parent !== undefined && parent.chatId === b.chatId) {
      const list = childrenOf.get(parent.id);
      if (list) list.push(b);
      else childrenOf.set(parent.id, [b]);
    } else {
      roots.push(b);
    }
  }
  const order: BranchRow[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const b = queue.shift()!;
    order.push(b);
    for (const child of childrenOf.get(b.id) ?? []) queue.push(child);
  }
  const orderedIds = new Set(order.map((b) => b.id));
  const forkDisabled = new Set<string>();
  for (const b of branches) {
    if (!orderedIds.has(b.id)) {
      order.push(b);
      forkDisabled.add(b.id);
    }
  }

  const stats: TraceVariantBackfillStats = { traces: 0, linked: 0, leftNull: 0 };
  const updates: Array<{ traceId: string; variantId: string }> = [];

  for (const branch of order) {
    // Rule 2 context: the parent branch plus the fork point's position there.
    const parent = !forkDisabled.has(branch.id) && branch.parentBranchId !== null
      ? branchById.get(branch.parentBranchId)
      : undefined;
    const parentUsable = parent !== undefined && parent.chatId === branch.chatId;
    let forkPosition: number | null = null;
    if (parentUsable && branch.forkedFromMessageId !== null) {
      const forkMessage = messageById.get(branch.forkedFromMessageId);
      if (forkMessage !== undefined && forkMessage.branchId === parent.id) forkPosition = forkMessage.position;
    }

    for (const message of messagesByBranch.get(branch.id) ?? []) {
      const msgVariants = (variantsByMessage.get(message.id) ?? []).slice().sort(byCreatedThenIndex);
      const msgTraces = (tracesByMessage.get(message.id) ?? []).slice().sort(byCreatedThenId);
      if (msgTraces.length === 0 || !msgTraces.some((t) => t.variantId === null)) continue;

      const sourceMessage = forkPosition !== null && message.position <= forkPosition
        ? messageAtPosition.get(`${parent!.id} ${message.position}`)
        : undefined;

      // Rule 2 — forked copies: source trace match at the same position in
      // the parent branch (identical createdAt + model + preset).
      const forkResolved = new Map<string, string | null>();
      if (sourceMessage !== undefined) {
        for (const trace of msgTraces) {
          if (trace.variantId !== null) continue;
          const sourceVariantIds = new Set<string | null>();
          for (const source of tracesByMessage.get(sourceMessage.id) ?? []) {
            if (source.createdAt === trace.createdAt && source.model === trace.model && source.presetName === trace.presetName) {
              sourceVariantIds.add(source.variantId);
            }
          }
          if (sourceVariantIds.size === 0) continue; // not a copy — rule 1 below
          if (sourceVariantIds.size > 1 || sourceVariantIds.has(null)) {
            forkResolved.set(trace.id, null); // ambiguous, or the source itself is unlinked
            continue;
          }
          const sourceVariantId = [...sourceVariantIds][0]!;
          const sourceVariant = (variantsByMessage.get(sourceMessage.id) ?? []).find((v) => v.id === sourceVariantId);
          if (sourceVariant === undefined) {
            forkResolved.set(trace.id, null);
            continue;
          }
          // The copy's variant sits at the source variant's index (forks
          // preserve variantIndex); the model+preset guard rejects an index
          // shifted by a post-fork variant deletion in this branch.
          const target = msgVariants.find((v) => v.variantIndex === sourceVariant.variantIndex);
          forkResolved.set(trace.id, target !== undefined && presetMatches(target, trace) ? target.id : null);
        }
      }

      // Rule 1 — originals: each trace's owner is the variant created LAST at
      // or before it; within one owner's interval only the EARLIEST
      // model+preset-matching trace is linked, the rest stay null.
      const ownerTraces = new Map<string, TraceRow[]>();
      const ownerless: TraceRow[] = [];
      for (const trace of msgTraces) {
        if (trace.variantId !== null || forkResolved.has(trace.id)) continue;
        let owner: VariantRow | null = null;
        for (const v of msgVariants) {
          if (v.createdAt <= trace.createdAt) owner = v;
          else break;
        }
        if (owner === null) ownerless.push(trace);
        else {
          const list = ownerTraces.get(owner.id);
          if (list) list.push(trace);
          else ownerTraces.set(owner.id, [trace]);
        }
      }

      const link = (trace: TraceRow, variantId: string | null): void => {
        stats.traces++;
        if (variantId !== null) {
          stats.linked++;
          updates.push({ traceId: trace.id, variantId });
          // Update the in-memory row too: branches are processed parents-first,
          // so a later fork's rule 2 must read this pass's fresh resolution,
          // not the loaded (null) value.
          trace.variantId = variantId;
        } else {
          stats.leftNull++;
        }
      };
      for (const trace of msgTraces) {
        if (trace.variantId !== null || !forkResolved.has(trace.id)) continue;
        link(trace, forkResolved.get(trace.id) ?? null);
      }
      for (const trace of ownerless) link(trace, null);
      // Owner groups: the earliest model+preset-matching trace in the group
      // gets the owner; every other trace in the interval stays null (a
      // deleted variant's orphaned traces must not shift onto a neighbor).
      for (const [ownerId, group] of ownerTraces) {
        const ownerVariant = msgVariants.find((v) => v.id === ownerId)!;
        let taken = false;
        for (const trace of group) {
          if (!taken && presetMatches(ownerVariant, trace)) {
            link(trace, ownerId);
            taken = true;
          } else {
            link(trace, null);
          }
        }
      }
    }
  }

  const update = sqlite.prepare('UPDATE prompt_traces SET variant_id = ? WHERE id = ?');
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
    sqlite.transaction(() => {
      for (const u of batch) update.run(u.variantId, u.traceId);
    })();
  }

  sqlite.prepare(`INSERT OR REPLACE INTO ${MARKER_TABLE} (name, applied_at) VALUES (?, ?)`).run(MIGRATION_NAME, new Date().toISOString());
  return stats;
}
