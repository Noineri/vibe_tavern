/**
 * Pure drop interpretation for R-13 profile grouping (R-13b).
 *
 * ONE flat visual order interleaves profiles + standalone rules by sortOrder;
 * expanded profiles inline their members. The interpretation is pure so it is
 * unit-testable without dnd-kit.
 */

export type FlatKind = "profile" | "rule";

export interface FlatItem {
  /** Composite sortable id: `profile:<id>` / `rule:<id>`. */
  sortableId: string;
  id: string;
  kind: FlatKind;
  sortOrder: number;
  /** For rules: which profile they belong to (null = standalone). */
  profileId: string | null;
  /** For profiles: memberCount (derived, not needed for logic). */
}

export type DropKind = "reorder" | "attach" | "detach" | "move-within-profile";

export interface DropInterpretation {
  kind: DropKind;
  /** When attach/detach, the rule and target profile. */
  ruleId?: string;
  profileId?: string | null;
  /** Top-level reorder needs no extra ids; within-profile reorder needs profileId. */
}

function sortableIdFor(kind: FlatKind, id: string): string {
  return `${kind}:${id}`;
}

/** Build the flat visual order from profiles + presets + expanded set. */
export function buildFlatVisualOrder(
  profiles: Array<{ id: string; sortOrder: number; name: string }>,
  presets: Array<{ id: string; sortOrder: number; name: string; profileId: string | null }>,
  expandedIds: Set<string>,
): FlatItem[] {
  // Members grouped by profileId
  const membersByProfile = new Map<string, typeof presets>();
  const standalone: typeof presets = [];
  for (const p of presets) {
    if (p.profileId) {
      const arr = membersByProfile.get(p.profileId);
      if (arr) arr.push(p);
      else membersByProfile.set(p.profileId, [p]);
    } else {
      standalone.push(p);
    }
  }
  // Sort members per profile by sortOrder then name
  for (const [, arr] of membersByProfile) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  // Top-level items: profiles + standalone rules, sorted together
  type TopItem = { id: string; kind: FlatKind; sortOrder: number; name: string; profileId: string | null };
  const top: TopItem[] = [
    ...profiles.map((pr) => ({ id: pr.id, kind: "profile" as const, sortOrder: pr.sortOrder, name: pr.name, profileId: null })),
    ...standalone.map((r) => ({ id: r.id, kind: "rule" as const, sortOrder: r.sortOrder, name: r.name, profileId: null })),
  ];
  top.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const flat: FlatItem[] = [];
  for (const t of top) {
    flat.push({
      sortableId: sortableIdFor(t.kind, t.id),
      id: t.id,
      kind: t.kind,
      sortOrder: t.sortOrder,
      profileId: null,
    });
    if (t.kind === "profile" && expandedIds.has(t.id)) {
      const members = membersByProfile.get(t.id) ?? [];
      for (const m of members) {
        flat.push({
          sortableId: sortableIdFor("rule", m.id),
          id: m.id,
          kind: "rule",
          sortOrder: m.sortOrder,
          profileId: t.id,
        });
      }
    }
  }
  return flat;
}

/** Interpret a drop of activeId onto overId against the flat visual order. */
export function interpretRegexDrop(
  flatOrder: FlatItem[],
  activeId: string,
  overId: string,
): DropInterpretation {
  const active = flatOrder.find((f) => f.sortableId === activeId);
  const over = flatOrder.find((f) => f.sortableId === overId);
  if (!active || !over) return { kind: "reorder" };
  if (active.sortableId === over.sortableId) return { kind: "reorder" };

  // Profile drag: always top-level reorder
  if (active.kind === "profile") {
    return { kind: "reorder" };
  }

  // Active is a rule
  const activeProfileId = active.profileId; // null = standalone, else member
  // Determine target profile for the drop location
  let targetProfileId: string | null = null;
  if (over.kind === "profile") {
    targetProfileId = over.id;
  } else if (over.kind === "rule" && over.profileId) {
    targetProfileId = over.profileId;
  } else {
    targetProfileId = null;
  }

  if (activeProfileId === null && targetProfileId !== null) {
    // standalone → attach to profile
    return { kind: "attach", ruleId: active.id, profileId: targetProfileId };
  }
  if (activeProfileId !== null && targetProfileId === null) {
    // member → detach to standalone
    return { kind: "detach", ruleId: active.id };
  }
  if (activeProfileId !== null && targetProfileId !== null && activeProfileId !== targetProfileId) {
    // member → different profile (attach to new)
    return { kind: "attach", ruleId: active.id, profileId: targetProfileId };
  }
  if (activeProfileId !== null && targetProfileId !== null && activeProfileId === targetProfileId) {
    return { kind: "move-within-profile", ruleId: active.id, profileId: activeProfileId };
  }
  // Both standalone (or both top-level) → reorder
  return { kind: "reorder" };
}
