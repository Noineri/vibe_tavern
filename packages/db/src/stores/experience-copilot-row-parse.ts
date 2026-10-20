// Row-parse helpers for ExperienceCopilotStore's JSON columns (defensive,
// never fatal) — extracted verbatim from experience-copilot-store.ts when that
// file hit the arch-gate size cap (SIDECHAT_PLAN SC-1; the extraction is the
// gate's prescribed remedy, not a behavior change). Each parser guards one
// JSON column: the column is always written via JSON.stringify of a validated
// value, so a parse failure indicates on-disk corruption — the parser logs,
// returns the neutral value (null / []) and the next store write heals the
// column. The store class remains the only writer/reader of these columns.

/** Parsed segmented context-usage metrics for a copilot thread (CM-2). Mirrors
 *  the `experienceCopilotContextMetricsSchema` wire shape (api-contracts)
 *  field-for-field — the db package cannot import api-contracts (dependency
 *  direction), so this local structural type is the store's read projection. The
 *  stream finish path (services/api) builds the object; the store only
 *  serializes it into `context_metrics_json` and parses it back out.
 */
/** One kind-provided meter segment row (SC-0j's wire field; SC-9's
 *  sidechat kind is the first producer). Local structural twin of the wire
 *  schema's `segments` entry — same dependency-direction note as
 *  {@link CopilotContextMetrics} above. */
export interface CopilotMeterSegment {
  key: string;
  tokens: number;
}

export interface CopilotContextMetrics {
  systemTokens: number;
  /** Tokens of the pinned-context attached block + recency anchor (CX-1,
   *  additive). Rows written before this plan lack the field — the parse guard
   *  defaults a missing value to 0. */
  attachedTokens: number;
  digestTokens: number;
  historyTokens: number;
  totalTokens: number;
  budgetTokens: number;
  reserveTokens: number;
  source: "estimate" | "provider";
  measuredAt: string;
  /** Kind-provided meter breakdown (SC-0j; the sidechat's five segments,
   *  SC-9). Optional: rows written before SC-9 and kinds that provide no
   *  segments lack the field — the parse guard keeps it absent for them and
   *  drops (logs) a present-but-corrupt value instead of rejecting the whole
   *  metrics object. */
  segments?: CopilotMeterSegment[];
}

/** Pinned-context link on a copilot thread (CX-1). Local structural twin of
 *  the api-contracts `experienceCopilotContextLinkSchema` — the db package
 *  cannot import api-contracts (dependency direction), same as
 *  {@link CopilotContextMetrics} above. Links resolve by id at assembly time
 *  (never a content copy). */
export interface CopilotContextLink {
  targetType: 'character' | 'persona' | 'lorebook' | 'script' | 'skill';
  targetId: string;
}

/** A checklist item on a copilot thread (copilot todo/ask plan, TAG-2,
 *  restored PM-7). Local structural twin of the api-contracts
 *  `copilotTodoItemSchema` — the db package cannot import api-contracts
 *  (dependency direction), same as {@link CopilotContextMetrics} above.
 *  Statuses mirror the RP objective tracker so the frontend panel reuses its
 *  visual language. */
export interface CopilotTodoItem {
  title: string;
  status: 'pending' | 'active' | 'completed' | 'abandoned';
}

/** Type guard for the parsed metrics JSON shape. `attachedTokens` is additive
 *  (CX-1): rows written before the plan lack it — the guard accepts those and
 *  the caller defaults the value to 0. */
function isCopilotContextMetrics(value: unknown): value is Omit<CopilotContextMetrics, "attachedTokens"> & { attachedTokens?: unknown } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.systemTokens === "number" &&
    typeof v.digestTokens === "number" &&
    typeof v.historyTokens === "number" &&
    typeof v.totalTokens === "number" &&
    typeof v.budgetTokens === "number" &&
    typeof v.reserveTokens === "number" &&
    (v.source === "estimate" || v.source === "provider") &&
    typeof v.measuredAt === "string"
  );
}

/** Validate an optional `segments` array (SC-9): every entry must be the
 *  `{ key: non-empty string, tokens: number }` wire shape. A present-but-
 *  corrupt value loses the WHOLE field (never a partial array — the meter's
 *  segments must sum to the total, so dropping single rows would silently
 *  break the invariant), the metrics object itself stays. */
function parseMeterSegments(
  value: unknown,
  threadId: string,
): CopilotMeterSegment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    console.error(
      `[experience-copilot-store] invalid context_metrics_json segments for thread '${threadId}': not an array — dropping the field`,
    );
    return undefined;
  }
  const segments: CopilotMeterSegment[] = [];
  for (const entry of value) {
    if (
      entry && typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).key === "string" &&
      (entry as Record<string, unknown>).key !== "" &&
      typeof (entry as Record<string, unknown>).tokens === "number"
    ) {
      segments.push({ key: (entry as Record<string, unknown>).key as string, tokens: (entry as Record<string, unknown>).tokens as number });
      continue;
    }
    console.error(
      `[experience-copilot-store] invalid context_metrics_json segments for thread '${threadId}': an entry is not { key, tokens } — dropping the field`,
    );
    return undefined;
  }
  return segments;
}

/** Parse `context_metrics_json` into a validated {@link CopilotContextMetrics},
 *  or null when absent/malformed/wrong-shape. The column is always written via
 *  JSON.stringify of a valid object, so a failure indicates corruption — fall
 *  back to null (treated identically to "no metrics yet") and log it. */
function parseContextMetrics(text: string | null, threadId: string): CopilotContextMetrics | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    // Legacy rows (pre-CX-1) carry no attachedTokens — default to 0 rather than
    // rejecting: "no attached context recorded" and "attached not yet metered"
    // mean the same thing to the meter.
    if (isCopilotContextMetrics(parsed)) {
      // Segments is stripped from the spread and re-validated separately — a
      // present-but-corrupt value must come back ABSENT, never ride through
      // `...parsed` unvalidated (the guard above does not check it).
      const { segments: rawSegments, ...rest } = parsed as
        Omit<CopilotContextMetrics, "attachedTokens" | "segments"> &
        { attachedTokens?: unknown; segments?: unknown };
      const segments = parseMeterSegments(rawSegments, threadId);
      return {
        ...rest,
        attachedTokens: typeof rest.attachedTokens === "number" ? rest.attachedTokens : 0,
        ...(segments !== undefined ? { segments } : {}),
      };
    }
  } catch (err) {
    console.error(
      `[experience-copilot-store] malformed context_metrics_json for thread '${threadId}':`,
      err,
    );
    return null;
  }
  console.error(
    `[experience-copilot-store] invalid context_metrics_json shape for thread '${threadId}'`,
  );
  return null;
}

const COPILOT_LINK_TARGET_TYPES = new Set(["character", "persona", "lorebook", "script", "skill"]);

const COPILOT_TODO_STATUSES = new Set(["pending", "active", "completed", "abandoned"]);

/** Parse `todo_json` into validated {@link CopilotTodoItem}s (TAG-2, restored
 *  PM-7). Absent/malformed JSON or a non-array → `[]` (logged where corrupt,
 *  never fatal): the checklist is the model's working plan — a corrupted
 *  column must never take the thread down, and the next `updateTodo` write
 *  heals it. Invalid entries are dropped individually (a mixed array keeps
 *  its valid items), mirroring parseContextLinks. */
function parseTodo(text: string | null, threadId: string): CopilotTodoItem[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.error(`[experience-copilot-store] invalid todo_json for thread '${threadId}': not an array`);
      return [];
    }
    const items: CopilotTodoItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.title !== "string" || rec.title.length === 0 || rec.title.length > 200) continue;
      if (typeof rec.status !== "string" || !COPILOT_TODO_STATUSES.has(rec.status)) continue;
      items.push({ title: rec.title, status: rec.status as CopilotTodoItem["status"] });
    }
    return items;
  } catch (err) {
    console.error(`[experience-copilot-store] malformed todo_json for thread '${threadId}':`, err);
    return [];
  }
}

/** Parse `context_links_json` into validated {@link CopilotContextLink}s.
 *  Malformed JSON or a wrong shape → `[]` (logged, never fatal): links are
 *  advisory grounding — a corrupted column must never take the thread down,
 *  and the next `setContextLinks` write heals it. */
function parseContextLinks(text: string, threadId: string): CopilotContextLink[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.error(`[experience-copilot-store] invalid context_links_json for thread '${threadId}': not an array`);
      return [];
    }
    const links: CopilotContextLink[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.targetType !== "string" || !COPILOT_LINK_TARGET_TYPES.has(rec.targetType)) continue;
      if (typeof rec.targetId !== "string" || rec.targetId.length === 0) continue;
      links.push({ targetType: rec.targetType as CopilotContextLink["targetType"], targetId: rec.targetId });
    }
    return links;
  } catch (err) {
    console.error(`[experience-copilot-store] malformed context_links_json for thread '${threadId}':`, err);
    return [];
  }
}

export { parseContextMetrics, parseContextLinks, parseTodo };
