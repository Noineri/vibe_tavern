import { useCallback, useSyncExternalStore } from "react";
import {
  getMessageSlotRegistryVersion,
  getMessageSlots,
  resolveMessageSlots,
  subscribeMessageSlots,
  type MessageSlotContext,
  type MessageSlotDescriptor,
  type MessageSlotId,
} from "../lib/message-slot-registry.js";

function getCandidates(
  slotId: MessageSlotId,
  ctx: MessageSlotContext,
): readonly MessageSlotDescriptor[] {
  return getMessageSlots()
    .filter((descriptor) => descriptor.slot === slotId)
    .filter((descriptor) => !descriptor.roles || descriptor.roles.includes(ctx.messageRole));
}

/**
 * Resolve a slot position while subscribing only to each descriptor's primitive
 * visibility source. Registry changes rebuild the source subscriptions.
 */
export function useResolvedMessageSlots(
  slotId: MessageSlotId,
  ctx: MessageSlotContext,
): readonly MessageSlotDescriptor[] {
  const registryVersion = useSyncExternalStore(
    subscribeMessageSlots,
    getMessageSlotRegistryVersion,
    getMessageSlotRegistryVersion,
  );

  const subscribeVisibility = useCallback((listener: () => void) => {
    const unsubscribers = getCandidates(slotId, ctx)
      .flatMap((descriptor) => descriptor.visibility
        ? [descriptor.visibility.subscribe(ctx, listener)]
        : []);

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [registryVersion, slotId, ctx]);

  const getVisibilitySnapshot = useCallback(() => JSON.stringify(
    getCandidates(slotId, ctx).map((descriptor) => [
      descriptor.id,
      descriptor.visibility?.getSnapshot(ctx) ?? null,
    ]),
  ), [registryVersion, slotId, ctx]);

  useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getVisibilitySnapshot,
  );

  return resolveMessageSlots(slotId, ctx);
}
