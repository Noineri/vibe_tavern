/**
 * THE one member-for-member `EventSource` test double (step 8 batch 8b —
 * TYPE_SAFETY_CAST_DEBT_REPORT).
 *
 * Tests stub `globalThis.EventSource` because happy-dom's EventSource has no
 * useful constructor surface. Every stub used to install through `as unknown
 * as typeof EventSource` — the erasure the type-gate exists to kill. This
 * seam replaces the erasure: the class IS assignable to `typeof EventSource`
 * (member-for-member, the 7e TS7 lib.dom fact), so the global install needs
 * NO cast at any consumer.
 *
 * The lib.dom facts the shape encodes (7e, SummaryTab.background-run):
 *   - `typeof EventSource` carries the CONNECTING/OPEN/CLOSED constants as
 *     statics, so the class provides them at BOTH levels (instance members
 *     for the spec's own-property constants, statics for the constructor
 *     view);
 *   - lib.dom's redeclared EventSource.addEventListener overloads compare
 *     contravariantly against a bare EventListener, so the listener param is
 *     the explicit union `EventListener | ((this, ev: MessageEvent) =>
 *     unknown) | EventListenerObject | null`.
 *
 * One derivation (AGENTS.md §3): SummaryTab.background-run.test.tsx carried
 * the 7e original inline; the three hooks suites (use-agent-run-events,
 * use-chat-events, use-quota-events) each carried a second/third stub of the
 * same boundary, so this file is THE derivation and every consumer imports
 * it. Storage is array buckets (a hook may register several listeners for a
 * kind) and delivery is real `MessageEvent`s — a superset of what any of the
 * four erased stubs delivered (they passed bare `{ data }` objects or single
 * listeners); every consumer's assertions are unchanged.
 *
 * `addEventListener` is a per-instance bun `mock()` so use-chat-events' SPC-7b
 * registration pin (`toHaveBeenCalledWith(kind, expect.any(Function))`)
 * keeps working verbatim; `Mock<T>` preserves the call signature, so the
 * field still satisfies the EventTarget member.
 */
import { mock } from "bun:test";

type SourceListener = (ev: MessageEvent) => unknown;

export class TestEventSource extends EventTarget implements EventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	/** Every constructed source, in order — consumers assert on
	 *  `instances[0]`, url patterns and per-instance `closed`. */
	static instances: TestEventSource[] = [];

	readonly url: string;
	readonly readyState = 0;
	readonly withCredentials = false;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSED = 2;
	onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
	onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
	onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
	/** Registered listeners by event name — array buckets, same reads the
	 *  suites pin (`listeners.has(kind)`, `listeners.get(kind)`). */
	readonly listeners = new Map<string, SourceListener[]>();
	closed = false;
	/** Per-instance bun mock (call tracking for the registration pin); the
	 *  implementation performs the bucket registration. */
	readonly addEventListener = mock(
		(
			type: string,
			listener: EventListener | ((this: EventSource, ev: MessageEvent) => unknown) | EventListenerObject | null,
			_options?: boolean | AddEventListenerOptions,
		): void => {
			if (typeof listener !== "function") return;
			const bucket = this.listeners.get(type) ?? [];
			bucket.push(listener);
			this.listeners.set(type, bucket);
		},
	);

	constructor(url?: string | URL) {
		super();
		this.url = String(url ?? "");
		TestEventSource.instances.push(this);
	}

	removeEventListener(
		type: string,
		listener: EventListener | ((this: EventSource, ev: MessageEvent) => unknown) | EventListenerObject | null,
		_options?: boolean | EventListenerOptions,
	): void {
		const bucket = this.listeners.get(type);
		if (!bucket) return;
		const next = bucket.filter((item) => item !== listener);
		if (next.length === 0) this.listeners.delete(type);
		else this.listeners.set(type, next);
	}

	close(): void {
		this.closed = true;
	}

	/** Deliver a JSON payload on a named channel (the SSE named-event shape). */
	emit(kind: string, payload: unknown = {}): void {
		this.raw(kind, JSON.stringify(payload));
	}

	/** Deliver a raw string payload on a named channel. */
	raw(kind: string, data: string): void {
		this.deliver(kind, new MessageEvent(kind, { data }));
	}

	/** Deliver a data-less lifecycle event ("open" / "error"). */
	fire(kind: string): void {
		this.deliver(kind, new MessageEvent(kind));
	}

	private deliver(kind: string, event: MessageEvent): void {
		for (const listener of this.listeners.get(kind) ?? []) listener(event);
	}
}
