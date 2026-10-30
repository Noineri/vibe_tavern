/**
 * Markdown result cache (LC-4, LONG_CHAT_PERFORMANCE_REPORT step 4) — the ONE
 * bounded LRU over the element tree react-markdown returns.
 *
 * react-markdown's default export is a synchronous, hook-free function of its
 * options (10.1.0 lib/index.js: createProcessor → runSync(parse) → post/
 * toJsxRuntime), so the element tree it returns can be cached and reused across
 * mounts. React.memo only skips re-renders of an ALREADY-MOUNTED block; a chat
 * reopen or a branch create/switch remounts the whole feed, and without this
 * cache every remounted message rebuilds the processor and re-parses its full
 * text (D4). A forked branch carries the same texts as its source, so the cache
 * turns the post-fork remount into near-pure DOM creation; the streaming prefix
 * instance (agent-streaming-markdown.tsx) rides the same cache on its remounts.
 *
 * Key completeness — the key is variant + the exact text handed to the renderer
 * (after preserveEscapedUnderscoreTags). That is complete because every plugin
 * in markdown.tsx's lists is a pure function of the text: remarkGfm
 * (mdast-only), remarkUnderscoreCustomTags + rehypeRestoreEscapedUnderscoreTags
 * (string/tree transforms over the text, markdown-underscore-tags.ts), rehypeRaw
 * (tree-only), rehypeSanitize (fixed module-scope schema), rehypeQuotedText /
 * rehypeSystemBanner (tree-only walks; their g-flag regexes reset lastIndex
 * before use). None reads outside state, so nothing else needs to enter the key.
 * The variant selects the plugin lists and the components map — both
 * module-scope constants in markdown.tsx, so their identities are stable.
 *
 * Reusing a cached element tree across mounts is safe because React elements
 * are immutable descriptions: each mount renders fresh component instances
 * (CodeBlock's copied flag, ImageBlock's viewer state) and creates fresh DOM;
 * only the parse is skipped. markdown.tsx's `$`-gated lazy KaTeX path bypasses
 * this cache by construction, and so does its transient Suspense fallback.
 *
 * Bounded LRU: a JS Map's insertion order is the recency order (a hit
 * re-inserts on the most-recent side); eviction walks the least-recent side
 * until BOTH bounds hold — entry count AND total text size (UTF-16 code
 * units). Bounds sized for two chat stable tails (81–100 messages each,
 * message-render-window.ts) plus fork/switch margin.
 */
import type { ReactElement } from "react";

/** The public `Markdown` variant union — markdown.tsx's `MarkdownProps` keys its `variant` prop to this one spelling. */
export type MarkdownVariant = "chat" | "plain" | "agent-rp" | "agent-plain";

interface MarkdownResultCacheTunables {
  maxEntries: number;
  maxTotalChars: number;
}

const DEFAULT_MARKDOWN_RESULT_CACHE_TUNABLES: MarkdownResultCacheTunables = {
  maxEntries: 300,
  maxTotalChars: 2_000_000,
};

const markdownResultCacheTunables: MarkdownResultCacheTunables = { ...DEFAULT_MARKDOWN_RESULT_CACHE_TUNABLES };

interface MarkdownResultCacheEntry {
  element: ReactElement;
  /** The key text's length — the size accounting unit. */
  chars: number;
}

const markdownResultCache = new Map<string, MarkdownResultCacheEntry>();
let markdownResultCacheChars = 0;

/**
 * Composite key: variant + NUL + text. No variant name contains NUL, so the
 * first NUL is always the separator — two different (variant, text) pairs can
 * never collide into one key.
 */
function markdownResultCacheKey(variant: MarkdownVariant, text: string): string {
  return `${variant}\0${text}`;
}

/** Cache read; a hit re-inserts the entry on the most-recent side (LRU touch). */
export function lookupMarkdownResult(variant: MarkdownVariant, text: string): ReactElement | null {
  const key = markdownResultCacheKey(variant, text);
  const entry = markdownResultCache.get(key);
  if (entry === undefined) return null;
  markdownResultCache.delete(key);
  markdownResultCache.set(key, entry);
  return entry.element;
}

/** Cache write on a miss; evicts from the least-recent side until both bounds hold. */
export function storeMarkdownResult(variant: MarkdownVariant, text: string, element: ReactElement): void {
  // A single text larger than the whole size bound is never cached (it could
  // only evict itself or everything else).
  if (text.length > markdownResultCacheTunables.maxTotalChars) return;

  const key = markdownResultCacheKey(variant, text);
  markdownResultCache.set(key, { element, chars: text.length });
  markdownResultCacheChars += text.length;

  while (
    markdownResultCache.size > 0 &&
    (markdownResultCache.size > markdownResultCacheTunables.maxEntries ||
      markdownResultCacheChars > markdownResultCacheTunables.maxTotalChars)
  ) {
    const oldestKey = markdownResultCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = markdownResultCache.get(oldestKey);
    markdownResultCache.delete(oldestKey);
    if (oldest !== undefined) markdownResultCacheChars -= oldest.chars;
  }
}

/** Override cache tunables (tests: eviction at small bounds). */
export function configureMarkdownResultCacheForTests(tunables: Partial<MarkdownResultCacheTunables>): void {
  Object.assign(markdownResultCacheTunables, tunables);
}

/** Drop every cached entry and restore the default tunables (test isolation). */
export function resetMarkdownResultCacheForTests(): void {
  markdownResultCache.clear();
  markdownResultCacheChars = 0;
  Object.assign(markdownResultCacheTunables, DEFAULT_MARKDOWN_RESULT_CACHE_TUNABLES);
}
