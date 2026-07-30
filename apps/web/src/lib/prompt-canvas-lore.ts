import { listLoreEntries, listLorebooks } from "../api/lorebook-api.js";

export type CanvasLoreAnchorPosition = "before_char" | "after_char";

export interface CanvasLoreEntrySummary {
  id: string;
  lorebookId: string;
  lorebookName: string;
  title: string;
  position: CanvasLoreAnchorPosition;
  priority: number;
  sortOrder: number;
  /** Read-only entry content, shown when the row is expanded. Populated by
   *  the default loader from the full `LoreEntryRecord`; optional so older
   *  callers / fixtures can omit it (the row then renders collapsed-only). */
  content?: string;
  /** Primary activation keys. */
  keys?: string[];
  /** Secondary (additional) activation keys. */
  secondaryKeys?: string[];
  /** Activation logic expression (e.g. "AND(any)"). */
  logic?: string;
  /** Constantly-included (no keyword activation required). */
  constant?: boolean;
  /** Activation probability (0–100). */
  probability?: number;
  /** Per-entry injection role. */
  role?: string;
}

export interface PromptCanvasLoreContext {
  chatId: string;
  characterId: string;
  personaId: string | null;
}

type LorebookSummarySource = {
  id: string;
  name: string;
  enabled: boolean;
};

type LoreEntrySummarySource = {
  id: string;
  lorebookId: string;
  title: string;
  position: string;
  enabled: boolean;
  priority: number;
  sortOrder: number;
  content?: string;
  keys?: string[];
  secondaryKeys?: string[];
  logic?: string;
  constant?: boolean;
  probability?: number;
  role?: string;
};

export interface PromptCanvasLoreLoadDeps {
  listLorebooks: (scopeType: string, ownerId?: string) => Promise<LorebookSummarySource[]>;
  listLoreEntries: (lorebookId: string) => Promise<LoreEntrySummarySource[]>;
}

const defaultDeps: PromptCanvasLoreLoadDeps = {
  listLorebooks,
  listLoreEntries,
};

function isEnabledAnchorEntry(
  entry: LoreEntrySummarySource,
): entry is LoreEntrySummarySource & { position: CanvasLoreAnchorPosition } {
  return entry.enabled && (entry.position === "before_char" || entry.position === "after_char");
}

/**
 * Resolve the lorebooks visible to one chat using the same scope union as
 * LorebookStore.listAllActiveForChat: global + active character (direct/linked)
 * + active persona (direct/linked) + chat. The existing scope endpoint already
 * performs the direct-FK ∪ junction-link union for character/persona; this
 * display loader only deduplicates across scopes and narrows enabled entries to
 * the two canvas-anchor positions.
 */
export async function loadPromptCanvasLoreEntries(
  context: PromptCanvasLoreContext,
  deps: PromptCanvasLoreLoadDeps = defaultDeps,
): Promise<CanvasLoreEntrySummary[]> {
  const requests = [
    deps.listLorebooks("global"),
    deps.listLorebooks("character", context.characterId),
  ];
  if (context.personaId) {
    requests.push(deps.listLorebooks("persona", context.personaId));
  }
  requests.push(deps.listLorebooks("chat", context.chatId));

  const booksById = new Map<string, LorebookSummarySource>();
  for (const books of await Promise.all(requests)) {
    for (const book of books) {
      if (book.enabled && !booksById.has(book.id)) booksById.set(book.id, book);
    }
  }

  const entriesByBook = await Promise.all(
    [...booksById.values()].map(async (book) => ({
      book,
      entries: await deps.listLoreEntries(book.id),
    })),
  );

  return entriesByBook.flatMap(({ book, entries }) =>
    entries
      .filter(isEnabledAnchorEntry)
      .map((entry) => ({
        id: entry.id,
        lorebookId: entry.lorebookId,
        lorebookName: book.name,
        title: entry.title,
        position: entry.position,
        priority: entry.priority,
        sortOrder: entry.sortOrder,
        content: entry.content,
        keys: entry.keys,
        secondaryKeys: entry.secondaryKeys,
        logic: entry.logic,
        constant: entry.constant,
        probability: entry.probability,
        role: entry.role,
      })),
  );
}
