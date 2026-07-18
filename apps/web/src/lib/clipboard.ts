export type CopyResult = { ok: true } | { ok: false; error: "unsupported" | "rejected" };

/**
 * Copy text to the system clipboard with a non-secure-context fallback.
 *
 * In a secure context (HTTPS or localhost) the native Clipboard API is used.
 * In a non-secure context `navigator.clipboard` is undefined, so we fall back
 * to the deprecated but still-working `document.execCommand("copy")` via a
 * temporary textarea. The result indicates success so callers can show honest
 * feedback instead of faking a "copied" state.
 */
export async function copyText(text: string): Promise<CopyResult> {
  if (typeof window === "undefined") {
    return { ok: false, error: "unsupported" };
  }

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      return { ok: false, error: "rejected" };
    }
  }

  return legacyCopy(text);
}

function legacyCopy(text: string): CopyResult {
  const activeEl = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);

  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  document.body.removeChild(textarea);
  activeEl?.focus();

  return ok ? { ok: true } : { ok: false, error: "unsupported" };
}
