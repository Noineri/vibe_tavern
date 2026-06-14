/**
 * Canvas normalization — the single materialization + normalization point for a
 * preset's positional state (CANVAS_SINGLE_SOURCE_PLAN, Wave 2).
 *
 * `promptOrder[]` is the sole authoritative store for order/zone/depth/enabled.
 * `customInjections[]` is content-only (`{ identifier, name, content, role }`).
 *
 * This pure function is called once in `preset-store.mapRow` (after the single
 * `JSON.parse`) so every reader downstream receives a valid, normalized canvas.
 * It is idempotent (I11): normalizing an already-normalized canvas yields the
 * same canvas.
 */

import type {
  CustomInjection,
  PromptOrderEntry,
  PromptSlot,
  PromptZone,
} from "./api-types.js";
import { DEFAULT_PROMPT_ORDER, inferSlot } from "./prompt-slot.js";

// ─── Legacy shapes (defensive reads of pre-refactor stored data) ─────────────
// `CustomInjection` was narrowed to content-only in Wave 1; these interfaces
// describe the positional/ST-compat fields that MAY still live in stored JSON.
// Reading them is fully typed (no `as any`); they are stripped on output.

interface LegacyInjection {
  identifier?: string;
  name: string;
  content: string;
  role: string;
  /** Legacy positional (removed in Wave 1). */
  depth?: number;
  enabled?: boolean;
  slot?: PromptSlot;
  injectionPosition?: number | string;
  injectionOrder?: number;
  promptOrderIndex?: number;
  promptOrderPlacement?: "before_chat" | "after_chat";
}

interface LegacyOrderEntry {
  identifier: string;
  enabled: boolean;
  order?: number;
  zone?: PromptZone;
  depth?: number | null;
  kind?: "built_in" | "custom";
}

const BUILTIN_IDENTIFIERS = new Set(Object.keys(DEFAULT_PROMPT_ORDER));

function isBuiltinIdentifier(identifier: string): boolean {
  return BUILTIN_IDENTIFIERS.has(identifier);
}

function inferKind(
  identifier: string,
  declared?: "built_in" | "custom",
): "built_in" | "custom" {
  if (declared === "built_in" || declared === "custom") return declared;
  return isBuiltinIdentifier(identifier) ? "built_in" : "custom";
}

function zoneRank(zone: PromptZone): number {
  return zone === "before_chat" ? 0 : zone === "in_chat" ? 1 : 2;
}

/**
 * Normalize a preset's canvas to the single-source-of-truth shape.
 *
 * Guarantees (CANVAS_SINGLE_SOURCE_PLAN invariants):
 * - **I2** — `customInjections` content-only (positional + ST-compat stripped).
 * - **I3** — every `promptOrder` entry fully populated
 *   `{ identifier, enabled, order, zone, depth, kind }`.
 * - **I4** — every injection identifier ↔ exactly one `kind:"custom"` canvas
 *   entry (synthesize if missing; drop orphan custom entries).
 * - **I5** — every injection has an `identifier` (synthesized if missing).
 * - **I6** — `order` dense ascending `0,1,2,…` within each zone.
 * - **D1** — `in_chat` depth ≥ 1; `after_chat` depth = 0; `before_chat` depth =
 *   null.
 * - **I11** — idempotent.
 *
 * Legacy `slot` (when present) **wins** over any pre-existing canvas entry — it
 * is the user's freshest positional intent.
 */
export function normalizePresetCanvas(
  rawInjections: readonly LegacyInjection[],
  rawOrder: readonly LegacyOrderEntry[],
): { customInjections: CustomInjection[]; promptOrder: PromptOrderEntry[] } {
  // ── I5: synthesize identifiers for injections missing one ─────────────────
  const usedIds = new Set<string>();
  for (const o of rawOrder) if (o.identifier) usedIds.add(o.identifier);
  for (const inj of rawInjections)
    if (inj.identifier && inj.identifier.trim()) usedIds.add(inj.identifier);

  let autoCounter = 0;
  const synthId = (): string => {
    let id: string;
    do {
      id = `custom_autoid_${autoCounter++}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  // ── Clone + assign identifiers; dedupe by identifier (first wins) ─────────
  const seenInjectionIds = new Set<string>();
  const injections: LegacyInjection[] = [];
  for (const raw of rawInjections) {
    const id = raw.identifier && raw.identifier.trim() ? raw.identifier : synthId();
    if (seenInjectionIds.has(id)) continue; // duplicate — keep first
    seenInjectionIds.add(id);
    injections.push({ ...raw, identifier: id });
  }

  // ── Build canvas entry map by identifier (first occurrence wins) ──────────
  const entryMap = new Map<string, LegacyOrderEntry>();
  for (const o of rawOrder) {
    if (!o.identifier) continue;
    if (!entryMap.has(o.identifier)) entryMap.set(o.identifier, { ...o });
  }

  // ── I4a: ensure every custom injection has a canvas entry (slot wins) ──────
  for (const inj of injections) {
    const id = inj.identifier!;
    const existing = entryMap.get(id);

    if (inj.slot) {
      // Legacy slot is the user's freshest positional intent — it wins.
      const slot = inj.slot;
      if (existing) {
        existing.zone = slot.zone;
        existing.depth = slot.depth;
        existing.order = slot.order;
      } else {
        entryMap.set(id, {
          identifier: id,
          enabled: inj.enabled ?? true,
          order: slot.order,
          zone: slot.zone,
          depth: slot.depth,
          kind: "custom",
        });
      }
    } else if (!existing) {
      // No slot, no canvas entry — infer from legacy ST-compat fields.
      // Mirrors the deleted `migrateInjection` (null position = absolute) to
      // preserve behavior for never-migrated legacy data (I10).
      const isAbsolute =
        inj.injectionPosition === 1 ||
        inj.injectionPosition === "absolute" ||
        inj.injectionPosition == null;
      const slot = inferSlot({
        injectionPosition: isAbsolute ? 1 : 0,
        depth: inj.depth ?? 0,
        placement: inj.promptOrderPlacement,
        order: isAbsolute
          ? (inj.injectionOrder ?? inj.promptOrderIndex ?? 0)
          : (inj.promptOrderIndex ?? inj.injectionOrder ?? 0),
      });
      entryMap.set(id, {
        identifier: id,
        enabled: inj.enabled ?? true,
        order: slot.order,
        zone: slot.zone,
        depth: slot.depth,
        kind: "custom",
      });
    }
  }

  // ── I4b: collect entries; drop orphan custom entries; infer kind ──────────
  const injectionIds = new Set(injections.map((i) => i.identifier!));
  const entries: LegacyOrderEntry[] = [];
  for (const entry of entryMap.values()) {
    const kind = inferKind(entry.identifier, entry.kind);
    if (kind === "custom" && !injectionIds.has(entry.identifier)) continue;
    entry.kind = kind;
    entries.push(entry);
  }

  // ── I3 + D1: fill missing zone/depth/order/enabled; enforce depth rules ───
  for (const entry of entries) {
    if (entry.zone == null) {
      const defaultOrder = DEFAULT_PROMPT_ORDER[entry.identifier];
      entry.zone = inferSlot({ defaultOrder }).zone;
    }
    if (entry.zone === "before_chat") {
      entry.depth = null;
    } else if (entry.zone === "after_chat") {
      entry.depth = 0;
    } else {
      // in_chat — MUST be ≥ 1 (D1) so it never collides with after_chat (depth 0)
      const d = typeof entry.depth === "number" ? entry.depth : 0;
      entry.depth = d < 1 ? 1 : d;
    }
    if (typeof entry.order !== "number") {
      entry.order = DEFAULT_PROMPT_ORDER[entry.identifier] ?? 100;
    }
    if (typeof entry.enabled !== "boolean") entry.enabled = true;
  }

  // ── I6: dense renumber order within each zone (stable sort preserves order) ──
  const byZone: Record<PromptZone, LegacyOrderEntry[]> = {
    before_chat: [],
    in_chat: [],
    after_chat: [],
  };
  for (const entry of entries) byZone[entry.zone!].push(entry);
  for (const zone of ["before_chat", "in_chat", "after_chat"] as const) {
    byZone[zone].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    byZone[zone].forEach((entry, i) => {
      entry.order = i;
    });
  }

  // ── Build clean output types ──────────────────────────────────────────────
  const cleanInjections: CustomInjection[] = injections.map((inj) => ({
    identifier: inj.identifier!,
    name: inj.name,
    content: inj.content,
    role: (
      inj.role === "system" || inj.role === "user" || inj.role === "assistant"
        ? inj.role
        : "system"
    ) as "system" | "user" | "assistant",
  }));

  const cleanOrder: PromptOrderEntry[] = [...entries]
    .sort((a, b) => {
      const z = zoneRank(a.zone!) - zoneRank(b.zone!);
      return z !== 0 ? z : (a.order ?? 0) - (b.order ?? 0);
    })
    .map((entry) => ({
      identifier: entry.identifier,
      enabled: entry.enabled ?? true,
      order: entry.order ?? 0,
      zone: entry.zone!,
      depth: entry.depth ?? null,
      kind: entry.kind!,
    }));

  return { customInjections: cleanInjections, promptOrder: cleanOrder };
}
