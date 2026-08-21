/**
 * The host-provided `VibeExperience` SDK source (IR-61).
 *
 * This is NOT a normal TypeScript module. It is the source string injected
 * verbatim into the sandboxed visual iframe, where it runs as plain browser JS
 * with no module system and an opaque origin (`sandbox="allow-scripts"` without
 * `allow-same-origin`). It is the ONLY host-provided code the frame executes;
 * everything else is the editable user/model visual source.
 *
 * Kept as an exported string (not a sibling `.js` asset) so:
 *   - it is unit-testable: the test harness `eval`s it against a fake
 *     `window`+`message` harness and asserts the handshake/act/resize behavior;
 *   - the bundler cannot accidentally tree-shake or rewrite it (it must be the
 *     exact bytes the frame sees, byte-for-byte parity with what we test);
 *   - it ships inside the app bundle (no extra fetch/handle for the frame).
 *
 * API surface (the contract visual starters depend on — see IR-63):
 *   VibeExperience.connect(onView, opts?) -> experience
 *     onView(view, meta) is called on every authoritative projection (state).
 *     opts.onPending?(phase), opts.onError?(err), opts.onLifecycle?(event),
 *     opts.onReady?(sessionMeta) are optional lifecycle hooks.
 *   experience.act(type, payload?, opts?) -> void
 *     Submit an intention. opts.participantId / opts.requestId are optional; the
 *     SDK fills requestId (uuid) and expectedRevision (last seen) when absent.
 *   experience.resize(width, height) -> void — report content size to the host.
 *   experience.finish() -> void — request the privileged finish op.
 *   experience.session -> { sessionId, revision } (after handshake).
 *
 * Realtime surface (RM-5; inert in turn-based frames — no vt-loop:* events
 * ever fire there, and every dispatch guards on the DOM CustomEvent surface):
 *   experience.actLocal(type, payload?, opts?) -> void — frame-local intention
 *     for the loop (no host round-trip; the one-action lock does not apply).
 *   experience.modelRequest(seatId, prompt) -> requestId — ask the host model
 *     seam; the reply returns as a `model_result` round-log event.
 *   experience.finishRound({ status, score?, summary? }) -> void — end the
 *     round from the surface; the loop finalizes and the SDK auto-commits.
 *   experience.onTick(cb) / onLoopEvent(cb) / onRoundFinish(cb) /
 *     onRoundError(cb) — loop subscriptions; early events (the SDK loads
 *     before the loop boots) are buffered: a late connect still sees the
 *     latest view and the bounded round-log tail.
 *
 * Loop diagnostics channel (RM-13; inert in turn-based frames): the SDK
 * samples the latest projection (~1/s) plus bounded tails of loop events,
 * loop errors, and the frame console, and posts them to the host as
 * 'loop_diag' bridge messages. It arms on the FIRST vt-loop:* event (so a
 * dead loop still reports its boot error) and posts a final sample at
 * round finish.
 *
 *   view.flavor may carry a host-normalized chatter view — { status:
 *   "pending"|"resolved"|"failed", seatId, text?, fallback? } — when the
 *   author's flavor method returns an experienceChatter marker. "pending"
 *   means the host model call is still in flight (the visual may show a
 *   placeholder, e.g. flavor.fallback); "resolved" carries the model's
 *   cosmetic text in flavor.text; "failed" carries flavor.fallback (if any).
 *   Resolved chatter is cosmetic-only: the visual must render it transiently
 *   and must NOT persist it into message history or authoritative state. Any
 *   other flavor shape is free-form author data with no host interpretation.
 *
 * Trust posture: the SDK trusts the host for state/result/error (it is the
 * authority) but still refuses a protocol-version mismatch or an unrecognized
 * nonce, so a stale host message to a freshly-bound frame fails closed.
 */
export const VIBE_EXPERIENCE_SDK_SOURCE = String.raw`
(function () {
  "use strict";
  if (window.VibeExperience) return; // idempotent — never redefine

  var PROTOCOL_V = 1;

  function uuid4() {
    // RFC4122 v4 via crypto.getRandomValues; falls back to Math.random only if
    // crypto is unavailable (the sandbox always exposes crypto.getRandomValues).
    if (window.crypto && crypto.getRandomValues) {
      var b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = [];
      for (var i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, "0"));
      return h.slice(0,4).join("") + "-" + h.slice(4,6).join("") + "-" +
             h.slice(6,8).join("") + "-" + h.slice(8,10).join("") + "-" +
             h.slice(10,16).join("");
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  // A single pending host port until handshake delivers it over window.message.
  var hostPort = null;
  var nonce = null;       // bound on 'hello'; every outbound msg carries it
  var sessionId = null;
  var revision = 0;       // last authoritative revision seen (for CAS pre-fill)

  function send(msg) {
    if (!hostPort) return;                 // not yet wired — drop (host will re-sync)
    // MessagePort.postMessage(message, transfer?) — the second arg is a
    // TRANSFER LIST, not a target origin (that is window.postMessage's shape).
    // We transfer nothing, so omit it; passing "*" here would throw a
    // DataCloneError and the catch would swallow it, silently dropping the msg.
    try { hostPort.postMessage(msg); } catch (_) { /* port closed */ }
  }

  // Receive the MessageChannel port the host transfers right after 'hello'.
  // The host posts { kind:"port", port:<MessagePort> } to window (target "*"
  // because the frame is an opaque origin), then immediately posts 'hello' on
  // the port. We grab the port and listen on it.
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!isPlainObject(data)) return;
    if (data.kind === "port" && data.port && typeof data.port.postMessage === "function") {
      hostPort = data.port;
      hostPort.onmessage = onPortMessage;
      return;
    }
  });

  function onPortMessage(ev) {
    var msg = ev.data;
    if (!isPlainObject(msg)) return;
    if (msg.v !== PROTOCOL_V) return;       // version skew — fail closed
    switch (msg.kind) {
      case "hello": {
        nonce = msg.nonce;
        sessionId = msg.sessionId;
        revision = msg.initialRevision || 0;
        var conn = currentConnection;
        if (conn && conn.opts.onReady) {
          try { conn.opts.onReady({ sessionId: sessionId, revision: revision }); } catch (_) {}
        }
        send({ v: PROTOCOL_V, kind: "ready", nonce: nonce });
        return;
      }
      case "model_result": {
        // Realtime seam (RM-5): the host's async model reply re-enters the
        // frame as a loop channel event; the runtime applies it to the round.
        if (msg.nonce !== nonce) return;
        var m = { seatId: msg.seatId, result: msg.result };
        if (msg.requestId) m.requestId = msg.requestId;
        loopDispatch("vt-loop:model-result", m);
        return;
      }
      case "state": {
        if (msg.nonce !== nonce) return;    // stale frame — ignore
        var view = msg.view;
        if (view && typeof view.revision === "number") revision = view.revision;
        var c = currentConnection;
        if (!c) return;
        try { c.onView(view, { viewer: msg.viewer }); } catch (_) {}
        return;
      }
      case "result": {
        if (msg.nonce !== nonce) return;
        if (typeof msg.revision === "number") revision = msg.revision;
        // result is an ack; the follow-up 'state' carries the new projection.
        return;
      }
      case "error": {
        if (msg.nonce !== nonce) return;
        if (typeof msg.revision === "number") revision = msg.revision;
        var c2 = currentConnection;
        if (c2 && c2.opts.onError) {
          try { c2.opts.onError({ code: msg.code, message: msg.message, requestId: msg.requestId }); } catch (_) {}
        }
        return;
      }
      case "pending": {
        if (msg.nonce !== nonce) return;
        var c3 = currentConnection;
        if (c3 && c3.opts.onPending) {
          try { c3.opts.onPending(msg.phase); } catch (_) {}
        }
        return;
      }
      case "lifecycle": {
        if (msg.nonce !== nonce) return;
        var c4 = currentConnection;
        if (c4 && c4.opts.onLifecycle) {
          try { c4.opts.onLifecycle(msg.event); } catch (_) {}
        }
        return;
      }
      default:
        return; // unknown kind — ignore (forward-compatible)
    }
  }

  // Only one live connection per frame (a visual binds once on load). A second
  // connect() replaces the onView/hooks but keeps the bound nonce/revision.
  var currentConnection = null;

  function Experience() {}
  Experience.prototype.act = function (type, payload, opts) {
    if (!nonce) return;                     // not handshook yet — drop
    opts = opts || {};
    send({
      v: PROTOCOL_V,
      kind: "action",
      nonce: nonce,
      action: {
        type: String(type),
        requestId: opts.requestId || uuid4(),
        expectedRevision: (typeof opts.expectedRevision === "number")
          ? opts.expectedRevision : revision,
        participantId: opts.participantId,
        payload: payload,
      },
    });
  };
  Experience.prototype.resize = function (width, height) {
    if (!nonce) return;
    send({ v: PROTOCOL_V, kind: "resize", nonce: nonce, width: width | 0, height: height | 0 });
  };
  Experience.prototype.finish = function () {
    if (!nonce) return;
    send({ v: PROTOCOL_V, kind: "finish", nonce: nonce, revision: revision });
  };

  // ── realtime loop channel (RM-5) ────────────────────────────────────────
  // In a REALTIME frame the loop runtime (booted after this SDK loads) drives
  // vt-loop:* CustomEvents on the frame window; the SDK wraps them into the
  // author-facing loop API and auto-forwards the two host-bound kinds over the
  // port bridge: 'model_request' (to the host's model seam) and the finished
  // round (as 'round_commit'). In a turn-based frame none of these events ever
  // fire — this whole surface is inert and the turn path above is untouched.

  var latestLoopView = null;         // cached latest projection (late connect)
  var loopEventBuf = [];             // bounded replay of round-log events
  var LOOP_EVENT_BUF_MAX = 512;      // a pathological round must not grow it
  var loopCbs = { tick: null, event: null, finish: null, error: null };

  function loopDispatch(type, detail) {
    try {
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
      }
    } catch (_) { /* no DOM CustomEvent (turn-only harness) — inert */ }
  }

  function deliverLoop(kind, detail) {
    var cb = loopCbs[kind];
    if (cb) { try { cb(detail); } catch (_) {} }
  }

  window.addEventListener("vt-loop:view", function (ev) {
    latestLoopView = ev.detail;
    diagView = ev.detail;   // RM-13: sample (replaced — the flush sends the latest)
    diagArm();
    diagMarkDirty();
    deliverLoop("tick", ev.detail);
  });
  window.addEventListener("vt-loop:event", function (ev) {
    var e = ev.detail;
    if (!isPlainObject(e)) return;
    loopEventBuf.push(e);
    if (loopEventBuf.length > LOOP_EVENT_BUF_MAX) loopEventBuf.shift();
    // RM-13: 'round_started' arrives BEFORE the first view — arming here
    // means the host sees "the loop booted" even if views never flow (the
    // exact RM-12c boot-crash signature).
    diagArm();
    diagMarkDirty();
    if (e.kind === "model_request" && nonce) {
      // Auto-forward to the host seam: the round log is the single source of
      // truth — the wire mirrors what the loop recorded, never the reverse.
      var req = { v: PROTOCOL_V, kind: "model_request", nonce: nonce, seatId: e.seatId, prompt: e.prompt };
      if (e.requestId) req.requestId = e.requestId;
      send(req);
    }
    deliverLoop("event", e);
  });
  window.addEventListener("vt-loop:finish", function (ev) {
    var f = ev.detail;
    if (!isPlainObject(f)) return;
    if (nonce) {
      var commit = { v: PROTOCOL_V, kind: "round_commit", nonce: nonce, status: f.status, finalState: f.finalState, log: f.log };
      if (f.score !== undefined) commit.score = f.score;
      if (f.summary !== undefined) commit.summary = f.summary;
      send(commit);
    }
    deliverLoop("finish", f);
    // RM-13: the round's last sample goes out immediately (final: true).
    diagFlush(true);
  });
  window.addEventListener("vt-loop:error", function (ev) {
    var d = ev.detail;
    if (isPlainObject(d)) {
      diagErrors.push(d);
      if (diagErrors.length > DIAG_ERROR_TAIL_MAX) diagErrors.shift();
      diagArm();
      diagMarkDirty();
    }
    deliverLoop("error", ev.detail);
  });

  // ── loop diagnostics channel (RM-13) ────────────────────────────────
  // The loop's life (views, round-log events, errors, the frame console)
  // happens INSIDE this frame; without a forward channel the host panel is
  // structurally blind to it (the RM-12c loop-boot crash was invisible for
  // exactly this reason). The SDK samples the latest projection at most
  // ~1/s, keeps bounded tails of loop events / errors / console entries,
  // and posts ONE 'loop_diag' message per flush window. The channel ARMS
  // only when a vt-loop:* event fires — a turn-based frame never sends it.
  var DIAG_FLUSH_MS = 750;
  var DIAG_EVENT_TAIL_MAX = 48;
  var DIAG_ERROR_TAIL_MAX = 12;
  var DIAG_CONSOLE_TAIL_MAX = 48;
  var DIAG_TEXT_MAX = 2000;
  var diagArmed = false;      // a vt-loop:* event fired (realtime frame)
  var diagDone = false;       // final sample posted (round finished)
  var diagDirty = false;
  var diagTimer = null;
  var diagView = null;        // latest sampled projection (replaced, not appended)
  var diagErrors = [];        // ring of loop errors ({kind,message})
  var diagConsole = [];       // ring of frame console entries

  function diagArm() {
    if (diagArmed || diagDone) return;
    diagArmed = true;
    diagDirty = true;         // the arming event itself is worth one sample
    diagTimer = setTimeout(diagFlush, DIAG_FLUSH_MS);
  }

  function diagMarkDirty() {
    if (!diagArmed || diagDone) return;
    diagDirty = true;
    if (diagTimer === null) diagTimer = setTimeout(diagFlush, DIAG_FLUSH_MS);
  }

  function diagFlush(final) {
    diagTimer = null;
    if (!nonce || !hostPort) {
      // Handshake not wired yet — keep the sample pending, retry shortly.
      if (!diagDone) diagTimer = setTimeout(function () { diagFlush(final); }, DIAG_FLUSH_MS);
      return;
    }
    if (!diagDirty && !final) return;
    diagDirty = false;
    var msg = {
      v: PROTOCOL_V,
      kind: "loop_diag",
      nonce: nonce,
      events: loopEventBuf.slice(-DIAG_EVENT_TAIL_MAX),
      errors: diagErrors.slice(),
      console: diagConsole.slice(),
      final: final === true,
    };
    if (diagView !== null) msg.view = diagView;
    send(msg);
    if (final === true) {
      diagDone = true;
    } else if (diagTimer === null) {
      diagTimer = setTimeout(function () { diagFlush(false); }, DIAG_FLUSH_MS);
    }
  }

  // Frame console pipe (RM-13): mirror console.log/warn/error into the
  // diagnostics ring (bounded; the original methods keep working). Collected
  // in every frame kind, but only FORWARDED once the loop channel arms — a
  // turn-based frame collects into the ring and never sends it.
  (function pipeConsole() {
    var con = window.console;
    if (!con) return; // no console surface (exotic embedder) — best-effort off
    function fmt(args) {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        var s;
        if (typeof a === "string") { s = a; }
        else { try { s = JSON.stringify(a); } catch (_) { s = String(a); } }
        parts.push(s);
      }
      var text = parts.join(" ");
      return text.length > DIAG_TEXT_MAX ? text.slice(0, DIAG_TEXT_MAX) : text;
    }
    function wrap(level, original) {
      if (typeof original !== "function") return original;
      return function () {
        var args = Array.prototype.slice.call(arguments);
        try {
          diagConsole.push({ level: level, text: fmt(args) });
          if (diagConsole.length > DIAG_CONSOLE_TAIL_MAX) diagConsole.shift();
          diagMarkDirty();
        } catch (_) { /* never break the caller */ }
        return original.apply(console, args);
      };
    }
    try {
      con.log = wrap("log", con.log);
      con.warn = wrap("warn", con.warn);
      con.error = wrap("error", con.error);
    } catch (_) { /* console read-only — the pipe is best-effort */ }
  })();

  // Sample hooks: the view listener above and the event listener feed these.
  // (Wired below as wrappers to keep the listeners above untouched.)

  // Frame-local intention for the realtime loop: no host round-trip, no
  // one-action lock, legal before the handshake (the loop owns the bounds).
  Experience.prototype.actLocal = function (type, payload, opts) {
    opts = opts || {};
    loopDispatch("vt-loop:input", {
      type: String(type),
      participantId: opts.participantId,
      payload: payload,
    });
  };
  // Ask the model seam for a declared seat. Returns the requestId (wire
  // correlation); the reply arrives as a 'model_result' loop event.
  Experience.prototype.modelRequest = function (seatId, prompt) {
    var requestId = uuid4();
    loopDispatch("vt-loop:model-request", { seatId: String(seatId), prompt: prompt, requestId: requestId });
    return requestId;
  };
  // End the round from the surface: { status: "completed"|"interrupted", score?, summary? }.
  Experience.prototype.finishRound = function (payload) {
    payload = isPlainObject(payload) ? payload : {};
    loopDispatch("vt-loop:finish-request", {
      status: payload.status,
      score: payload.score,
      summary: payload.summary,
    });
  };
  Experience.prototype.onTick = function (cb) {
    loopCbs.tick = cb;
    if (latestLoopView !== null) { try { cb(latestLoopView); } catch (_) {} }
    return this;
  };
  Experience.prototype.onLoopEvent = function (cb) {
    loopCbs.event = cb;
    for (var i = 0; i < loopEventBuf.length; i++) { try { cb(loopEventBuf[i]); } catch (_) {} }
    return this;
  };
  Experience.prototype.onRoundFinish = function (cb) {
    loopCbs.finish = cb;
    return this;
  };
  Experience.prototype.onRoundError = function (cb) {
    loopCbs.error = cb;
    return this;
  };

  function connect(onView, opts) {
    if (typeof onView !== "function") {
      throw new Error("VibeExperience.connect requires an onView function");
    }
    currentConnection = { onView: onView, opts: opts || {} };
    var xp = new Experience();
    // expose session meta as a getter (re-read after handshake)
    Object.defineProperty(xp, "session", {
      get: function () { return { sessionId: sessionId, revision: revision }; },
    });
    // If hello already arrived before connect() (port handshake is async),
    // there is nothing to replay — the host re-sends state on 'ready'.
    return xp;
  }

  window.VibeExperience = { connect: connect };
})();
`;
