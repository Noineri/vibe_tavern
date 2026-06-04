// ────────────────────────────────────────────────────────────────────────────
// EventBus — typed publish/subscribe with error isolation
// ────────────────────────────────────────────────────────────────────────────
// Replaces hardcoded hooks (onAssistantAppended, etc.) with a typed event
// system. Features subscribe to events instead of wiring into server setup.
//
// Design decisions:
// - emit() is synchronous — handlers fire immediately via Promise.allSettled()
// - One handler failure does not block others (error isolation)
// - Errors are logged via the domain logger, not swallowed
// - on() returns an unsubscribe function
// - AbortSignal can be used to auto-unsubscribe scoped handlers
// - No middleware, no queuing, no ordering guarantees
// ────────────────────────────────────────────────────────────────────────────

import { tag } from "./logger.js";

const eventBusLogger = tag("event-bus");

/**
 * Core event map — events emitted by the chat orchestrator and server.
 * Features can extend this via declaration merging:
 *
 *   declare module "./event-bus.js" {
 *     interface EventMap {
 *       "insights.objective-checked": { chatId: string; messageId: string };
 *     }
 *   }
 */
export interface EventMap {
  /** A message was fully appended to the chat (streaming done or non-streaming). */
  "message.appended": { chatId: string; messageId: string; role: "user" | "assistant" | "system" | "tool" };
  /** A new message was created (before any content is appended). */
  "message.created": { chatId: string; messageId: string; role: "user" | "assistant" | "system" | "tool"; content: string };
  /** A chat was loaded/opened. */
  "chat.loaded": { chatId: string };
  /** Provider finished a response (success or failure). */
  "provider.response": { chatId: string; messageId: string; model: string; success: boolean };
}

type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * Minimal typed event bus. Create one instance and share it across the app.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<Handler<never>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   *
   * If an AbortSignal is provided, the handler is removed automatically when
   * the signal aborts. Aborted signals return a no-op unsubscribe.
   */
  on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>, options?: { signal?: AbortSignal }): () => void {
    if (options?.signal?.aborted) return () => {};

    const key = event as string;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }

    const storedHandler = handler as Handler<never>;
    set.add(storedHandler);

    let isUnsubscribed = false;
    const unsubscribe = () => {
      if (isUnsubscribed) return;
      isUnsubscribed = true;
      set!.delete(storedHandler);
      options?.signal?.removeEventListener("abort", unsubscribe);
    };

    options?.signal?.addEventListener("abort", unsubscribe, { once: true });
    return unsubscribe;
  }

  /**
   * Emit an event. All handlers run in parallel via Promise.allSettled().
   * One handler failure does not affect others — errors are logged.
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const key = event as string;
    const set = this.handlers.get(key);
    if (!set || set.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const handler of set) {
      promises.push(
        Promise.resolve()
          .then(() => (handler as Handler<EventMap[K]>)(payload))
          .catch((err: unknown) => {
            eventBusLogger.error("Handler error for \"%s\":", key, err);
          }),
      );
    }
    // Fire-and-forget: we deliberately do not await
    void Promise.allSettled(promises);
  }

  /**
   * Remove all handlers. Useful for testing.
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Number of handlers for a given event (useful for debugging).
   */
  listenerCount(event: keyof EventMap): number {
    return this.handlers.get(event as string)?.size ?? 0;
  }
}
