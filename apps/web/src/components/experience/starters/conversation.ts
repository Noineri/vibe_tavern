/**
 * Conversation visual starter (IR-63) — compact history, composer, typing
 * state, and Finish.
 *
 * Suited to Messenger, radio, terminal, and mail experiences. Renders a scroll
 * of messages from the projected `state.messages` (each {from, text, partial}),
 * a composer (textarea + send) that submits a `reply` action carrying the typed
 * text, a typing indicator driven by the host's pending phase, and a Finish
 * control. A partial message reveals incrementally; once it arrives without
 * `partial`, it is the final full text.
 *
 * NO hard-coded provider access: the visual never calls an AI provider. The
 * composer only submits a `reply` intention through the bridge; the host routes
 * it (a model-controlled counterpart's response is a durable host effect, never
 * a direct provider call from the frame). This keeps provider access on the
 * trusted host side of the boundary.
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK.
 */
import type { VisualStarter } from "./types.js";

export const CONVERSATION_VISUAL_SOURCE = [
  "<style>",
  "  .xp-conv{font:14px/1.4 system-ui,sans-serif;color:#e5e5e5;display:flex;flex-direction:column;width:100%;min-width:300px;max-width:520px;height:420px}",
  "  .xp-conv .history{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;background:#171717;border-radius:6px}",
  "  .xp-conv .msg{max-width:80%;padding:6px 10px;border-radius:10px;white-space:pre-wrap}",
  "  .xp-conv .msg.them{align-self:flex-start;background:#262626}",
  "  .xp-conv .msg.you{align-self:flex-end;background:#1d4ed8}",
  "  .xp-conv .msg .who{font-size:10px;color:#9ca3af;margin-bottom:2px}",
  "  .xp-conv .typing{color:#9ca3af;font-size:12px;padding:2px 10px;font-style:italic}",
  "  .xp-conv .composer{display:flex;gap:6px;padding:8px 0 0}",
  "  .xp-conv textarea{flex:1;background:#262626;color:#e5e5e5;border:1px solid #404040;border-radius:6px;padding:6px 8px;resize:none;font:inherit}",
  "  .xp-conv button{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer}",
  "  .xp-conv button:disabled{opacity:.5;cursor:default}",
  "  .xp-conv .finish{background:transparent;color:#fbbf24;border:1px solid #fbbf24}",
  "</style>",
  '<div class="xp-conv" id="xp-root">',
  '  <div class="history" id="xp-history"></div>',
  '  <div class="typing" id="xp-typing" style="display:none">typing...</div>',
  '  <div class="composer">',
  '    <textarea id="xp-input" rows="2" placeholder="Type a reply..."></textarea>',
  '    <button id="xp-send">Send</button>',
  '    <button id="xp-finish" class="finish" style="display:none">Finish</button>',
  '  </div>',
  "</div>",
  "<script>",
  "(function(){",
  "  var root=document.getElementById('xp-root');",
  "  var historyEl=document.getElementById('xp-history');",
  "  var typingEl=document.getElementById('xp-typing');",
  "  var inputEl=document.getElementById('xp-input');",
  "  var sendBtn=document.getElementById('xp-send');",
  "  var finishBtn=document.getElementById('xp-finish');",
  "  var xp;",
  "  function resize(){ if(xp){ xp.resize(root.scrollWidth,root.scrollHeight); } }",
  "  function atBottom(){ historyEl.scrollTop=historyEl.scrollHeight; }",
  "  function hasAction(view,type){ var a=(view&&view.actions)||[]; for(var i=0;i<a.length;i++){if(a[i].type===type)return true;} return false; }",
  "  function render(view){",
  "    var s=(view&&view.state)||{};",
  "    // history",
  "    historyEl.innerHTML='';",
  "    var msgs=s.messages||[];",
  "    for(var i=0;i<msgs.length;i++){(function(m){",
  "      var d=document.createElement('div');d.className='msg '+(m.from==='you'?'you':'them');",
  "      var who=document.createElement('div');who.className='who';who.textContent=m.from;",
  "      d.appendChild(who);",
  "      d.appendChild(document.createTextNode(m.text||''));",
  "      historyEl.appendChild(d);",
  "    })(msgs[i]);}",
  "    atBottom();",
  "    // composer + finish availability",
  "    var canReply=hasAction(view,'reply');",
  "    sendBtn.disabled=!canReply;",
  "    inputEl.disabled=!canReply;",
  "    finishBtn.style.display=hasAction(view,'finish')?'block':'none';",
  "    resize();",
  "  }",
  "  function sendReply(){",
  "    var t=inputEl.value.trim();",
  "    if(!t||!xp) return;",
  "    xp.act('reply',{text:t});",
  "    inputEl.value='';",
  "  }",
  "  sendBtn.onclick=sendReply;",
  "  finishBtn.onclick=function(){ if(xp) xp.finish(); };",
  "  inputEl.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendReply(); } });",
  "  xp=window.VibeExperience.connect(render,{",
  "    onPending:function(phase){",
  "      typingEl.style.display=phase==='typing'?'block':'none';",
  "      typingEl.textContent=phase==='typing'?'typing...':(phase==='effect'?'thinking...':'');",
  "    },",
  "    onError:function(err){var d=document.createElement('div');d.className='msg them';d.style.color='#f87171';d.textContent=err.message||err.code;historyEl.appendChild(d);atBottom();}",
  "  });",
  "})();",
  "</script>",
].join("\n");

export const conversationStarter: VisualStarter = {
  id: "conversation",
  label: "Conversation",
  description: "Compact message history, composer, typing state, and Finish. Suited to Messenger, radio, terminal, and mail experiences.",
  source: CONVERSATION_VISUAL_SOURCE,
  fixtures: {
    setup: { state: { messages: [{ from: "them", text: "Connection established. Say hello." }] }, actions: [{ type: "reply" }], revision: 0, status: "active" },
    ordinary: { state: { messages: [{ from: "them", text: "Did you get the coordinates?" }, { from: "you", text: "Affirmative. Sending now." }] }, actions: [{ type: "reply" }, { type: "finish" }], revision: 2, status: "active" },
    pending: { state: { messages: [{ from: "them", text: "Did you get the coordinates?" }, { from: "you", text: "Affirmative. Sending now." }] }, actions: [], revision: 2, status: "active" },
    error: { state: { messages: [{ from: "them", text: "Did you get the coordinates?" }] }, actions: [{ type: "reply" }], revision: 2, status: "active" },
    completed: { state: { messages: [{ from: "them", text: "Understood. Closing channel." }] }, actions: [], revision: 6, status: "completed" },
  },
};
