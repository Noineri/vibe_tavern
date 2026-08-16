/**
 * Choice visual starter (IR-63) — discrete actions + result reveal.
 *
 * Suited to Rock Paper Scissors, dialogue-like prompts, and any experience
 * whose turn is a pick from a small set of labeled choices. Each legal action
 * renders as a button; the projected state carries a prompt and the last
 * resolved result, which is revealed below the chooser.
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK —
 * no application-internal imports, no host globals (see the starter contract in
 * blank.ts).
 */
import type { VisualStarter } from "./types.js";

export const CHOICE_VISUAL_SOURCE = [
  "<style>",
  "  .xp-choice{font:14px/1.5 system-ui,sans-serif;color:#e5e5e5;padding:14px;min-width:220px}",
  "  .xp-choice .prompt{margin:0 0 12px;font-weight:600}",
  "  .xp-choice .choices{display:flex;flex-wrap:wrap;gap:8px}",
  "  .xp-choice button{background:#1e3a5f;color:#e5e5e5;border:1px solid #3b82f6;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px}",
  "  .xp-choice button:hover{background:#2563eb}",
  "  .xp-choice .result{margin-top:12px;padding:10px;background:#171717;border-radius:6px;min-height:18px;white-space:pre-wrap}",
  "  .xp-choice .pending{color:#fbbf24;font-size:12px;margin-top:8px}",
  "  .xp-choice .done{color:#9ca3af;margin-top:8px}",
  "</style>",
  '<div class="xp-choice" id="xp-root">',
  '  <p class="prompt" id="xp-prompt">Choose...</p>',
  '  <div class="choices" id="xp-choices"></div>',
  '  <div class="pending" id="xp-pending" style="display:none">waiting...</div>',
  '  <div class="result" id="xp-result"></div>',
  "</div>",
  "<script>",
  "(function(){",
  "  var root=document.getElementById('xp-root');",
  "  var promptEl=document.getElementById('xp-prompt');",
  "  var choicesEl=document.getElementById('xp-choices');",
  "  var pendingEl=document.getElementById('xp-pending');",
  "  var resultEl=document.getElementById('xp-result');",
  "  var xp;",
  "  function resize(){ if(xp){ xp.resize(root.scrollWidth,root.scrollHeight); } }",
  "  function render(view){",
  "    var s=(view&&view.state)||{};",
  "    promptEl.textContent=s.prompt||'Choose...';",
  "    resultEl.textContent=s.result||'';",
  "    choicesEl.innerHTML='';",
  "    if(view&&view.status==='completed'){",
  "      var d=document.createElement('div');d.className='done';d.textContent='Completed';choicesEl.appendChild(d);",
  "    } else {",
  "      var acts=(view&&view.actions)||[];",
  "      for(var i=0;i<acts.length;i++){(function(a){",
  "        var b=document.createElement('button');b.textContent=a.label||a.type;",
  "        b.onclick=function(){ if(xp) xp.act(a.type); };choicesEl.appendChild(b);",
  "      })(acts[i]);}",
  "    }",
  "    resize();",
  "  }",
  "  xp=window.VibeExperience.connect(render,{",
  "    onPending:function(phase){pendingEl.style.display=phase==='idle'?'none':'block';pendingEl.textContent=phase==='typing'?'they are typing...':'thinking...';},",
  "    onError:function(err){resultEl.textContent=(err.message||err.code);}",
  "  });",
  "})();",
  "</script>",
].join("\n");

export const choiceStarter: VisualStarter = {
  id: "choice",
  label: "Choice",
  description: "Discrete labeled actions with a result reveal. Suited to Rock Paper Scissors, dialogue, and pick-one turns.",
  source: CHOICE_VISUAL_SOURCE,
  fixtures: {
    setup: { state: { prompt: "Choose your throw", result: "" }, actions: [{ type: "throw", label: "Rock", payload: { pick: "rock" } }, { type: "throw", label: "Paper", payload: { pick: "paper" } }, { type: "throw", label: "Scissors", payload: { pick: "scissors" } }], revision: 0, status: "active" },
    ordinary: { state: { prompt: "Best of 3 — your throw", result: "You played Rock, opponent played Scissors — you win the round!" }, actions: [{ type: "throw", label: "Rock", payload: { pick: "rock" } }, { type: "throw", label: "Paper", payload: { pick: "paper" } }], revision: 2, status: "active" },
    pending: { state: { prompt: "Waiting for opponent...", result: "You played Paper" }, actions: [], revision: 2, status: "active" },
    error: { state: { prompt: "Choose your throw", result: "" }, actions: [{ type: "throw", label: "Rock", payload: { pick: "rock" } }], revision: 2, status: "active" },
    completed: { state: { prompt: "Match over", result: "You win 2-1!" }, actions: [], revision: 5, status: "completed" },
  },
};
