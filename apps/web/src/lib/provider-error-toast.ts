/**
 * The RP chat controller's provider-error toast (extracted from
 * hooks/use-chat-controller.ts — the file-size ratchet). The experience
 * copilot controller keeps its own minimal replica (no provider-settings
 * action); see use-experience-copilot-controller.ts.
 */
import { toast } from "sonner";
import type { TFunc } from "../i18n/locale-helpers.js";
import type Resources from "../i18n/resources.js";
import { isUserMessageSavedError, ProviderStreamError } from "../api/provider-stream-error.js";
import { useModalStore } from "../stores/modal-store.js";

// Categories where the failure is likely transient (retry after a short wait) —
// the message alone is enough; we just add a "try again" hint.
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["rate_limit", "timeout", "network", "server_error"]);

/**
 * Shows a category-aware toast for a provider/LLM generation failure. Reads the
 * server-classified `category` from a {@link ProviderStreamError} and picks a
 * description + (for auth) an action that opens provider settings — so the user
 * gets actionable feedback instead of raw HTTP text. Mirrors the existing
 * VISION_NOT_SUPPORTED toast shape. Falls back to the raw message for
 * `unknown` (and for non-ProviderStreamError errors, e.g. network failures
 * before the request reached the server).
 */
export function showProviderErrorToast(error: unknown, t: TFunc, fallbackKey: keyof Resources["en"] = "message_send_failed"): void {
  const message = error instanceof Error && error.message ? error.message : t(fallbackKey);
  const category = error instanceof ProviderStreamError ? error.category : "unknown";

  // The provider cut the reply mid-stream and the server kept what arrived —
  // that is the news, whatever the category.
  if (isPartialSavedError(error)) {
    toast.error(message, { description: t("provider_error_partial_saved_desc") });
    return;
  }

  if (category === "authentication") {
    toast.error(message, {
      description: t("provider_error_auth_desc"),
      action: {
        label: t("open_provider_settings"),
        onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
      },
    });
    return;
  }
  if (category === "subscription_required") {
    toast.error(message, {
      description: t("provider_error_subscription_desc"),
      action: {
        label: t("open_provider_settings"),
        onClick: () => useModalStore.getState().setIsProviderModalOpen(true),
      },
    });
    return;
  }
  if (TRANSIENT_PROVIDER_CATEGORIES.has(category)) {
    toast.error(message, { description: t("provider_error_transient_desc") });
    return;
  }
  if (category === "empty_response" || category === "parse_error") {
    toast.error(message, { description: t("provider_error_empty_desc") });
    return;
  }
  toast.error(message);
}

/** The server kept the reply text streamed before a provider cut (the SSE
 *  error event's `partialSaved`). */
export function isPartialSavedError(error: unknown): boolean {
  return error instanceof ProviderStreamError && error.partialSaved;
}

/** The failed turn is (partly) stored server-side — the user message
 *  (`user-message-saved` preceded the error) and/or a partial reply — so the
 *  client reloads the chat instead of restoring the draft. */
export function isTurnKeptOnServer(error: unknown): boolean {
  return isPartialSavedError(error) || isUserMessageSavedError(error);
}
