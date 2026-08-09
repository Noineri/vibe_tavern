/**
 * ExperienceFrame — the isolated visual host surface (IR-61).
 *
 * Renders the editable visual source inside a sandboxed iframe and wires it to
 * an {@link ExperienceHostBridge}. The frame is the ONLY place untrusted
 * (user/model-authored) visual code executes; it runs under
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so its origin is the
 * opaque `"null"` origin and it cannot reach the Vibe Tavern DOM, cookies,
 * storage, or network (the injected CSP `connect-src 'none'` closes the network
 * hole even if a future browser relaxed the sandbox default).
 *
 * The host injects exactly two things into the frame document:
 *   1. a restrictive CSP `<meta>` (no network, inline scripts/styles only,
 *      images via data:/blob: only);
 *   2. the immutable `VibeExperience` SDK (`experience-sdk.ts`).
 * The rest is the caller-supplied `visualSource` (the editable HTML/CSS/JS). The
 * SDK is host-provided and version-pinned; the visual source is user-owned and
 * never silently rewritten by Vibe Tavern (design: "Only the versioned SDK
 * remains host-provided").
 *
 * URL lifecycle: the document is served from a `blob:` URL so a restrictive CSP
 * applies and the URL can be revoked on source/session change (no lingering
 * reference keeps the old frame's document alive). `srcdoc` would also work for
 * isolation but cannot be revoked and has weaker CSP meta handling in some
 * browsers; blob is the documented choice.
 *
 * Imperative API: the parent (modal/detached wrapper) pushes authoritative
 * projections and acks through the ref handle (`sendState`/`sendResult`/…). The
 * frame→host direction arrives as callbacks (`onAction`, `onReady`, …).
 *
 * Testing split (see ExperienceFrame.test.tsx): the DOM/sandbox/CSP/URL-lifecycle
 * behavior is asserted here (happy-dom can render the iframe + inspect the blob
 * document); the live handshake + act round-trip is covered by the bridge
 * integration test (real MessagePort, no DOM) and the SDK eval test.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import type { ExperienceSessionStatus } from "@vibe-tavern/domain";
import { cn } from "../../lib/cn.js";
import {
  ExperienceHostBridge,
  type BridgeContentWindow,
  type BridgeResize,
} from "../../lib/experience-bridge.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "../../lib/experience-sdk.js";
import type { BridgeErrorCode } from "../../lib/experience-bridge-schema.js";

/** The restrictive CSP applied inside the frame document. */
export const EXPERIENCE_FRAME_CSP = [
  "default-src 'none'",
  // The SDK + visual source are inline <script> blocks.
  "script-src 'unsafe-inline'",
  // Visual CSS is inline.
  "style-src 'unsafe-inline'",
  // Local assets only (data: URIs / object URLs), never remote.
  "img-src data: blob:",
  // Fonts likewise local only.
  "font-src data:",
  // Explicitly close the network (form/fetch/websocket/frame/prefetch).
  "connect-src 'none'",
  "frame-src 'none'",
  "media-src 'none'",
].join("; ");

/**
 * Assemble the frame document: CSP meta → SDK → visual source. Pure (no React,
 * no DOM) so it is unit-testable for CSP/SDK/source presence without rendering.
 * The visual source is wrapped so an author who forgets a wrapping `<script>`
 * still gets their code parsed as HTML (a stray `<` won't break the SDK); the
 * SDK always precedes the source so `VibeExperience` exists when the source runs.
 */
export function buildExperienceFrameDocument(visualSource: string): string {
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPERIENCE_FRAME_CSP}">`,
    "<style>",
    "html,body{margin:0;padding:0;background:transparent;color:inherit;font:inherit;}",
    "</style>",
    "</head>",
    "<body>",
    "<script>",
    VIBE_EXPERIENCE_SDK_SOURCE,
    "</script>",
    "<!-- === user/model visual source (editable, user-owned) === -->",
    visualSource,
    "</body>",
    "</html>",
  ].join("\n");
}

export interface ExperienceFrameProps {
  /** Editable visual source (HTML/CSS/JS). User-owned; never host-rewritten. */
  readonly visualSource: string;
  /** The active experience session id (frame shows it for telemetry only). */
  readonly sessionId: string;
  /** Authoritative revision at mount (sent in the `hello` handshake). */
  readonly initialRevision: number;
  /**
   * Optional projection pushed on `ready`. Subsequent projections come through
   * the imperative `sendState`. If omitted, the parent should sendState onReady.
   */
  readonly initialView?: Parameters<ExperienceHostBridge["sendState"]>[0];
  /** Fired once the frame completes the handshake (`ready`). */
  readonly onReady?: () => void;
  /** Fired for a validated, non-stale, non-duplicate action intention. */
  readonly onAction: (action: ExperienceActionDto) => void;
  /** Fired when the frame reports its content size (also auto-resizes). */
  readonly onResize?: (size: BridgeResize) => void;
  readonly onFinish?: (revision: number) => void;
  /** Fired for dropped/malformed bridge messages (observability). */
  readonly onError?: (reason: string) => void;
  readonly className?: string;
}

/** Imperative host→frame push surface (parent modal/detached wrapper uses it). */
export interface ExperienceFrameHandle {
  sendState: ExperienceHostBridge["sendState"];
  sendResult: ExperienceHostBridge["sendResult"];
  sendError: ExperienceHostBridge["sendError"];
  sendPending: ExperienceHostBridge["sendPending"];
  sendLifecycle: ExperienceHostBridge["sendLifecycle"];
  /** True after the frame completed the handshake. */
  readonly isReady: boolean;
  /** The active session nonce (for cross-surface identity in IR-62). */
  readonly sessionNonce: string;
}

export const ExperienceFrame = forwardRef<ExperienceFrameHandle, ExperienceFrameProps>(
  function ExperienceFrame(props, ref) {
    const {
      visualSource,
      sessionId,
      initialRevision,
      initialView,
      onReady,
      onAction,
      onResize,
      onFinish,
      onError,
      className,
    } = props;

    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const bridgeRef = useRef<ExperienceHostBridge | null>(null);
    const [frameHeight, setFrameHeight] = useState<number | null>(null);

    // Build the frame document + blob URL from the visual source. Revoked on
    // unmount OR when the source changes (a new doc means a new URL). The SDK
    // version is pinned in the bundle, so it is not a dependency.
    const [docUrl, setDocUrl] = useState<string | null>(null);
    useEffect(() => {
      const doc = buildExperienceFrameDocument(visualSource);
      const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
      setDocUrl(url);
      return () => {
        URL.revokeObjectURL(url);
        setDocUrl(null);
      };
    }, [visualSource]);

    // (Re)create the bridge for this session. The bridge lifetime is
    // SESSION-SCOPED: only a genuine `sessionId` change creates a fresh
    // handshake. `initialRevision` is read ONCE at mount (the hello revision);
    // later authoritative revisions for the SAME session arrive through the
    // imperative `sendState` (the parent pushes the new view), NOT by
    // reconstructing the bridge. Recreating the bridge on every revision would
    // also strand the old bridge — the iframe load does not re-fire to attach a
    // new bridge, so the new bridge would never handshake (IR-73B seam #4).
    // The actual port transfer happens on iframe load (contentWindow must
    // exist first).
    useEffect(() => {
      const bridge = new ExperienceHostBridge({
        sessionId,
        initialRevision,
        onReady: () => {
          // Push the initial projection the instant the frame is listening, so
          // the first render is not a blank frame.
          if (initialView) bridge.sendState(initialView);
          onReady?.();
        },
        onAction,
        onResize: (size) => {
          // Auto-size the iframe to the frame's content height so there is no
          // inner scrollbar (the visual owns its own layout). Forward as well.
          setFrameHeight(size.height);
          onResize?.(size);
        },
        onFinish,
        onProtocolError: (reason) => onError?.(reason),
      });
      bridgeRef.current = bridge;
      return () => {
        bridge.dispose();
        bridgeRef.current = null;
      };
      // initialRevision/initialView are intentionally not dependencies:
      // initialRevision is the mount-time hello value; a later authoritative
      // revision for the SAME session arrives via sendState (not by recreating
      // the bridge). onAction/onReady/etc. are callbacks read through the
      // bridge closure at creation; callers provide stable wrappers that
      // delegate through refs (IR-73B) so changing props do not strand the
      // bridge.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    const handleLoad = useCallback(() => {
      const win = iframeRef.current?.contentWindow as BridgeContentWindow | null;
      const bridge = bridgeRef.current;
      if (!win || !bridge) return;
      // attach creates the MessageChannel, transfers port2 to the frame, and
      // sends `hello`. The SDK binds its nonce from hello and replies `ready`.
      bridge.attach(win);
    }, []);

    useImperativeHandle(
      ref,
      (): ExperienceFrameHandle => ({
        sendState: (view, viewer) => bridgeRef.current?.sendState(view, viewer),
        sendResult: (rid, rev, status) =>
          bridgeRef.current?.sendResult(rid, rev, status),
        sendError: (code, msg, detail) =>
          bridgeRef.current?.sendError(code, msg, detail),
        sendPending: (phase) => bridgeRef.current?.sendPending(phase),
        sendLifecycle: (event) => bridgeRef.current?.sendLifecycle(event),
        get isReady() {
          return bridgeRef.current?.isReady ?? false;
        },
        get sessionNonce() {
          return bridgeRef.current?.sessionNonce ?? "";
        },
      }),
      [],
    );

    return (
      <iframe
        // allow-scripts runs the visual; the deliberate OMISSION of
        // allow-same-origin forces the opaque origin that blocks host-DOM
        // access. allow-top-navigation is NOT granted (no host redirect).
        sandbox="allow-scripts"
        ref={iframeRef}
        title="Interactive experience"
        src={docUrl ?? undefined}
        onLoad={handleLoad}
        className={cn(
          "w-full border-0 bg-transparent",
          frameHeight !== null ? "" : "min-h-[120px]",
          className,
        )}
        style={frameHeight !== null ? { height: `${frameHeight}px` } : undefined}
      />
    );
  },
);
