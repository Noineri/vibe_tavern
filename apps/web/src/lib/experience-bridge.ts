/**
 * Visual host bridge — host-side runtime (IR-61).
 *
 * Owns the trusted end of the MessageChannel between the Vibe Tavern host and
 * the isolated visual frame. The frame side is the plain-JS `VibeExperience`
 * SDK (`experience-sdk.ts`); this class is the typed, validating host peer.
 *
 * Responsibilities (the things the SDK deliberately does NOT do):
 *   - handshake identity: generate the per-session nonce, send `hello`, reject
 *     any inbound message whose nonce is stale/wrong (a foreign or previous
 *     session's frame still posting);
 *   - revision authority: track the last authoritative revision the host sent
 *     (`sendState`) and fast-reject a stale-revision action without a service
 *     round-trip (the service still does the authoritative CAS — this is a
 *     client-side pre-check for snappier feedback);
 *   - duplicate-click lock: while one action is in flight, drop a second action
 *     until `sendResult`/`sendError` clears it (prevents a double-fire from a
 *     fast double-click; the visual also gates its own controls on `pending`);
 *   - strict parse of inbound messages via `parseVisualToHost` (malformed →
 *     dropped + `onProtocolError`, never throws into the host React tree);
 *   - typed send builders for state/result/error/pending/lifecycle.
 *
 * Testing seams: `handleMessage(raw)` is the pure protocol brain (driven
 * directly by unit tests with no ports). `bindHostPort(port)` is the low-level
 * port wiring that `attach()` builds on (and that a detached-window reconnect
 * in IR-62 will reuse). The integration test wires a real `MessageChannel`
 * between this bridge and the eval'd SDK to prove byte-for-byte parity.
 */
import type { ExperienceActionDto } from "@vibe-tavern/api-contracts";
import type { ExperienceSessionStatus } from "@vibe-tavern/domain";
import {
  BRIDGE_PROTOCOL_VERSION,
  buildError,
  buildHello,
  buildLifecycle,
  buildPending,
  buildResult,
  buildState,
  generateSessionNonce,
  parseVisualToHost,
  type BridgeErrorCode,
  type HostToVisual,
} from "./experience-bridge-schema.js";

/** A minimal MessagePort surface (the Web `MessagePort` satisfies this). */
export interface BridgePort {
  postMessage(message: unknown, transferOrTarget?: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onmessageerror: ((ev: unknown) => void) | null;
  start?(): void;
  close?(): void;
}

/** A minimal content-window surface for transferring the frame port. */
export interface BridgeContentWindow {
  postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void;
}

/** A measured content size reported by the frame. */
export interface BridgeResize {
  readonly width: number;
  readonly height: number;
}

export interface ExperienceHostBridgeOptions {
  readonly sessionId: string;
  readonly initialRevision: number;
  /** Fired once when the frame's `ready` arrives (handshake complete). */
  readonly onReady?: () => void;
  /** Fired for a validated, non-stale, non-duplicate action intention. */
  readonly onAction: (action: ExperienceActionDto) => void;
  readonly onResize?: (size: BridgeResize) => void;
  /** Fired when the frame requests the privileged finish op. */
  readonly onFinish?: (revision: number) => void;
  /** Fired for dropped/malformed messages (observability; never throws). */
  readonly onProtocolError?: (reason: string, raw?: unknown) => void;
}

type LifecycleEvent = "suspend" | "resume" | "finish" | "reset";
type PendingPhase = "idle" | "typing" | "effect";

export class ExperienceHostBridge {
  private readonly sessionId: string;
  private readonly nonce: string;
  private readonly opts: ExperienceHostBridgeOptions;
  private hostPort: BridgePort | null = null;
  private currentRevision: number;
  private inflightRequestId: string | null = null;
  private handshakeComplete = false;

  constructor(opts: ExperienceHostBridgeOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.nonce = generateSessionNonce();
    this.currentRevision = opts.initialRevision;
  }

  // ─── Public read state ───────────────────────────────────────────────────

  /** The session nonce (frame must echo it; used for handshake identity). */
  get sessionNonce(): string {
    return this.nonce;
  }

  /** True after the frame's `ready` arrived. */
  get isReady(): boolean {
    return this.handshakeComplete;
  }

  /** The last authoritative revision sent to the frame. */
  get revision(): number {
    return this.currentRevision;
  }

  // ─── Port lifecycle ──────────────────────────────────────────────────────

  /**
   * Low-level port wiring: listen for inbound messages on `port`. Used by
   * `attach()` (normal frame mount) and reusable by a detached-window reconnect
   * (IR-62) that rebinds an existing session to a fresh port pair. Does NOT
   * transfer anything to a frame — call `attach()` for the full mount.
   */
  bindHostPort(port: BridgePort): void {
    this.hostPort = port;
    port.onmessage = (ev) => this.handleMessage(ev.data);
    port.onmessageerror = () => this.opts.onProtocolError?.("port_message_error");
    port.start?.();
  }

  /**
   * Full frame mount: create a MessageChannel, bind the host port, and transfer
   * the frame port to `contentWindow` (target `"*"` because the frame is an
   * opaque origin). Immediately follow with `hello` so the frame binds its nonce
   * the instant it receives the port. Safe to call once per mount; call
   * `dispose()` between mounts.
   */
  attach(contentWindow: BridgeContentWindow): void {
    const channel = new MessageChannel();
    this.bindHostPort(channel.port1 as unknown as BridgePort);
    contentWindow.postMessage({ kind: "port", port: channel.port2 }, "*", [channel.port2]);
    // hello travels on the host port → arrives at the frame's port after the
    // frame has registered its onmessage (the SDK binds synchronously on the
    // `port` window-message; queuing hello right after transfer is safe because
    // MessagePort buffers messages until onmessage is set).
    this.sendHello();
  }

  dispose(): void {
    this.hostPort?.close?.();
    this.hostPort = null;
    this.inflightRequestId = null;
    this.handshakeComplete = false;
  }

  // ─── Inbound (the protocol brain) ─────────────────────────────────────────

  /**
   * Handle one raw inbound message. Validates, checks nonce + revision + lock,
   * and dispatches to the typed callbacks. Never throws: a malformed message is
   * dropped with `onProtocolError`. This is the unit-test seam — drive it
   * directly to exercise handshake/rejection/lock logic without ports.
   */
  handleMessage(raw: unknown): void {
    const msg = parseVisualToHost(raw);
    if (msg === null) {
      this.opts.onProtocolError?.("malformed_message", raw);
      return;
    }
    // Every inbound message must carry the active nonce. A stale frame (previous
    // session, still alive) posts with an old nonce and is dropped here.
    if (msg.nonce !== this.nonce) {
      this.opts.onProtocolError?.("stale_nonce", msg);
      return;
    }

    switch (msg.kind) {
      case "ready": {
        if (!this.handshakeComplete) {
          this.handshakeComplete = true;
          this.opts.onReady?.();
        }
        return;
      }
      case "action": {
        this.handleAction(msg.action);
        return;
      }
      case "resize": {
        this.opts.onResize?.({ width: msg.width, height: msg.height });
        return;
      }
      case "finish": {
        this.opts.onFinish?.(msg.revision);
        return;
      }
      default: {
        // exhaustiveness guard — parseVisualToHost narrows to the union, so this
        // is unreachable unless the schema grows a kind without a case here.
        this.opts.onProtocolError?.("unhandled_kind", msg);
      }
    }
  }

  private handleAction(action: ExperienceActionDto): void {
    // Duplicate-click lock: one action in flight at a time. A second action
    // while the first is unresolved is dropped (the visual also disables its
    // controls on `pending`); the lock clears on sendResult/sendError.
    if (this.inflightRequestId !== null) {
      if (action.requestId === this.inflightRequestId) {
        this.opts.onProtocolError?.("duplicate_request", action.requestId);
      } else {
        this.opts.onProtocolError?.("busy", action.requestId);
      }
      return;
    }
    // Client-side stale-revision pre-check. currentRevision is the revision of
    // the last state we sent; an action built on an older view is stale. The
    // service still does the authoritative CAS — this is a fast local reject.
    if (action.expectedRevision !== this.currentRevision) {
      this.sendError("stale_revision", "Action was built on an outdated state.", {
        requestId: action.requestId,
        revision: this.currentRevision,
      });
      return;
    }
    this.inflightRequestId = action.requestId;
    this.opts.onAction(action);
  }

  // ─── Outbound (typed builders) ────────────────────────────────────────────

  /** Send the handshake. Idempotent if called before the port is bound. */
  sendHello(): void {
    this.post(buildHello({ nonce: this.nonce }, this.sessionId, this.currentRevision));
  }

  /**
   * Push an authoritative projection. Updates `currentRevision` from the view
   * (the source of truth for the stale-revision pre-check).
   */
  sendState(
    view: Parameters<typeof buildState>[1],
    viewer?: unknown,
  ): void {
    this.currentRevision = view.revision;
    this.post(buildState({ nonce: this.nonce }, view, viewer));
  }

  /**
   * Acknowledge a committed action. Clears the duplicate-click lock so the next
   * action can proceed. `revision` is the post-action authoritative revision.
   */
  sendResult(requestId: string, revision: number, status: ExperienceSessionStatus): void {
    this.currentRevision = revision;
    this.clearLockFor(requestId);
    this.post(buildResult({ nonce: this.nonce }, requestId, revision, status));
  }

  /**
   * Send a structured error. If it carries a `requestId` that matches the
   * in-flight action, the lock is cleared (the action is rejected, not retried
   * by the bridge — the visual decides whether to retry).
   */
  sendError(
    code: BridgeErrorCode,
    message: string,
    detail?: { requestId?: string; revision?: number },
  ): void {
    if (detail?.requestId) this.clearLockFor(detail.requestId);
    if (typeof detail?.revision === "number") this.currentRevision = detail.revision;
    this.post(buildError({ nonce: this.nonce }, code, message, detail));
  }

  sendPending(phase: PendingPhase): void {
    this.post(buildPending({ nonce: this.nonce }, phase));
  }

  sendLifecycle(event: LifecycleEvent): void {
    this.post(buildLifecycle({ nonce: this.nonce }, event));
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private clearLockFor(requestId: string): void {
    if (this.inflightRequestId === requestId) {
      this.inflightRequestId = null;
    }
  }

  private post(message: HostToVisual): void {
    if (!this.hostPort) {
      this.opts.onProtocolError?.("no_port", message.kind);
      return;
    }
    this.hostPort.postMessage(message);
  }

  /** Stable protocol-version accessor (used by tests + the frame bootstrap). */
  static readonly PROTOCOL_VERSION = BRIDGE_PROTOCOL_VERSION;
}
