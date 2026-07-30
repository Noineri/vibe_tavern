import { useRef } from "react";

/**
 * Returns the last non-null value of `value`: while `value` is non-null it is
 * returned as-is, and once `value` becomes null the most recent non-null value
 * is retained.
 *
 * Lets overlay callers close by nulling their open-state (a `menuId`) while the
 * controlled sheet keeps rendering its last content during the exit
 * transition. The canonical broken pattern is
 * `{menuId && <Sheet open={true} title={derive(menuId)} …/>}`: nulling
 * `menuId` unmounts the whole sheet before the exit animation can play, AND —
 * even after flipping to always-mounted `<Sheet open={menuId !== null}>` — a
 * naive `title={derive(menuId)}` would empty the sheet mid-exit (menuId is
 * null during the close transition). Deriving from this hook instead holds the
 * snapshot: `<Sheet open={menuId !== null} title={derive(useLastNonNull(menuId))} …/>`.
 *
 * Re-frozen on every render where `value` is non-null, so live edits while
 * open propagate; only the closed → null transition holds the last value.
 *
 * (Ref mutation during render is the standard `usePrevious` pattern —
 * idempotent, no external side effect, safe under Strict Mode double-render.)
 */
export function useLastNonNull<T>(value: T | null): T | null {
	const ref = useRef<T | null>(null);
	if (value !== null) ref.current = value;
	return value !== null ? value : ref.current;
}
