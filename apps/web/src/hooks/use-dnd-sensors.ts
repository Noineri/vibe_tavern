import { MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

/**
 * Standard @dnd-kit sensor bundle for reorderable lists.
 *
 * - `MouseSensor` `activationConstraint.distance: 2` — keeps a click (no movement)
 *   distinct from a drag, so clicking a row to open/edit doesn't start reordering,
 *   while still activating quickly enough not to feel laggy.
 * - `TouchSensor` `activationConstraint.distance: 1` — mobile lists use a dedicated
 *   44px drag handle with `touch-action: none`; the smaller threshold coalesces with
 *   the gesture.
 *
 * Extracted from `LoreEntryList` + `InjectionTable`, which had diverged copies — one
 * with this rationale in a comment, one without. Centralising it here means both
 * consumers inherit the reasoning instead of one silently losing it.
 */
export function useDndSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 2 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 1 } }),
  );
}
