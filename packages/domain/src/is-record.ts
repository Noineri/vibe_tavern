/**
 * The one plain-object guard (SC-5r1): a non-null object that is not an
 * array. This predicate was previously hand-written as private
 * `isRecord` / `isPlainObject` copies across the packages; the single
 * definition keeps the rule from drifting and stops new copies. Guards that
 * deliberately let arrays through (SC-5r2) are a different predicate and
 * must not be merged into this one.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
