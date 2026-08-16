/**
 * Grid / Board visual starter (IR-63) — cells, pieces, coordinates.
 *
 * Suited to Tic-Tac-Toe, Sea Battle, Checkers, and tactical fields. Renders a
 * square grid from the projected `state.cells` (rows of {piece, coord}); a cell
 * with a legal `place` action at its coordinate is clickable. The projected
 * state also carries a status line (whose turn / win / draw).
 *
 * Self-contained HTML/CSS/JS using only the host-provided VibeExperience SDK.
 */
import type { VisualStarter } from "./types.js";

export const GRID_BOARD_VISUAL_SOURCE = [
  "<style>",
  "  .xp-grid{font:14px/1.4 system-ui,sans-serif;color:#e5e5e5;padding:12px}",
  "  .xp-grid .status{margin-bottom:8px;font-weight:600}",
  "  .xp-grid .board{display:grid;gap:2px;background:#404040;padding:2px;border-radius:4px;width:fit-content}",
  "  .xp-grid .cell{width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:#262626;font-size:20px;border:none;color:#e5e5e5}",
  "  .xp-grid .cell.legal{cursor:pointer;background:#1e3a5f}",
  "  .xp-grid .cell.legal:hover{background:#2563eb}",
  "  .xp-grid .pending{color:#fbbf24;font-size:12px;margin-top:8px}",
  "</style>",
  '<div class="xp-grid" id="xp-root">',
  '  <div class="status" id="xp-status"></div>',
  '  <div class="board" id="xp-board"></div>',
  '  <div class="pending" id="xp-pending" style="display:none">waiting...</div>',
  "</div>",
  "<script>",
  "(function(){",
  "  var root=document.getElementById('xp-root');",
  "  var statusEl=document.getElementById('xp-status');",
  "  var boardEl=document.getElementById('xp-board');",
  "  var pendingEl=document.getElementById('xp-pending');",
  "  var xp;",
  "  function resize(){ if(xp){ xp.resize(root.scrollWidth,root.scrollHeight); } }",
  "  // Build a set of legal target coordinates from the projected actions.",
  "  function legalCoords(view){",
  "    var m={};var acts=(view&&view.actions)||[];",
  "    for(var i=0;i<acts.length;i++){if(acts[i].type==='place'&&acts[i].payload&&acts[i].payload.coord){m[acts[i].payload.coord]=1;}}",
  "    return m;",
  "  }",
  "  function render(view){",
  "    var s=(view&&view.state)||{};",
  "    statusEl.textContent=s.status||'';",
  "    var rows=s.cells||[];",
  "    var legal=legalCoords(view);",
  "    boardEl.innerHTML='';",
  "    boardEl.style.gridTemplateColumns='repeat('+(rows[0]?rows[0].length:0)+',44px)';",
  "    for(var r=0;r<rows.length;r++){for(var c=0;c<rows[r].length;c++){",
  "      (function(cell){",
  "        var b=document.createElement('button');b.className='cell';",
  "        b.textContent=cell.piece||'';",
  "        if(legal[cell.coord]){b.className+=' legal';b.onclick=function(){ if(xp) xp.act('place',{coord:cell.coord}); };}",
  "        boardEl.appendChild(b);",
  "      })(rows[r][c]);",
  "    }}",
  "    resize();",
  "  }",
  "  xp=window.VibeExperience.connect(render,{",
  "    onPending:function(phase){pendingEl.style.display=phase==='idle'?'none':'block';pendingEl.textContent=phase==='typing'?'opponent typing...':'thinking...';},",
  "    onError:function(err){statusEl.textContent='! '+(err.message||err.code);}",
  "    onLifecycle:function(ev){if(ev==='finish'){statusEl.textContent=statusEl.textContent+' (finished)';}}",
  "  });",
  "})();",
  "</script>",
].join("\n");

export const gridBoardStarter: VisualStarter = {
  id: "grid-board",
  label: "Grid / Board",
  description: "Cells, pieces, and coordinates with click-to-place. Suited to Tic-Tac-Toe, Sea Battle, Checkers, and tactical fields.",
  source: GRID_BOARD_VISUAL_SOURCE,
  fixtures: {
    setup: {
      state: { status: "Empty board — X to move", cells: [[{ piece: "", coord: "a1" }, { piece: "", coord: "a2" }, { piece: "", coord: "a3" }], [{ piece: "", coord: "b1" }, { piece: "", coord: "b2" }, { piece: "", coord: "b3" }], [{ piece: "", coord: "c1" }, { piece: "", coord: "c2" }, { piece: "", coord: "c3" }]] },
      actions: [{ type: "place", payload: { coord: "a1" } }, { type: "place", payload: { coord: "b2" } }, { type: "place", payload: { coord: "c3" } }], revision: 0, status: "active",
    },
    ordinary: {
      state: { status: "X to move", cells: [[{ piece: "X", coord: "a1" }, { piece: "", coord: "a2" }, { piece: "O", coord: "a3" }], [{ piece: "", coord: "b1" }, { piece: "X", coord: "b2" }, { piece: "", coord: "b3" }], [{ piece: "", coord: "c1" }, { piece: "", coord: "c2" }, { piece: "", coord: "c3" }]] },
      actions: [{ type: "place", payload: { coord: "a2" } }, { type: "place", payload: { coord: "c3" } }], revision: 3, status: "active",
    },
    pending: {
      state: { status: "O is thinking...", cells: [[{ piece: "X", coord: "a1" }, { piece: "", coord: "a2" }, { piece: "O", coord: "a3" }], [{ piece: "", coord: "b1" }, { piece: "X", coord: "b2" }, { piece: "", coord: "b3" }], [{ piece: "", coord: "c1" }, { piece: "", coord: "c2" }, { piece: "", coord: "c3" }]] },
      actions: [], revision: 3, status: "active",
    },
    error: {
      state: { status: "X to move", cells: [[{ piece: "X", coord: "a1" }, { piece: "", coord: "a2" }, { piece: "O", coord: "a3" }], [{ piece: "", coord: "b1" }, { piece: "X", coord: "b2" }, { piece: "", coord: "b3" }], [{ piece: "", coord: "c1" }, { piece: "", coord: "c2" }, { piece: "", coord: "c3" }]] },
      actions: [{ type: "place", payload: { coord: "a2" } }], revision: 3, status: "active",
    },
    completed: {
      state: { status: "X wins!", cells: [[{ piece: "X", coord: "a1" }, { piece: "X", coord: "a2" }, { piece: "X", coord: "a3" }], [{ piece: "", coord: "b1" }, { piece: "O", coord: "b2" }, { piece: "", coord: "b3" }], [{ piece: "", coord: "c1" }, { piece: "O", coord: "c2" }, { piece: "", coord: "c3" }]] },
      actions: [], revision: 6, status: "completed",
    },
  },
};
