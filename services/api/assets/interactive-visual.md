# Reference: the visual bridge

This document is the API reference for the `visual` buffer of an interactive experience — the iframe document that renders the experience through the host bridge. It is **reference material, not an output-format spec**: visuals are proposed through the `write_buffer`/`edit_buffer` tools (`target: "visual"`) and never emitted as raw code in chat.

# What a visual is
The visual is the PRESENTATION half of an experience. It is an isolated iframe document the host loads, injects the `VibeExperience` SDK into, and then drives by pushing authoritative per-viewer projections. The visual NEVER contains rules logic (create/project/actions/reduce) — that lives in the separate rules source. The visual only: connects to the bridge, renders the projected view it receives, and submits the user's chosen actions back. Rules and presentation fail independently.

# The host bridge (the ONLY host-provided surface)
The host injects one global into your iframe before your script runs: `window.VibeExperience`. It is the entire contract between your visual and the runtime. There is no other host API. Do not invent one.

```js
var xp = window.VibeExperience.connect(onView, opts?);
```
`connect` returns an `experience` handle. `onView(view, meta)` fires on every authoritative projection the host pushes for this frame's viewer — this is how your visual learns the current game state. Call `connect` exactly ONCE on load; it is idempotent but a single binding is the correct shape.

`onView(view, meta)` receives:
- `view` — the projected view for this viewer (the shape below). This is your source of truth for what to render; it already has hidden information stripped by the rules' projection. Treat it as read-only.
- `meta.viewer` — the viewer this projection was computed for (opaque; you usually do not need it).

The projected `view` shape (plain bounded JSON):
```
{
  state:    <plain JSON the rules' project() returned for this viewer>,
  actions:  [ { type, participantId?, label?, payloadSchema?, allowsText? } ],
  flavor?:  <plain JSON cosmetic data, present only when the rules declare a flavor method>,
  revision: <integer, monotonically increasing>,
  status:   "active" | "completed"   // (and other terminal session statuses)
}
```
- `view.state` is arbitrary JSON the experience chose to project — render it however the design calls for. You do not control its shape; you render it faithfully.
- `view.actions` is the set of legal moves offered to THIS viewer right now. Each has a `type` (the string you submit back via `act`) and an optional human `label`. `allowsText: true` means the action accepts free-text input (render an input/textarea and pass the text as the payload). An empty `actions` array means no legal move — show a waiting state, not a broken UI.
- `view.flavor`, when present, is cosmetic data the rules produced at display time; render it but never let it gate functionality.
- `view.status === "completed"` means the experience ended naturally — show a terminal state and stop offering actions.

The `experience` handle methods:
```js
xp.act(type, payload?, opts?)   // submit one intention. type MUST match a descriptor in view.actions.
                                // opts.participantId / opts.requestId are optional; the SDK fills them when absent.
xp.resize(width, height)        // report your rendered content size to the host (in CSS pixels) so the frame can size.
xp.finish()                     // request the privileged finish op (only if the design calls for it).
xp.session                      // { sessionId, revision } — read-only meta, populated after handshake.
```
The `opts?` argument to `connect`:
```js
{
  onReady?:    (sessionMeta) => void,   // { sessionId, revision } — fires once after the host handshake.
  onPending?:  (phase) => void,        // phase: "idle" | "typing" | "effect" — show a working indicator.
  onError?:    (err) => void,          // err: { code, message, requestId? } — surface the failure, keep the UI usable.
  onLifecycle?: (event) => void,       // event: "suspend" | "resume" | "finish" | "reset".
}
```

# Runtime environment (HARD)
Your document runs inside an iframe with `sandbox="allow-scripts"` and WITHOUT `allow-same-origin`, so its origin is always the opaque `"null"` origin. This is real isolation:
- ALLOWED: the standard DOM (`document`, `document.createElement`, `getElementById`, `innerHTML`, `textContent`, `style`, event listeners), CSS (`<style>`, inline styles), inline `<script>`, `Math`, `JSON`, `Array`, `Object`, `String`, `crypto.getRandomValues`, and the one host global `window.VibeExperience`.
- FORBIDDEN: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `importScripts`, dynamic `import()`, ES module syntax (`export`/`import`), `<link>`/`<script src>` to external URLs, access to `parent`/`top`/`window.opener` (blocked by the sandbox), and any network, storage, or process API. The frame has no network and no storage — do not attempt to load external assets, fonts, libraries, or images by URL. Inline everything (data: URIs for images if absolutely needed; inline SVG preferred).
- Write plain browser JS (no build step, no bundler, no modules). ES5-ish patterns (`var`, `function`, `for` loops, `.map`) and method shorthand / arrow functions inside an IIFE are both supported; wrap your script in an IIFE `(function(){ ... })();` so it does not leak globals.
- Do NOT stash state on `window` beyond the SDK. Do NOT redefine `window.VibeExperience`.

# Correct connection pattern
`onView` fires asynchronously (on the first `state` message after handshake), so capture the handle returned by `connect` in a variable, then reference it inside `onView` / your render function. The canonical shape every starter uses:
```html
<style>/* your styles */</style>
<div id="xp-root"><!-- your markup --></div>
<script>
(function () {
  var root = document.getElementById('xp-root');
  var xp;
  function render(view) {
    /* read view.state, view.actions, view.status and update the DOM */
    if (xp) xp.resize(root.scrollWidth, root.scrollHeight);
  }
  function act(type, payload) { if (xp) xp.act(type, payload); }
  xp = window.VibeExperience.connect(render, {
    onPending: function (phase) { /* show/hide a working indicator */ },
    onError:   function (err) { /* surface err.message, keep UI usable */ },
    onLifecycle: function (ev) { /* handle finish/reset if the design needs it */ }
  });
})();
</script>
```

# Handling every view phase
A robust visual renders all of these gracefully (the package's preview fixtures exercise them):
- **setup / ordinary** — the normal interactive turn: render `view.state`, offer `view.actions` as buttons (or inputs for `allowsText` actions).
- **pending** — an action is in flight (`onPending` fires with `typing`/`effect`): show a working indicator and avoid double-submitting. A live game timer never arrives as pending — during a timer wait the player is still expected to act; keep controls interactive.
- **error** — `onError` fires: surface the message, keep the last good state visible, let the user retry.
- **completed** — `view.status === "completed"`: show a terminal state and stop offering actions.

# Realtime rounds (loop mode)

When the package's manifest is `mode: "realtime"`, the game loop runs INSIDE your frame: the host injects the round config (rules, seed, participants) alongside your source, and the engine ticks `update`/applies inputs locally. There are NO server round-trips during the round — no `view` pushes arrive after the bootstrap; your rendering is driven by tick callbacks.

New handle methods (inert in turn-based frames — the same visual source may host both modes by guarding on them):

```js
xp.actLocal(type, payload?, opts?)        // frame-local input: queued and applied at the next tick boundary (legality-checked). No round-trip, no one-action lock — safe in a keydown handler at input rate.
xp.modelRequest(seatId, prompt)           // returns a requestId. Asks the host's model seam for a model seat; the reply arrives as a model_result loop event.
xp.finishRound({ status, score?, summary? })  // ends the round NOW (a tick boundary). status "completed" (default) or "interrupted" (player abandon). score/summary ride the single commit → the chat card.
```

New subscriptions (early events are buffered — connect late and you still see the latest view):

```js
xp.onTick(cb)        // the fresh projected view (same `view` shape) every tick — re-render here.
xp.onLoopEvent(cb)   // raw round-log events (inputs, script moves, model results) — for effects/transient UI.
xp.onRoundFinish(cb) // the finished claim { status, finalState, score?, summary? } — render a terminal card.
xp.onRoundError(cb)  // a fatal loop error (e.g. the watchdog) — surface it, stop rendering ticks.
```

In a realtime frame `xp.act()` (the turn-path submit) is a MODE ERROR — use `actLocal`. `xp.resize`/`xp.finish` keep their meaning.

Canonical realtime visual shape: subscribe `onTick` → render the projected state (canvas or DOM) → feed player input via `actLocal` from real event handlers (keydown/pointer, not buttons) → `finishRound` on win/lose/quit. Note the round is client-authoritative until commit: closing the host surface mid-round loses that round.

# Strict constraints
1. **Bind through the bridge only:** The visual interacts with the runtime exclusively via `window.VibeExperience.connect` and the handle it returns — `xp.act` / `xp.resize` / `xp.finish` in a turn-based frame; `xp.actLocal` / `xp.modelRequest` / `xp.finishRound` and the `xp.onTick` / `xp.onLoopEvent` / `xp.onRoundFinish` / `xp.onRoundError` subscriptions in a realtime frame (see "Realtime rounds"). No invented host API, no direct state mutation, no bypassing the projected view.
2. **No external resources:** Everything is inline. No external scripts, stylesheets, fonts, images by URL, or network calls. The sandbox blocks them; depending on them produces a blank frame.
3. **Targeted edits via tools:** When the user asks for changes to an existing visual, prefer `edit_buffer` (`target: "visual"`) with exact SEARCH/REPLACE edits — preserve all unrelated markup, styles and code; change only what was requested. Reserve `write_buffer` for a ground-up rewrite or the first mutation in a turn.
4. **No host leakage:** Never reference chat history, persona, character, lore, or any roleplay/prompt state — none of it exists inside the visual iframe. The only host-provided surface is `window.VibeExperience`.
5. **Render faithfully, do not invent state:** Render exactly what `view` provides. Do not fabricate game state, scores, or actions the projection did not include. An empty `actions` array is a waiting state, not an error.

# Canonical examples
These starters exist in the visual editor's «new from starter» picker; their source is not in this prompt — use the concrete example below as the shape. Point the user to the closest one when it helps:
- **Blank State Machine** — minimal scaffold: connect, render state, actions, pending, error, resize. The base every other visual builds on.
- **Card Table** — hands of cards drawn from a shuffled deck; a `deterministic_random` experience.
- **Choice** — branching choices / dialogue; an `allowsText` or branching action experience.
- **Conversation** — alternating message transcript, model-seat `typing` pending state, name/avatar header, explicit Finish.
- **Grid Board** — a 2D grid (e.g. 3×3 marks); a turn-based spatial experience.
- **Breakout** — a realtime arcade loop: bounce the ball off the paddle and clear the brick wall (3 balls); renders on the loop tick and commits the round once with the final score.

## Concrete example: minimal blank-state visual
```html
<style>
  .xp-blank{font:14px/1.4 system-ui,sans-serif;color:#e5e5e5;padding:12px;min-width:200px}
  .xp-blank h3{margin:0 0 8px;font-size:13px;font-weight:600}
  .xp-blank .row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .xp-blank button{background:#262626;color:#e5e5e5;border:1px solid #404040;border-radius:6px;padding:6px 10px;cursor:pointer}
  .xp-blank button:hover{background:#333}
  .xp-blank .pending{color:#fbbf24;font-size:12px}
  .xp-blank .error{color:#f87171;font-size:12px;white-space:pre-wrap}
  .xp-blank .done{color:#9ca3af;font-size:12px}
</style>
<div class="xp-blank" id="xp-root">
  <h3 id="xp-title">Experience</h3>
  <div id="xp-state"></div>
  <div class="row" id="xp-actions"></div>
  <div class="pending" id="xp-pending" style="display:none">working...</div>
  <div class="error" id="xp-error" style="display:none"></div>
</div>
<script>
(function () {
  var root = document.getElementById('xp-root');
  var stateEl = document.getElementById('xp-state');
  var actionsEl = document.getElementById('xp-actions');
  var pendingEl = document.getElementById('xp-pending');
  var errorEl = document.getElementById('xp-error');
  var xp;
  function act(type, payload) { if (xp) xp.act(type, payload); }
  function resize() { if (xp) xp.resize(root.scrollWidth, root.scrollHeight); }
  function render(view) {
    errorEl.style.display = 'none';
    stateEl.textContent = view && view.state ? JSON.stringify(view.state) : '';
    actionsEl.innerHTML = '';
    var acts = (view && view.actions) || [];
    if (view && view.status === 'completed') {
      var d = document.createElement('div'); d.className = 'done'; d.textContent = 'Completed'; actionsEl.appendChild(d);
    } else {
      for (var i = 0; i < acts.length; i++) { (function (a) {
        var b = document.createElement('button'); b.textContent = a.label || a.type;
        b.onclick = function () { act(a.type); }; actionsEl.appendChild(b);
      })(acts[i]); }
    }
    resize();
  }
  xp = window.VibeExperience.connect(render, {
    onPending: function (phase) { pendingEl.style.display = phase === 'idle' ? 'none' : 'block'; pendingEl.textContent = phase === 'typing' ? 'typing...' : 'thinking...'; },
    onError: function (err) { errorEl.textContent = err.message || err.code; errorEl.style.display = 'block'; },
    onLifecycle: function (ev) { if (ev === 'finish') { var d = document.createElement('div'); d.className = 'done'; d.textContent = 'Finished'; root.appendChild(d); } }
  });
})();
</script>
```
