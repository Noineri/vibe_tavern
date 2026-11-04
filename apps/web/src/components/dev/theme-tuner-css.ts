/**
 * ThemeTuner tool-chrome stylesheet (extracted from ThemeTuner.tsx, CNR-8r
 * arch-gate extraction).
 *
 * The tuner's OWN chrome uses this fixed dark palette (.tt-* classes) so it stays
 * legible no matter how unhinged the tuned colors get; only the preview pane
 * is themed. Scroll chrome (CNR-8r): the tool panes (.tt-scroll/.tt-stage/
 * .tt-editor) and the export textarea ride the app-wide shared thin lanes
 * (3px/5px) — the only baked native scrollbar rules left are the
 * preview-window replicas (.tt-win-*), the sanctioned CNR-8a excluded-
 * by-design exception (fixed sample content; see
 * docs/architecture/components.md).
 */

// ─── Tool-chrome CSS (fixed dark palette, never themed) ─────────────────

export const TT_CSS = `
.tt-root{display:flex;height:100vh;width:100vw;overflow:hidden;background:#16140f;color:#c8bca8;font-family:'Inter',system-ui,sans-serif;font-size:13px}

/* controls */
.tt-controls{width:300px;min-width:300px;background:#1e1c18;border-right:1px solid #34302a;display:flex;flex-direction:column;overflow:hidden}
.tt-head{padding:14px 18px 11px;border-bottom:1px solid #34302a}
.tt-head h1{font-size:13px;font-weight:600;color:#e2d6c2;letter-spacing:.04em;text-transform:uppercase}
.tt-head p{font-size:11px;color:#6f655b;margin-top:3px}
.tt-mode{display:flex;gap:6px;padding:10px 14px 0}
.tt-mode-btn{flex:1;padding:7px 4px;background:#25221c;border:1px solid #34302a;border-radius:5px;color:#8a7e70;font-size:11.5px;cursor:pointer;font-family:inherit;transition:all .12s}
.tt-mode-btn:hover{color:#c8bca8;border-color:#4a443c}
.tt-mode-btn.active{background:#b8763e;color:#1a1712;border-color:#b8763e;font-weight:600}
.tt-field{display:block;padding:10px 18px 4px}
.tt-field span{display:block;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6f655b;margin-bottom:5px}
.tt-field select,.tt-field input{width:100%;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;border-radius:5px;padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none}
.tt-field select:focus,.tt-field input:focus{border-color:#b8763e}
.tt-scroll{flex:1}
.tt-scroll-content{padding:8px 12px 14px}
.tt-group{margin-bottom:14px}
.tt-group-title{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8a6a3a;margin:6px 4px 6px;padding-bottom:4px;border-bottom:1px solid #2a2620}
.tt-group-head{display:flex;align-items:center;justify-content:space-between;margin:6px 4px 6px;padding-bottom:4px;border-bottom:1px solid #2a2620}
.tt-group-head .tt-group-title{margin:0;padding:0;border:none}
.tt-layer-label{font-size:10px;color:#6f655b;letter-spacing:.04em;margin:7px 4px 5px}
.tt-layer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #2a2620}
.tt-layer-head .tt-layer-label{margin:0 4px}
.tt-layer-add{background:#25221c;border:1px solid #4a443c;color:#c8bca8;border-radius:5px;font-size:10.5px;line-height:1;padding:5px 8px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:all .12s}
.tt-layer-add:hover:not(:disabled){background:#b8763e;color:#1a1712;border-color:#b8763e}
.tt-layer-add:disabled{opacity:.35;cursor:default}
.tt-blob-empty{font-size:11px;color:#5e544a;padding:7px 4px 3px;font-style:italic;line-height:1.45}
.tt-swatch-row{display:flex;align-items:center;gap:4px;width:100%;padding:5px 4px 5px 6px;border-radius:6px;background:transparent;border:1px solid transparent;text-align:left;font-family:inherit}
.tt-swatch-row-main{display:flex;align-items:center;gap:9px;flex:1;min-width:0;background:transparent;border:none;cursor:pointer;font-family:inherit;text-align:left;padding:0}
.tt-swatch-del{flex-shrink:0;background:transparent;border:none;color:#5e544a;font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px;font-family:inherit}
.tt-swatch-del:hover:not(:disabled){color:#c84545;background:#3a2018}
.tt-swatch-del:disabled{opacity:.25;cursor:default}
.tt-swatch-row:hover{background:#25221c}
.tt-swatch-row.active{background:#2a2620;border-color:#4a443c}
.tt-swatch{width:22px;height:22px;border-radius:5px;border:1px solid #00000040;flex-shrink:0;box-shadow:inset 0 0 0 1px #ffffff14}
.tt-ball-marker{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:#33281f;border:1px solid #5a4432;color:#c99055;font-size:10px;font-weight:700}
.tt-base-swatch{border-radius:50%}
.tt-swatch-name{flex:1;min-width:0;font-size:12px;color:#c8bca8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tt-swatch-val{font-size:9.5px;font-family:'JetBrains Mono',monospace;color:#5e544a;white-space:nowrap}
.tt-foot{padding:10px 14px;border-top:1px solid #34302a}

/* shared buttons */
.tt-export{width:100%;padding:9px;background:#b8763e;color:#1a1712;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.tt-export:hover{background:#c88450}
.tt-reset{padding:8px 14px;background:transparent;color:#8a7e70;border:1px solid #3a352e;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit}
.tt-reset:hover{color:#c8bca8;border-color:#4a443c}

/* stage */
.tt-stage{flex:1;background:#12110e}
.tt-stage-content{padding:20px 24px 32px}
.tt-stage-label,.tt-demos-label{font-size:10px;color:#4a4038;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px}
.tt-stage-label{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tt-stage-actions{display:flex;align-items:center;gap:6px}
.tt-lava-preview-modes{display:flex;align-items:center;padding:2px;background:#1e1c18;border:1px solid #3a352e;border-radius:6px}
.tt-lava-preview-modes button{background:transparent;border:0;color:#8a7e70;border-radius:4px;padding:3px 9px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap}
.tt-lava-preview-modes button.active{background:#b8763e;color:#1a1712;font-weight:600}
.tt-drift-toggle{background:#25221c;border:1px solid #3a352e;color:#c8bca8;border-radius:5px;padding:4px 11px;font-size:11px;letter-spacing:0;text-transform:none;cursor:pointer;font-family:inherit;transition:all .12s}
.tt-drift-toggle:hover:not(:disabled),.tt-drift-toggle.active{border-color:#b8763e;color:#e2d6c2;background:#3a2a1d}
.tt-drift-toggle:disabled{opacity:.4;cursor:default}
.tt-demos-label{margin-top:26px}

/* preview window (themed by tokens) */
.tt-window{--tt-message-width:820px;display:flex;height:clamp(600px,86vh,1080px);position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--border);box-shadow:0 24px 60px #00000066;background:var(--page-bg, var(--bg))}
/* Drift replicates the live lava animation: oversized background (180%) panned
   via background-position, so the blobs appear to float. Faithful to the
   theme's own @keyframes (*-lava-drift on body) but applied to the preview
   element with a generic name so it works for any theme that has blobs. */
.tt-window-drift{background-size:180% 180%;animation:tt-drift 20s ease-in-out infinite}
@keyframes tt-drift{0%,100%{background-position:0% 0%,100% 100%,50% 50%}50%{background-position:100% 50%,0% 50%,50% 0%}}
.tt-win-sidebar{width:188px;min-width:188px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);position:relative;z-index:1}
.tt-win-brand{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border)}
.tt-win-logo{width:22px;height:22px;border-radius:5px;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.tt-win-logo-name{font-size:13px;font-weight:600;color:var(--t1)}
.tt-win-section{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);padding:10px 12px 3px}
.tt-win-list{padding:0 6px;flex:1;overflow-y:auto}
.tt-win-item{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:6px;color:var(--t2);transition:background-color .1s,color .1s}
.tt-win-item:hover,.tt-window-show-states .tt-win-item.preview-hover{background:var(--s2);color:var(--t1)}
.tt-win-item.active,.tt-win-item.active:hover{background:var(--accent-dim);color:var(--accent-t)}
.tt-win-item-name{font-size:12px;color:inherit}
.tt-win-avatar{width:32px;height:32px;border-radius:50%;background:var(--s3);color:var(--t2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0}
.tt-win-avatar-active{background:var(--accent);color:var(--on-accent)}
.tt-win-avatar-sm{width:20px;height:20px;border-radius:50%;background:var(--s3);color:var(--t2);display:inline-flex;align-items:center;justify-content:center;font-size:9px}
.tt-win-avatar-xs{width:16px;height:16px;border-radius:50%;background:var(--s3);color:var(--t2);display:inline-flex;align-items:center;justify-content:center;font-size:8px}
.tt-win-persona{padding:9px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:7px}
.tt-win-persona-label{font-size:11px;color:var(--t3)}

.tt-win-main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;position:relative;z-index:1}
.tt-win-topbar{display:flex;height:60px;align-items:center;gap:9px;padding:0 14px;background:var(--surface);border-bottom:1px solid var(--border)}
.tt-win-top-avatar{width:44px;height:44px;border-radius:50%;background:var(--s3);color:var(--t2);display:flex;align-items:center;justify-content:center;font-size:12px;font-family:var(--font-body);font-style:italic;flex-shrink:0;border:1.5px solid transparent}
.tt-win-name{font-size:var(--ui-fs);font-weight:500;color:var(--t1);white-space:nowrap}
.tt-win-memory{display:flex;align-items:center;gap:5px;border:1px solid var(--border);background:var(--s2);color:var(--t2);border-radius:999px;padding:3px 8px;font-size:11px;white-space:nowrap;transition:border-color .15s,color .15s}
.tt-win-memory:hover,.tt-window-show-states .tt-win-memory.preview-hover{border-color:var(--accent);color:var(--accent-t)}
.tt-win-memory i,.tt-win-provider i{width:6px;height:6px;border-radius:50%;background:var(--success);flex-shrink:0}
.tt-win-provider{display:flex;align-items:center;gap:5px;border:1px solid transparent;background:transparent;color:var(--t2);border-radius:4px;padding:4px 7px;font-size:10.5px;white-space:nowrap;transition:background-color .15s,border-color .15s,color .15s}
.tt-win-provider b{color:var(--t3);font-weight:400}
.tt-win-provider:hover,.tt-window-show-states .tt-win-provider.preview-hover{border-color:var(--border);background:var(--s2);color:var(--t1)}
.tt-win-mode-switch{margin-left:auto;border:0;border-radius:999px;background:var(--mode-switch-bg,var(--accent-dim));color:var(--mode-switch-text,var(--accent-t));padding:4px 12px;font-size:13px;font-weight:500;cursor:pointer;transition:background-color .15s,color .15s}
.tt-win-mode-switch:hover,.tt-window-show-states .tt-win-mode-switch.preview-hover{background:var(--mode-switch-hover-bg,var(--accent-hover));color:var(--mode-switch-hover-text,var(--accent-t))}

.tt-win-messages{flex:1;overflow-y:auto;padding:20px 0;display:flex;flex-direction:column;gap:18px}
/* Match production MessageShell: the scroller stays full-width, but every
   message gets a centred max-width frame with 32px outer gutters and 28px
   inner padding. ThemeTuner does not mount the settings hook that normally
   writes --mw, so use its production-default medium width (820px) locally. */
.tt-msg{position:relative;width:100%;max-width:min(calc(var(--tt-message-width) + 160px),calc(100% - 64px));margin-inline:auto;padding:10px 28px}
.tt-msg-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;color:var(--accent-t);opacity:.85}
.tt-msg-avatar{width:44px;height:44px;border-radius:50%;background:var(--s3);color:var(--t3);display:flex;align-items:center;justify-content:center;font-family:var(--font-body);font-style:italic;font-size:calc(var(--ui-fs) + 1px);flex-shrink:0}
.tt-msg-author{font-size:calc(var(--ui-fs) - 2px);font-weight:600;letter-spacing:.04em;color:inherit}
.tt-msg-body{font-family:var(--font-body);font-size:calc(var(--mfs));line-height:1.65;color:var(--msg-t1)}
.tt-msg-meta{margin-top:4px;font-size:calc(var(--ui-fs) - 4px);color:color-mix(in srgb,var(--t3) 50%,transparent);display:flex;gap:8px}
.tt-msg-actions{display:flex;align-items:center;gap:1px;margin-top:6px;opacity:0;transition:opacity .15s;color:var(--t3);font-size:calc(var(--ui-fs) - 3px)}
.tt-msg-actions span{padding:3px 7px;border-radius:4px}
.tt-msg-actions span:hover{background:var(--s2);color:var(--t2)}
.tt-msg:hover .tt-msg-actions,.tt-window-show-states .tt-msg.preview-hover .tt-msg-actions{opacity:1}
.tt-msg-user-head{display:flex;align-items:center;justify-content:flex-start;flex-direction:row-reverse;gap:10px;margin-bottom:12px;color:var(--t3)}
.tt-msg-user-name{font-size:calc(var(--ui-fs) - 2px);font-weight:600;letter-spacing:.04em}
.tt-msg-user-body{background:var(--user-bg);border-radius:6px;padding:13px 16px;width:100%;font-family:var(--font-body);font-size:calc(var(--mfs));line-height:1.65;color:var(--msg-t1)}
.tt-msg-user-content{opacity:.88}
.tt-msg-user-meta{margin-top:4px;font-size:calc(var(--ui-fs) - 4px);color:color-mix(in srgb,var(--t3) 50%,transparent);text-align:right}

.tt-win-inputbar{border-top:1px solid var(--border);background:var(--surface);padding:10px 14px}
.tt-win-textarea{background:var(--input-bg,var(--bg));border:1px solid var(--border);border-radius:8px;padding:13px 16px;font-family:var(--font-body);font-size:15.5px;color:var(--t4);margin-bottom:7px}
.tt-win-inputbar-bottom{display:flex;align-items:center;justify-content:space-between}
.tt-win-speakas{font-size:11px;color:var(--t3);display:flex;align-items:center;gap:5px}
.tt-win-tokens{margin-left:10px;font-size:11px;color:var(--t4)}
.tt-win-send{background:var(--accent);color:var(--on-accent);border:none;border-radius:5px;padding:7px 16px;font-size:13px;font-weight:500;cursor:pointer}

/* demo strip */
.tt-demos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.tt-demo-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px}
.tt-demo-card-label{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);margin-bottom:9px}
.tt-code{margin:0;font-size:12px;color:var(--msg-t2)}
.tt-badges{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:11px}
.tt-badge{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid;font-weight:500}
.tt-badge-success{color:var(--success-text);background:var(--success-dim);border-color:var(--success-dim)}
.tt-badge-info{color:var(--info-text);background:var(--info-dim);border-color:var(--info-dim)}
.tt-badge-warning{color:var(--warning-text);background:var(--warning-dim);border-color:var(--warning-dim)}
.tt-badge-danger{color:var(--danger-text);background:var(--danger-dim);border-color:var(--danger-dim)}
.tt-buttons{display:flex;gap:8px}
.tt-btn-accent{background:var(--accent);color:var(--on-accent);border:none;border-radius:5px;padding:7px 14px;font-size:12.5px;font-weight:500;cursor:pointer}
.tt-btn-danger{background:var(--danger);color:var(--on-danger);border:none;border-radius:5px;padding:7px 14px;font-size:12.5px;font-weight:500;cursor:pointer}
.tt-frost-bg{border-radius:8px;padding:18px;min-height:96px;display:flex;align-items:center}
.tt-frost-panel{background:var(--glass-bg,var(--surface));backdrop-filter:blur(var(--glass-blur,0px)) saturate(180%) brightness(110%);-webkit-backdrop-filter:blur(var(--glass-blur,0px)) saturate(180%) brightness(110%);border:1px solid var(--border);border-radius:8px;padding:10px 13px;font-size:12px;color:var(--t2);width:100%}
.tt-frost-panel code{font-family:'JetBrains Mono',monospace;color:var(--accent-t);font-size:11px}
.tt-frost-panel p{margin:5px 0 0;font-size:11px;color:var(--t3)}
.tt-selection-sample{display:inline-block;background:var(--sel-bg);color:var(--sel-text);padding:5px 8px;border-radius:4px;font-family:var(--font-body);font-size:14px;margin-bottom:10px}
.tt-token-samples{display:flex;flex-wrap:wrap;gap:7px;font-size:11px}
.tt-token-samples span{padding:4px 7px;border-radius:4px}
.tt-accent-mid-sample{background:var(--accent-mid);color:var(--on-accent)}
.tt-diff-remove{background:var(--danger-strong);color:var(--t1)}
.tt-diff-add{background:var(--success-strong);color:var(--t1)}

/* editor */
.tt-editor{width:332px;min-width:332px;background:#1e1c18;border-left:1px solid #34302a}
.tt-editor-inner{padding:18px}
.tt-ed-name{font-size:15px;font-weight:600;color:#e2d6c2;font-family:'JetBrains Mono',monospace}
.tt-ed-hint{font-size:11.5px;color:#6f655b;margin-top:3px;margin-bottom:14px}
.tt-ed-preview{width:100%;height:54px;border-radius:7px;border:1px solid #00000040;margin-bottom:14px;box-shadow:inset 0 0 0 1px #ffffff14}
.tt-ed-native{display:flex;align-items:center;gap:9px;margin-bottom:16px}
.tt-ed-native input[type=color]{width:44px;height:36px;border:1px solid #3a352e;border-radius:6px;background:#25221c;cursor:pointer;padding:3px}
.tt-ed-native input[type=color]::-webkit-color-swatch{border:none;border-radius:3px}
.tt-ed-native input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.tt-ed-hex{flex:1;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;font-family:'JetBrains Mono',monospace;font-size:12.5px;border-radius:5px;padding:8px 10px;outline:none;text-transform:lowercase}
.tt-ed-hex:focus{border-color:#b8763e}
.tt-slider-row{margin-bottom:13px}
.tt-slider-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;font-size:11px;color:#8a7e70;font-weight:500}
.tt-slider-num{width:60px;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;font-family:'JetBrains Mono',monospace;font-size:11.5px;border-radius:4px;padding:2px 6px;text-align:right;outline:none}
.tt-slider-num:focus{border-color:#b8763e}
.tt-slider{-webkit-appearance:none;appearance:none;width:100%;height:10px;border-radius:5px;outline:none;cursor:pointer;border:1px solid #2a2620}
.tt-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #3a352e;box-shadow:0 1px 4px #00000066;cursor:pointer}
.tt-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #3a352e;cursor:pointer}
.tt-ed-string{margin-top:6px;padding:8px 10px;background:#100f0b;border:1px solid #2a2620;border-radius:5px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#c89a60;word-break:break-all}
.tt-ed-sep{height:1px;background:#2a2620;margin:14px 0}
.tt-gradient-kinds{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:0 0 14px}
.tt-gradient-kinds button,.tt-gradient-stops button{background:#25221c;border:1px solid #3a352e;color:#8a7e70;border-radius:5px;padding:7px 5px;font-size:11px;cursor:pointer;font-family:inherit}
.tt-gradient-kinds button.active,.tt-gradient-stops button.active{background:#3a2a1d;border-color:#b8763e;color:#e2d6c2}
.tt-gradient-stops{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:14px}
.tt-lamp-light{margin:4px 4px 10px}
.tt-lamp-light .tt-gradient-kinds{margin:6px 0 0}
.tt-gradient-stops button{display:flex;align-items:center;justify-content:center;gap:6px}
.tt-gradient-stops button span{width:14px;height:14px;border-radius:4px;border:1px solid #00000040}
.tt-gradient-solid-note{padding:12px;background:#25221c;border:1px solid #34302a;border-radius:6px;color:#8a7e70;font-size:12px;line-height:1.55}
.tt-gradient-solid-note code{color:#c89a60;font-family:'JetBrains Mono',monospace}
.tt-ed-reset{margin-top:12px;width:100%;padding:7px;background:transparent;color:#8a7e70;border:1px solid #3a352e;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit}
.tt-ed-reset:hover{color:#c8bca8;border-color:#4a443c}
.tt-comment{margin-top:12px}
.tt-comment-regen{background:transparent;border:1px solid #3a352e;color:#8a7e70;border-radius:4px;padding:2px 7px;font-size:10.5px;cursor:pointer;font-family:inherit}
.tt-comment-regen:hover{color:#c8bca8;border-color:#4a443c}
.tt-comment-input{width:100%;background:#25221c;border:1px solid #3a352e;color:#e2d6c2;font-size:12.5px;border-radius:5px;padding:8px 10px;outline:none;margin-top:5px}
.tt-comment-input:focus{border-color:#b8763e}
.tt-comment-input::placeholder{color:#5e544a;font-style:italic}
.tt-editor-empty{padding:40px 24px;text-align:center;color:#5e544a}
.tt-editor-empty-icon{font-size:30px;margin-bottom:14px;color:#3a352e}
.tt-editor-empty p{font-size:12.5px;color:#8a7e70;margin-bottom:10px}
.tt-editor-empty-sub{font-size:11px;color:#5e544a;line-height:1.7}

/* export modal */
.tt-modal-overlay{position:fixed;inset:0;background:#000000a8;z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px}
.tt-modal{background:#1a1712;border:1px solid #3a302a;border-radius:9px;width:680px;max-width:100%;max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.tt-modal-head{padding:13px 16px;border-bottom:1px solid #3a302a;display:flex;align-items:center;justify-content:space-between}
.tt-modal-head span{font-size:13px;font-weight:600;color:#e2d6c2}
.tt-modal-x{background:transparent;border:none;color:#7a6e60;font-size:20px;cursor:pointer;line-height:1}
.tt-modal-x:hover{color:#c8bca8}
.tt-modal-text{flex:1;overflow-y:auto;padding:15px 16px;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#c8b89a;background:#100f0b;border:none;outline:none;line-height:1.6;resize:none;white-space:pre}
.tt-modal-foot{padding:11px 16px;border-top:1px solid #3a302a;display:flex;gap:9px;justify-content:flex-end}
.tt-modal-foot .tt-export{width:auto;padding:8px 18px}

/* scrollbars — CNR-8r: the tool panes (.tt-scroll/.tt-stage/.tt-editor) and
   the export textarea ride the app-wide shared thin lanes (3px/5px, themed
   thumb); their baked 7px rules are gone. The ONLY baked native chrome left
   is the preview-window replicas below: fixed sample content, excluded by
   design in the CNR-8a inventory ("the theme-tuner's own baked preview
   windows unless they truly overflow in use") — recorded as the sanctioned
   exception in docs/architecture/components.md. */
.tt-win-messages::-webkit-scrollbar,.tt-win-list::-webkit-scrollbar{width:7px}
.tt-win-messages::-webkit-scrollbar-thumb,.tt-win-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

@media (max-width:1180px){
  .tt-demos{grid-template-columns:1fr}
}
`;
