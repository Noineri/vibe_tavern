/**
 * ExperienceDetachedWindow — the same-origin trusted wrapper for the "Open in
 * separate window" surface (IR-62).
 *
 * A detached window is NOT the user visual running as the top-level document —
 * that would demolish the isolation boundary. Instead `window.open` loads the
 * SAME Vibe Tavern bundle at a same-origin hash URL (`#experience=<sessionId>`),
 * the app shell (main.tsx Root) detects that hash and renders
 * {@link ExperienceDetachedHost}, a TRUSTED wrapper that embeds the SAME
 * sandboxed {@link ExperienceFrame} the modal uses. The user visual is still
 * inside `sandbox="allow-scripts"` with no `allow-same-origin`; only the trusted
 * chrome around it is now a real OS window instead of a modal.
 *
 * Descriptor handoff (IR-62; replaced by the persisted client store in IR-71):
 * the opener already holds the session props (visual source, revision, …) when
 * the user clicks Detach, so it stashes them on a window property and the popup
 * reads them back via `window.opener` (same-origin → accessible). IR-71 will
 * replace this with a store fetch keyed by sessionId, so the popup survives an
 * opener close. The handoff is confined to these two functions so the swap is
 * local.
 *
 * Popup-blocked fallback: `window.open` returns `null` when the browser blocks
 * the popup (common with strict blockers or a non-user-gesture trigger). The
 * caller MUST handle `null` — typically by keeping the modal open and showing a
 * notice. `openExperienceDetachedWindow` does not pretend success.
 */
import { Icons } from "../shared/icons.js";
import { useT } from "../../i18n/context.js";
import { useEffect, useRef, useState } from "react";
import {
  ExperienceFrame,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import type { BridgeResize } from "../../lib/experience-bridge.js";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";

/** The global property the opener stashes the descriptor on (same-origin only). */
const DESCRIPTOR_KEY = "__experienceDetachDescriptor";

/** Window features for the detached popup (compact phone-like panel). */
export const DETACHED_WINDOW_FEATURES =
  "width=420,height=640,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes";

/**
 * The detach-aware window surface the bridge functions need. Injected for tests
 * (happy-dom's window.location/opener are readonly and cannot be reassigned);
 * production callers omit it and the default `globalThis` is used.
 */
export interface DetachWindow {
  open(url?: string, target?: string, features?: string): Window | null;
  readonly location: { pathname: string; search: string; hash: string };
  readonly opener: { readonly [DESCRIPTOR_KEY]?: DetachedExperienceDescriptor } | null;
  [DESCRIPTOR_KEY]?: DetachedExperienceDescriptor;
}

function defaultWindow(): DetachWindow {
  return globalThis as unknown as DetachWindow;
}

/**
 * The session props the detached host needs to mount the frame. Deliberately a
 * flat subset of ExperienceFrame props — the detached host does not need the
 * modal-only chrome fields.
 */
export interface DetachedExperienceDescriptor {
  readonly sessionId: string;
  readonly title: string;
  readonly visualSource: string;
  readonly initialRevision: number;
  readonly initialView?: Parameters<ExperienceFrameHandle["sendState"]>[0];
}

/**
 * Open the detached window. Stashes `descriptor` for the popup to read and
 * navigates the popup to the same-origin hash URL. Returns the popup handle, or
 * `null` if the browser blocked the popup — the caller must handle `null`.
 */
export function openExperienceDetachedWindow(
  descriptor: DetachedExperienceDescriptor,
  win: DetachWindow = defaultWindow(),
): Window | null {
  // Stash on the OPENER so the popup (a fresh bundle instance with its own
  // module state) can read it via window.opener (same-origin).
  win[DESCRIPTOR_KEY] = descriptor;
  const url = `${win.location.pathname}${win.location.search}#experience=${encodeURIComponent(descriptor.sessionId)}`;
  return win.open(url, `xp-detach-${descriptor.sessionId}`, DETACHED_WINDOW_FEATURES);
}

/**
 * Read the descriptor the opener stashed. Called from inside the detached
 * window's bundle. Returns null if there is no opener (opened directly/not via
 * Detach) or no descriptor — the shell fork falls back to the normal app.
 */
export function readDetachedDescriptor(win: DetachWindow = defaultWindow()): DetachedExperienceDescriptor | null {
  const desc = win.opener?.[DESCRIPTOR_KEY];
  if (desc && typeof desc.sessionId === "string" && typeof desc.visualSource === "string") {
    return desc;
  }
  return null;
}

/** True when the current window is a detached-experience popup (hash present). */
export function isDetachedExperienceWindow(win: Pick<DetachWindow, "location"> = defaultWindow()): boolean {
  return win.location.hash.startsWith("#experience=");
}

export interface ExperienceDetachedHostProps {
  /**
   * Optional callbacks forwarded to the embedded frame. IR-62 defaults them to
   * no-ops because the client store (IR-71) does not exist yet; IR-71 wires
   * these to real server-authoritative session actions.
   */
  readonly onAction?: (action: ExperienceActionDto) => void;
  readonly onResize?: (size: BridgeResize) => void;
  readonly onError?: (reason: string) => void;
  /** Override the descriptor source (tests); defaults to readDetachedDescriptor(). */
  readonly descriptor?: DetachedExperienceDescriptor;
}

/**
 * The trusted wrapper rendered inside the detached window. Reads its descriptor
 * from the opener, renders a close-self chrome + the SAME sandboxed
 * {@link ExperienceFrame}. Never executes user HTML as the top-level document.
 */
export function ExperienceDetachedHost(props: ExperienceDetachedHostProps) {
  const { t } = useT();
  const [descriptor, setDescriptor] = useState<DetachedExperienceDescriptor | null>(
    () => props.descriptor ?? readDetachedDescriptor(),
  );
  const frameRef = useRef<ExperienceFrameHandle>(null);

  useEffect(() => {
    // Re-read on mount in case the opener stashed the descriptor after the
    // bundle initialized (the popup may parse its JS before the opener writes).
    if (!props.descriptor && !descriptor) {
      const d = readDetachedDescriptor();
      if (d) setDescriptor(d);
    }
  }, [props.descriptor, descriptor]);

  if (!descriptor) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-neutral-400">
        <p className="text-sm">{t("experience_detach_unavailable")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">
          {descriptor.title}
        </h1>
        <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
          {t("experience_detached_badge")}
        </span>
        <button
          type="button"
          className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={() => window.close()}
          aria-label={t("experience_close")}
          data-testid="experience-detached-close"
        >
          <Icons.Close className="h-4 w-4" />
        </button>
      </header>
      <div className="flex-1 overflow-auto">
        <ExperienceFrame
          ref={frameRef}
          visualSource={descriptor.visualSource}
          sessionId={descriptor.sessionId}
          initialRevision={descriptor.initialRevision}
          initialView={descriptor.initialView}
          onAction={(a) => props.onAction?.(a)}
          onResize={(s) => props.onResize?.(s)}
          onError={(r) => props.onError?.(r)}
        />
      </div>
    </div>
  );
}
