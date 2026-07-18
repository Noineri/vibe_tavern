/**
 * Generic in-memory lexical search index for the co-author / shared context
 * search feature (Wave D). Pure retrieval: it indexes projected records and
 * returns compact locator metadata; it performs NO canonical reads and owns no
 * persistence. The caller (the context-search service in services/api) is the
 * sole reader of full entity content via the canonical stores.
 *
 * Technology choice (see `coauthor-context-search-retrieval-research`): SQLite
 * FTS5, available natively in `bun:sqlite`. Two virtual tables back a staged
 * ranking — Porter + `unicode61` for whole-token lexical recall over
 * (title, body), `trigram` for partial-title substring fallback. Trigram is a
 * FALLBACK tier: its results are appended below content matches and never
 * re-rank them (naive RRF fusion was measured to hurt recall).
 *
 * Lifecycle: an index is built once (`buildContextSearchIndex`) from an
 * immutable snapshot of records and discarded after the turn. No durable
 * tables, migrations, or cross-CRUD invalidation exist — the next turn rebuilds
 * from canonical stores, so edits are always visible without a restart.
 *
 * Query safety: MATCH expressions are built from word tokens only (FTS5
 * operators are dropped by tokenization) and trigram phrases have `"` / `\`
 * stripped, so raw tool input can never break the query or alter its meaning.
 */

import { Database } from "bun:sqlite";

/** Discriminator grouping record families that share read semantics. */
export type ContextChannel = "entity" | "skill";

/** How a result matched the query, in priority order. */
export type ContextMatchKind = "exact-title" | "content" | "trigram-title";

/**
 * A record projected into the index. The index is generic over `channel` /
 * `type`; it does not know what a "character" or "skill" is — only the
 * projecting caller does. All fields except `body` are surfaced in the result
 * DTO; `body` is indexed but never returned (two-step search → read).
 */
export interface IndexedContextRecord {
  /** Read-semantics family: `"entity"` (canonical stores) or `"skill"` (files). */
  channel: ContextChannel;
  /** Kind within the channel, e.g. `"character"`, `"lore-entry"`, `"skill"`. */
  type: string;
  /** Canonical locator the reader uses to fetch full content. */
  id: string;
  /** Display name / title. Indexed with priority over body. */
  title: string;
  /** Searchable body text (excluding the title). Indexed, never returned. */
  body: string;
  /** Scope key for ranking, e.g. `"global"`, `"character:<id>"`, `"persona:<id>"`. */
  scope: string;
  /** Owning entity id (for active-scope boosting); `null` when global. */
  ownerId: string | null;
  /** Parent entity id (e.g. the lorebook id for a lore entry); `null` when none. */
  parentId: string | null;
  /** Extra locator/metadata surfaced in the DTO (e.g. `lorebookId`, `skillPath`). */
  meta: Record<string, string | null>;
}

/** Compact locator metadata returned by {@link ContextSearchIndex.search}. */
export interface ContextSearchResult {
  channel: ContextChannel;
  type: string;
  id: string;
  title: string;
  scope: string;
  ownerId: string | null;
  parentId: string | null;
  meta: Record<string, string | null>;
  matchKind: ContextMatchKind;
}

export interface ContextSearchOptions {
  /** Restrict results to these `type` values (e.g. `["lore-entry","lorebook"]`). */
  types?: readonly string[];
  /**
   * Scope keys whose records rank first WITHIN their match tier (does not cross
   * tiers). The active character/persona and their bound/owned resources belong
   * here; pass an empty/omitted list for flat `library` ordering.
   */
  scopeBoosts?: readonly string[];
  /** Max results. Defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  limit?: number;
}

/** Shared default cap so the tool layer and tests reference one constant. */
export const DEFAULT_SEARCH_LIMIT = 8;

/** Trigram tokenizer indexes contiguous 3-char sequences; shorter = no match. */
const TRIGRAM_MIN_CHARS = 3;

export interface ContextSearchIndex {
  /** Number of records indexed. */
  readonly size: number;
  /** Tiered lexical search; never returns `body`. */
  search(query: string, opts?: ContextSearchOptions): ContextSearchResult[];
  /** Release the backing in-memory DB. Optional — GC reclaims it otherwise. */
  dispose(): void;
}

interface PreparedTier {
  readonly tier: ContextMatchKind;
  readonly seq: number;
  readonly recordIdx: number;
  boosted: boolean;
}

const TIER_RANK: Record<ContextMatchKind, number> = {
  "exact-title": 0,
  content: 1,
  "trigram-title": 2,
};

/**
 * Build an immutable search index over `records`. The records array is copied;
 * mutation after the call is not reflected. Each record receives an implicit
 * 1-based rowid matching its FTS rows so FTS hits map back to the record.
 */
export function buildContextSearchIndex(records: readonly IndexedContextRecord[]): ContextSearchIndex {
  const store: IndexedContextRecord[] = records.map((r) => ({ ...r, meta: { ...r.meta } }));
  const db = new Database(":memory:");
  // content=all table: Porter stems + unicode61 (multilingual, case-insensitive).
  db.run(
    "CREATE VIRTUAL TABLE fts_content USING fts5(title, body, tokenize = 'porter unicode61')",
  );
  // partial-title table: trigram substring matching for names the user only
  // partially remembers.
  db.run("CREATE VIRTUAL TABLE fts_trigram USING fts5(title, tokenize = 'trigram')");

  const insertContent = db.prepare(
    "INSERT INTO fts_content(rowid, title, body) VALUES (?, ?, ?)",
  );
  const insertTrigram = db.prepare("INSERT INTO fts_trigram(rowid, title) VALUES (?, ?)");

  // Exact-title promotion tier, O(1) lookup. Two flavors share the tier: full
  // normalized-title equality ("aria stormwind" -> "Aria Stormwind") and
  // title-token subset ("aria" -> "Aria Stormwind", since `aria` is one of its
  // title tokens). Token-subset lets a single-name query promote a multiword
  // title above body-only content matches without resorting to trigram.
  const byNormTitle = new Map<string, number[]>();
  const byTitleToken = new Map<string, number[]>();
  const titleTokens: string[][] = new Array(store.length);
  const normTitles: string[] = new Array(store.length);

  const tx = db.transaction(() => {
    for (let i = 0; i < store.length; i++) {
      const rec = store[i];
      const rowid = i + 1;
      insertContent.run(rowid, rec.title, rec.body);
      insertTrigram.run(rowid, rec.title);
      const nt = normalizeTitle(rec.title);
      normTitles[i] = nt;
      if (nt) {
        const bucket = byNormTitle.get(nt);
        if (bucket) bucket.push(i);
        else byNormTitle.set(nt, [i]);
        const tokens = nt.split(" ");
        titleTokens[i] = tokens;
        for (const tk of tokens) {
          const tb = byTitleToken.get(tk);
          if (tb) tb.push(i);
          else byTitleToken.set(tk, [i]);
        }
      } else {
        titleTokens[i] = [];
      }
    }
  });
  tx();

  const matchContent = db.prepare(
    "SELECT rowid, bm25(fts_content, 10.0, 1.0) AS rank FROM fts_content WHERE fts_content MATCH ? ORDER BY rank",
  );
  const matchTrigram = db.prepare(
    "SELECT rowid, bm25(fts_trigram) AS rank FROM fts_trigram WHERE title MATCH ? ORDER BY rank",
  );

  function search(query: string, opts?: ContextSearchOptions): ContextSearchResult[] {
    const types = opts?.types;
    const typeSet = types && types.length > 0 ? new Set(types) : null;
    const boostSet =
      opts?.scopeBoosts && opts.scopeBoosts.length > 0 ? new Set(opts.scopeBoosts) : null;
    const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT;

    const contentMatch = toContentMatch(query);
    const trigPhrase = toTrigramPhrase(query);
    const normQuery = normalizeTitle(query);

    const seen = new Set<number>();
    const items: PreparedTier[] = [];
    let seq = 0;

    const push = (recordIdx: number, tier: ContextMatchKind): void => {
      if (seen.has(recordIdx)) return;
      const rec = store[recordIdx];
      if (typeSet && !typeSet.has(rec.type)) return;
      seen.add(recordIdx);
      items.push({
        tier,
        seq: seq++,
        recordIdx,
        boosted: boostSet ? boostSet.has(rec.scope) : false,
      });
    };

    // Tier A — exact normalized title promotion (full-title equality and
    // title-token subset). Title-derived matches rank above body content.
    if (normQuery) {
      const exact = byNormTitle.get(normQuery);
      if (exact) for (const idx of exact) push(idx, "exact-title");
      const qTokens = normQuery.split(" ");
      const seed = byTitleToken.get(qTokens[0]);
      if (seed) {
        for (const idx of seed) {
          if (seen.has(idx)) continue;
          const tks = titleTokens[idx];
          // require EVERY query token to be a title token (subset)
          if (qTokens.every((qt) => tks.includes(qt))) push(idx, "exact-title");
        }
      }
    }

    // Tier B — weighted lexical content (title weighted 10x body).
    if (contentMatch) {
      const rows = matchContent.all(contentMatch) as Array<{ rowid: number }>;
      for (const row of rows) {
        const idx = row.rowid - 1;
        if (idx >= 0 && idx < store.length) push(idx, "content");
      }
    }

    // Tier C — trigram partial-title fallback (only ≥3-char phrases).
    if (trigPhrase) {
      const rows = matchTrigram.all(trigPhrase) as Array<{ rowid: number }>;
      for (const row of rows) {
        const idx = row.rowid - 1;
        if (idx >= 0 && idx < store.length) push(idx, "trigram-title");
      }
    }

    // Staged ordering: tier first, then scope-boost WITHIN the tier (never
    // across tiers), then bm25/insertion order via `seq`.
    items.sort((a, b) => {
      const ta = TIER_RANK[a.tier];
      const tb = TIER_RANK[b.tier];
      if (ta !== tb) return ta - tb;
      // boosted (false=0) before non-boosted (true=1)? boosted should come first.
      const ba = a.boosted ? 0 : 1;
      const bb = b.boosted ? 0 : 1;
      if (ba !== bb) return ba - bb;
      return a.seq - b.seq;
    });

    const results: ContextSearchResult[] = [];
    for (let i = 0; i < items.length && results.length < limit; i++) {
      const it = items[i];
      const rec = store[it.recordIdx];
      results.push({
        channel: rec.channel,
        type: rec.type,
        id: rec.id,
        title: rec.title,
        scope: rec.scope,
        ownerId: rec.ownerId,
        parentId: rec.parentId,
        meta: { ...rec.meta },
        matchKind: it.tier,
      });
    }
    return results;
  }

  return {
    size: store.length,
    search,
    dispose: () => db.close(),
  };
}

/**
 * Normalize a title or query for exact-match keying: lowercase, NFKD-fold
 * diacritics, collapse internal whitespace, strip leading/trailing non-word
 * chars. Returns "" for inputs with no word characters.
 */
function normalizeTitle(s: string): string {
  if (!s) return "";
  const folded = s.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
  const lower = folded.toLowerCase();
  const tokens = lower.match(/[\p{L}\p{N}]+/gu);
  return tokens ? tokens.join(" ") : "";
}

/**
 * Build a safe FTS5 MATCH expression for the content table from word tokens.
 * Word-tokenization drops every FTS5 operator (`"`, `*`, `:`, `(`, `OR`, ...),
 * so no escaping is needed. Returns "" (skip tier) when there are no tokens.
 * Tokens are whole-word (Porter-stemmed); partial matching is the trigram
 * tier's job, so no `*` prefixes are appended.
 */
function toContentMatch(query: string): string {
  if (!query) return "";
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return tokens && tokens.length > 0 ? tokens.join(" ") : "";
}

/**
 * Build a safe trigram MATCH phrase: lowercase, strip `"` / `\` (which break
 * trigram phrase parsing), collapse whitespace. Returns "" when shorter than
 * {@link TRIGRAM_MIN_CHARS}. Multiword phrases are passed through; the trigram
 * tokenizer ANDs their 3-gram sets, which is the desired partial-name behavior.
 */
function toTrigramPhrase(query: string): string {
  if (!query) return "";
  const cleaned = query
    .toLowerCase()
    .replace(/["\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < TRIGRAM_MIN_CHARS) return "";
  // Wrap in double quotes so the phrase is a safe literal substring query:
  // any residual FTS5 operators (OR, parens, *) become ordinary characters
  // and cannot alter query semantics or raise syntax errors. Internal quotes
  // were stripped above, so the wrapper cannot be prematurely closed.
  return '"' + cleaned + '"';
}
