import { useEffect } from "react";
import { toast } from "sonner";
import {
  PROVIDER_QUOTA_EVENT_NAME,
  type ProviderQuotaLowRemainingEvent,
  type ProviderQuotaWindowResetEvent,
} from "@vibe-tavern/domain";
import { useT } from "../i18n/context.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { useQuotaStore } from "../stores/quota-store.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";

// ────────────────────────────────────────────────────────────────────────────
// useQuotaEvents — the global quota SSE subscription
// ────────────────────────────────────────────────────────────────────────────
// Quota is an account-level fact, not a conversation's, so this channel is
// global (`GET /api/quota/events`) and mounted ONCE at the app-shell level —
// unlike the per-chat channel next to it, it does not re-open on chat change.
//
// Two responsibilities, in this order: fold the event into the quota store
// (so an open panel updates), then toast. Dedupe lives in the store, so a
// replay after an EventSource reconnect updates nothing and toasts nothing.
//
// EventSource reconnects on transient errors by itself; that is reflected in
// `streamState` for a future indicator but never surfaced as a toast — a flaky
// connection is not worth interrupting the user for.
// ────────────────────────────────────────────────────────────────────────────

function parseEvent<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

/** Provider name for the toast, falling back to the id when the profile is unknown. */
function providerLabel(providerProfileId: string): string {
  const profile = useProviderDataStore.getState().profiles.find((entry) => entry.id === providerProfileId);
  return profile?.name ?? providerProfileId;
}

export function useQuotaEvents(): void {
  const { t } = useT();

  useEffect(() => {
    const { ingestQuotaEvent, setStreamState } = useQuotaStore.getState();
    const eventSource = new EventSource(appendTokenQuery("/api/quota/events"));
    setStreamState("connecting");

    const onOpen = () => setStreamState("open");
    const onError = () => setStreamState("error");
    const onReady = () => setStreamState("open");

    const onLowRemaining = (message: MessageEvent) => {
      const event = parseEvent<ProviderQuotaLowRemainingEvent>(message);
      if (!event?.eventId) return;
      if (!ingestQuotaEvent(event)) return;
      toast.warning(t("quota_low_remaining_toast", {
        provider: providerLabel(event.providerProfileId),
        window: event.windowLabel,
        remaining: Math.round(event.remainingPercent),
      }));
    };

    const onWindowReset = (message: MessageEvent) => {
      const event = parseEvent<ProviderQuotaWindowResetEvent>(message);
      if (!event?.eventId) return;
      if (!ingestQuotaEvent(event)) return;
      toast.success(t("quota_window_reset_toast", {
        provider: providerLabel(event.providerProfileId),
        window: event.windowLabel,
      }));
    };

    eventSource.addEventListener("open", onOpen);
    eventSource.addEventListener("error", onError);
    eventSource.addEventListener("ready", onReady as EventListener);
    eventSource.addEventListener(PROVIDER_QUOTA_EVENT_NAME.lowRemaining, onLowRemaining as EventListener);
    eventSource.addEventListener(PROVIDER_QUOTA_EVENT_NAME.windowReset, onWindowReset as EventListener);

    return () => {
      eventSource.close();
      useQuotaStore.getState().setStreamState("closed");
    };
  }, [t]);
}
