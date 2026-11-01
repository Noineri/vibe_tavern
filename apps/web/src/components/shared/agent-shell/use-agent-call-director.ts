import { useEffect } from "react";
import type { TFunc } from "../../../i18n/context.js";
import { useSidechatCallDirectorStore } from "../../../stores/sidechat-call-director-store.js";

/**
 * DR-12 (DIRECTOR_MODE_PLAN): the shell's pending-call consumption — the
 * SEND half of the `callDirector` bridge (the DR-7 `inputPrefill` bridge's
 * shape reference, but this one sends). When the shared call store owes
 * THIS owner a director call (`callDirector` queued it after opening the
 * panel), the shell sends the message exactly once, as soon as its
 * controller is ready: a live `threadId` (the shell's bootstrap loadSession
 * has resolved — creating the session when none was active) and no turn
 * streaming.
 *
 * Exactly-once is the store's `consume` (remove-first): the effect may fire
 * twice for one entry (StrictMode double-invoke, a rerender race), but only
 * the call that TOOK the entry sends — a double click sends ONE message.
 *
 * Generic on purpose: hosts whose kind never queues (everything but the
 * sidechat) read no pending entry and no-op — their shells are
 * byte-identical.
 */
export function useAgentCallDirector({
	ownerKey,
	threadId,
	sessionLoading,
	isSending,
	send,
	t,
}: {
	/** The shell owner's logical-identity key — the queue is keyed by the
	 *  same `agentOwnerKey` spelling. */
	ownerKey: string;
	/** The active thread id; null while the session bootstrap is still
	 *  resolving (no controller target yet). */
	threadId: string | null;
	/** The shell's session bootstrap flag — a queued call waits it out. */
	sessionLoading: boolean;
	/** The controller's live streaming flag — a queued call waits for the
	 *  in-flight turn to settle. */
	isSending: boolean;
	/** The shell's send dispatch (its `sendWithOptions`-wrapped controller
	 *  send — the host bridge's onBeforeSend + buildSendOptions ride along
	 *  exactly like a composer send). */
	send: (content: string) => void;
	t: TFunc;
}): void {
	const pending = useSidechatCallDirectorStore((s) => Boolean(s.pending[ownerKey]));
	useEffect(() => {
		if (!pending || threadId === null || sessionLoading || isSending) return;
		// Remove-first: only the taker sends (see the module doc).
		if (!useSidechatCallDirectorStore.getState().consume(ownerKey)) return;
		send(t("story_plan_call_director_message"));
	}, [pending, threadId, sessionLoading, isSending, ownerKey, send, t]);
}
