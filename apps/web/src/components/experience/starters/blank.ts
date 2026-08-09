/**
 * Blank visual starter (IR-63) — the minimal editable scaffold.
 *
 * One of five editable source skeletons a new visual is copied from (design:
 * "Each new visual begins from an editable starter rather than empty files").
 * The chosen starter is copied into the visual and becomes fully user-owned
 * source; only the versioned VibeExperience SDK remains host-provided.
 *
 * Blank wires the root lifecycle: connect → render the projected state, the
 * action helper, pending/typing + error surfaces, and content resize. An author
 * builds on this for a state-machine experience that does not fit the other four
 * starters (Choice / Grid / Card Table / Conversation).
 *
 * Starter contract (validated by ExperiencePreview tests):
 *   - self-contained HTML/CSS/JS, NO application-internal imports, NO host
 *     globals (the frame CSP blocks network/storage anyway; the SDK is the only
 *     host-provided surface);
 *   - subscribes via VibeExperience.connect(onView) and submits via
 *     experience.act(type, payload?); reports content size via resize(w, h).
 *
 * Pattern used by every starter: capture the experience handle returned by
 * connect() (`var xp = VibeExperience.connect(onView, opts)`). onView fires
 * asynchronously (on the first state message), so by then `xp` is assigned and
 * render() can call xp.resize(). Stash nothing on window.
 */
import type { VisualStarter } from "./types.js";

export const BLANK_VISUAL_SOURCE = [
  "<style>",
  "  .xp-blank{font:14px/1.4 system-ui,sans-serif;color:#e5e5e5;padding:12px;min-width:200px}",
  "  .xp-blank h3{margin:0 0 8px;font-size:13px;font-weight:600}",
  "  .xp-blank .row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}",
  "  .xp-blank button{background:#262626;color:#e5e5e5;border:1px solid #404040;border-radius:6px;padding:6px 10px;cursor:pointer}",
  "  .xp-blank button:hover{background:#333}",
  "  .xp-blank .pending{color:#fbbf24;font-size:12px}",
  "  .xp-blank .error{color:#f87171;font-size:12px;white-space:pre-wrap}",
  "  .xp-blank .done{color:#9ca3af;font-size:12px}",
  "</style>",
  '<div class="xp-blank" id="xp-root">',
  '  <h3 id="xp-title">Experience</h3>',
  '  <div id="xp-state"></div>',
  '  <div class="row" id="xp-actions"></div>',
  '  <div class="pending" id="xp-pending" style="display:none">working...</div>',
  '  <div class="error" id="xp-error" style="display:none"></div>',
  "</div>",
  "<script>",
  "(function(){",
  "  var root=document.getElementById('xp-root');",
  "  var stateEl=document.getElementById('xp-state');",
  "  var actionsEl=document.getElementById('xp-actions');",
  "  var pendingEl=document.getElementById('xp-pending');",
  "  var errorEl=document.getElementById('xp-error');",
  "  var xp;",
  "  function act(type,payload){ if(xp) xp.act(type,payload); }",
  "  function resize(){ if(xp){ xp.resize(root.scrollWidth,root.scrollHeight); } }",
  "  function render(view){",
  "    errorEl.style.display='none';",
  "    stateEl.textContent=view&&view.state?JSON.stringify(view.state):'';",
  "    actionsEl.innerHTML='';",
  "    var acts=(view&&view.actions)||[];",
  "    if(view&&view.status==='completed'){",
  "      var d=document.createElement('div');d.className='done';d.textContent='Completed';actionsEl.appendChild(d);",
  "    } else {",
  "      for(var i=0;i<acts.length;i++){(function(a){",
  "        var b=document.createElement('button');b.textContent=a.label||a.type;",
  "        b.onclick=function(){ act(a.type); };actionsEl.appendChild(b);",
  "      })(acts[i]);}",
  "    }",
  "    resize();",
  "  }",
  "  xp=window.VibeExperience.connect(render,{",
  "    onPending:function(phase){pendingEl.style.display=phase==='idle'?'none':'block';pendingEl.textContent=phase==='typing'?'typing...':'thinking...';},",
  "    onError:function(err){errorEl.textContent=err.message||err.code;errorEl.style.display='block';},",
  "    onLifecycle:function(ev){if(ev==='finish'){var d=document.createElement('div');d.className='done';d.textContent='Finished';root.appendChild(d);}}",
  "  });",
  "})();",
  "</script>",
].join("\n");

export const blankStarter: VisualStarter = {
  id: "blank",
  label: "Blank State Machine",
  description: "Minimal scaffold: connect, render state, actions, pending, error, and resize. Build a custom state machine on top.",
  source: BLANK_VISUAL_SOURCE,
  fixtures: {
    setup: { state: { phase: "setup", note: "configure participants, then start" }, actions: [{ type: "start", label: "Start" }], revision: 0, status: "active" },
    ordinary: { state: { phase: "turn", score: 4, note: "pick an action" }, actions: [{ type: "advance", label: "Advance" }, { type: "reset", label: "Reset" }], revision: 3, status: "active" },
    pending: { state: { phase: "turn", score: 4 }, actions: [], revision: 3, status: "active" },
    error: { state: { phase: "turn", score: 4 }, actions: [{ type: "advance", label: "Advance" }], revision: 3, status: "active" },
    completed: { state: { phase: "done", score: 10 }, actions: [], revision: 7, status: "completed" },
  },
};
