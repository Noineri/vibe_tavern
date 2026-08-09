/**
 * Card Table visual starter (IR-63) — seats, hands, deck/discard/table zones.
 *
 * Suited to Durak and other card games. Renders one seat per participant from
 * the projected `state.seats` (label + hand of card labels + active flag), a
 * central table zone (cards on the table), and the deck/discard counts. The
 * legal `play` actions carry a card label; clicking a card in YOUR hand that
 * matches a legal play submits it. A `draw`/`pass` action, if present, renders
 * as a control below the table.
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK.
 */
import type { VisualStarter } from "./types.js";

export const CARD_TABLE_VISUAL_SOURCE = [
  "<style>",
  "  .xp-cards{font:13px/1.4 system-ui,sans-serif;color:#e5e5e5;padding:12px;min-width:280px}",
  "  .xp-cards .zone-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af;margin:8px 0 4px}",
  "  .xp-cards .table{display:flex;flex-wrap:wrap;gap:4px;min-height:30px;padding:6px;background:#064e3b;border-radius:6px}",
  "  .xp-cards .card{background:#fafafa;color:#111;border:1px solid #111;border-radius:4px;padding:3px 6px;font-weight:600;min-width:20px;text-align:center}",
  "  .xp-cards .card.back{background:#1d4ed8;color:#dbeafe;border-color:#1d4ed8}",
  "  .xp-cards .seat{display:flex;align-items:center;gap:6px;padding:4px 0}",
  "  .xp-cards .seat.active{color:#fbbf24;font-weight:600}",
  "  .xp-cards .seat .name{min-width:80px}",
  "  .xp-cards .hand .card{cursor:default;margin-right:2px}",
  "  .xp-cards .hand .card.legal{cursor:pointer;outline:2px solid #fbbf24}",
  "  .xp-cards .ctrls{display:flex;gap:8px;margin-top:8px}",
  "  .xp-cards button{background:#262626;color:#e5e5e5;border:1px solid #404040;border-radius:6px;padding:5px 10px;cursor:pointer}",
  "  .xp-cards button:hover{background:#333}",
  "  .xp-cards .pending{color:#fbbf24;font-size:12px}",
  "</style>",
  '<div class="xp-cards" id="xp-root">',
  '  <div class="zone-label">Table</div><div class="table" id="xp-table"></div>',
  '  <div class="zone-label">Seats</div><div id="xp-seats"></div>',
  '  <div class="ctrls" id="xp-ctrls"></div>',
  '  <div class="pending" id="xp-pending" style="display:none">waiting...</div>',
  "</div>",
  "<script>",
  "(function(){",
  "  var root=document.getElementById('xp-root');",
  "  var tableEl=document.getElementById('xp-table');",
  "  var seatsEl=document.getElementById('xp-seats');",
  "  var ctrlsEl=document.getElementById('xp-ctrls');",
  "  var pendingEl=document.getElementById('xp-pending');",
  "  var xp;",
  "  function resize(){ if(xp){ xp.resize(root.scrollWidth,root.scrollHeight); } }",
  "  function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}",
  "  function render(view){",
  "    var s=(view&&view.state)||{};",
  "    // table zone",
  "    clear(tableEl);",
  "    var tb=s.table||[];",
  "    for(var i=0;i<tb.length;i++){var c=document.createElement('span');c.className='card';c.textContent=tb[i];tableEl.appendChild(c);}",
  "    if(!tb.length){var p=document.createElement('span');p.style.color='#6b7280';p.textContent='—';tableEl.appendChild(p);}",
  "    // legal play labels (which cards in hand are playable)",
  "    var legal={};var acts=(view&&view.actions)||[];",
  "    for(var j=0;j<acts.length;j++){if(acts[j].type==='play'&&acts[j].payload&&acts[j].payload.card){legal[acts[j].payload.card]=1;}}",
  "    // seats + hands",
  "    clear(seatsEl);",
  "    var seats=s.seats||[];",
  "    for(var k=0;k<seats.length;k++){(function(seat){",
  "      var row=document.createElement('div');row.className='seat'+(seat.active?' active':'');",
  "      var nm=document.createElement('span');nm.className='name';nm.textContent=seat.label+(seat.you?' (you)':'');",
  "      var hand=document.createElement('span');hand.className='hand';",
  "      var cards=seat.hand||[];",
  "      for(var h=0;h<cards.length;h++){(function(label){",
  "        var card=document.createElement('span');card.className='card'+(legal[label]?' legal':'');card.textContent=label;",
  "        if(seat.you&&legal[label]){card.onclick=function(){ if(xp) xp.act('play',{card:label}); };}",
  "        hand.appendChild(card);",
  "      })(cards[h]);}",
  "      row.appendChild(nm);row.appendChild(hand);seatsEl.appendChild(row);",
  "    })(seats[k]);}",
  "    // non-play controls (draw/pass)",
  "    clear(ctrlsEl);",
  "    for(var m=0;m<acts.length;m++){if(acts[m].type!=='play'){(function(a){",
  "      var b=document.createElement('button');b.textContent=a.label||a.type;b.onclick=function(){ if(xp) xp.act(a.type); };ctrlsEl.appendChild(b);",
  "    })(acts[m]);}}",
  "    resize();",
  "  }",
  "  xp=window.VibeExperience.connect(render,{",
  "    onPending:function(phase){pendingEl.style.display=phase==='idle'?'none':'block';pendingEl.textContent=phase==='typing'?'opponent typing...':'thinking...';},",
  "    onError:function(err){clear(tableEl);var e=document.createElement('span');e.style.color='#f87171';e.textContent=err.message||err.code;tableEl.appendChild(e);}",
  "  });",
  "})();",
  "</script>",
].join("\n");

export const cardTableStarter: VisualStarter = {
  id: "card-table",
  label: "Card Table",
  description: "Participant seats, hands, deck/discard/table zones, and turn status. Suited to Durak and other card games.",
  source: CARD_TABLE_VISUAL_SOURCE,
  fixtures: {
    setup: {
      state: { table: [], seats: [{ label: "You", you: true, active: true, hand: ["7H", "KS"] }, { label: "Ana", active: false, hand: 2 }] },
      actions: [], revision: 0, status: "active",
    },
    ordinary: {
      state: { table: ["7H"], seats: [{ label: "You", you: true, active: true, hand: ["KS", "AD"] }, { label: "Ana", active: false, hand: 3 }] },
      actions: [{ type: "play", label: "King of Spades", payload: { card: "KS" } }, { type: "play", label: "Ace of Diamonds", payload: { card: "AD" } }], revision: 4, status: "active",
    },
    pending: {
      state: { table: ["7H"], seats: [{ label: "You", you: true, active: false, hand: ["KS", "AD"] }, { label: "Ana", active: true, hand: 3 }] },
      actions: [], revision: 4, status: "active",
    },
    error: {
      state: { table: ["7H"], seats: [{ label: "You", you: true, active: true, hand: ["KS", "AD"] }, { label: "Ana", active: false, hand: 3 }] },
      actions: [{ type: "play", label: "King of Spades", payload: { card: "KS" } }], revision: 4, status: "active",
    },
    completed: {
      state: { table: ["7H", "KS", "AD"], seats: [{ label: "You", you: true, active: false, hand: [] }, { label: "Ana", active: false, hand: 1 }] },
      actions: [], revision: 12, status: "completed",
    },
  },
};
