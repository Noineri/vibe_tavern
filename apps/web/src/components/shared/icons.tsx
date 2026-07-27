import React from 'react';
import { Globe, Brain, Crop, FileText, Flame, Images, Send, Sparkles, Star } from 'lucide-react';

// Props forwarded so call sites passing `className` (e.g. "h-5 w-5 text-t3")
// actually apply — the previous `() => <svg/>` no-arg shape silently dropped
// them. Default `size`/`strokeWidth` per-icon preserve the pre-migration pixel
// weight (lucide's strokeWidth lives in its 24-space; values chosen so the
// effective px weight ≈ the former hand-rolled stroke).
export const Ic = {
  sun:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="3.2"/><line x1="8" y1="1" x2="8" y2="2.8"/><line x1="8" y1="13.2" x2="8" y2="15"/><line x1="1" y1="8" x2="2.8" y2="8"/><line x1="13.2" y1="8" x2="15" y2="8"/><line x1="3.2" y1="3.2" x2="4.3" y2="4.3"/><line x1="11.7" y1="11.7" x2="12.8" y2="12.8"/><line x1="11.7" y1="3.2" x2="12.8" y2="4.3"/><line x1="3.2" y1="11.7" x2="4.3" y2="12.8"/></svg>,
  moon:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 10.5A6.5 6.5 0 0 1 5.5 3a6.5 6.5 0 1 0 7.5 7.5z"/></svg>,
  // Coffee cup with handle + three steam wisps. SELF-DRAWN (intentionally not
  // migrated to lucide-react): the hollow-handle fill convention is part of the
  // app's visual language separating light (outline) from dark (filled) themes,
  // and lucide's `Coffee` lacks the hollowed handle subpath. See registry.ts.
  coffee:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6.67 1.33v1.33"/><path d="M9.33 1.33v1.33"/><path d="M4 1.33v1.33"/><path d="M10.67 5.33a0.67 0.67 0 0 1 0.67 0.67v5.33a2.67 2.67 0 0 1-2.67 2.67H4.67a2.67 2.67 0 0 1-2.67-2.67V6a0.67 0.67 0 0 1 0.67-0.67h9.33a2.67 2.67 0 1 1 0 5.33h-0.67"/></svg>,
  // Filled coffee cup — SELF-DRAWN (see `coffee` above): the handle is hollowed
  // via a second subpath + fillRule="evenodd" so the D-loop stays open against
  // the filled body. Icon convention: outlined = light theme, filled = dark.
  coffeeFilled:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6.67 1.33v1.33"/><path d="M9.33 1.33v1.33"/><path d="M4 1.33v1.33"/><path fill="currentColor" fillRule="evenodd" stroke="none" d="M10.67 5.33a0.67 0.67 0 0 1 0.67 0.67v5.33a2.67 2.67 0 0 1-2.67 2.67H4.67a2.67 2.67 0 0 1-2.67-2.67V6a0.67 0.67 0 0 1 0.67-0.67h9.33a2.67 2.67 0 1 1 0 5.33h-0.67ZM12.8 6a1.1 2 0 1 0 0 4a1.1 2 0 1 0 0-4"/></svg>,
  copy:()=><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6.5A1.5 1.5 0 0 0 3 11h2"/></svg>,
  edit:()=><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11.5 2.5l2 2L5 13l-2.5.5L3 11z"/></svg>,
  branch:()=><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M4 6v4"/><path d="M12 6v2.5A1.5 1.5 0 0 1 10.5 10H4"/></svg>,
  regen:()=><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.5 8A5.5 5.5 0 1 1 10 3H13.5"/><polyline points="10,3 13.5,3 13.5,6.5"/></svg>,
  caret:(d:string)=><svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" style={{transform:d==='l'?'rotate(180deg)':d==='d'?'rotate(90deg)':d==='u'?'rotate(270deg)':undefined}}><polyline points="6 3 11 8 6 13"/></svg>,
  settings:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M11.54 4.46l1.41-1.41M3.05 12.95l1.41-1.41"/></svg>,
  menu:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="10" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>,
  plus:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/></svg>,
  tool:()=><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.76 3.76l1.06 1.06M11.18 11.18l1.06 1.06M11.18 3.76l1.06 1.06M3.76 11.18l1.06 1.06"/></svg>,
  del:()=><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="2 4 14 4"/><path d="M5 4V2.5h6V4"/><rect x="3" y="4" width="10" height="9.5" rx="1"/><line x1="6.5" y1="7" x2="6.5" y2="10.5"/><line x1="9.5" y1="7" x2="9.5" y2="10.5"/></svg>,
  close:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>,
  wrench:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 2a4 4 0 0 0-3.9 4.8L2 11a1.5 1.5 0 0 0 0 2.1l.9.9A1.5 1.5 0 0 0 5 14l4.2-4.1A4 4 0 1 0 10 2z"/></svg>,
  key:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6" cy="7" r="3.5"/><line x1="8.5" y1="9.5" x2="14" y2="15"/><line x1="11" y1="12" x2="13" y2="14"/></svg>,
  sliders:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/><circle cx="5" cy="4" r="1.8" fill="var(--bg)" strokeWidth="1.5"/><circle cx="10" cy="8" r="1.8" fill="var(--bg)" strokeWidth="1.5"/><circle cx="6" cy="12" r="1.8" fill="var(--bg)" strokeWidth="1.5"/></svg>,
  check:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="2 8 6 12 14 4"/></svg>,
  book:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3"/><path d="M3 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1"/><line x1="8" y1="2" x2="8" y2="14"/></svg>,
  user:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="5.5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>,
  trace:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="2,12 5,8 8,10 11,5 14,7"/><circle cx="14" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>,
  terminal:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="3,4 7,8 3,12"/><line x1="8" y1="12" x2="14" y2="12"/></svg>,
  import:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 12V3M4 7l4-4 4 4M2 14h12"/></svg>,
  search:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14.5" y2="14.5"/></svg>,
  stack:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><polygon points="8 2 2 5 8 8 14 5 8 2"/><polyline points="2 8 8 11 14 8"/><polyline points="2 11 8 14 14 11"/></svg>,
  // Lucide `Globe` (was a hand-rescaled 16×16 copy; now native lucide).
  globe: (props?: { className?: string }) => <Globe size={13} strokeWidth={2} {...props} />,
  alert:()=><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2L1 14h14L8 2z"/><line x1="8" y1="6" x2="8" y2="10"/><circle cx="8" cy="12.5" r="0.5" fill="currentColor" stroke="none"/></svg>,
  ellipsis:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>,
  download:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M8 2v9M4 7l4 4 4-4M2 14h12"/></svg>,
  // Lucide `Brain`, native 24×24, stroke 2 (lucide default — consistent with the
  // rest of the migrated set; the former hand-rolled copy used 1.5).
  brain: (props?: { className?: string }) => <Brain size={14} strokeWidth={2} {...props} />,
  // Lucide `Sparkles` (three 4-point stars), stroke 2 (lucide default,
  // consistent with the migrated set).
  sparkles: (props?: { className?: string }) => <Sparkles size={13} strokeWidth={2} {...props} />,
  // Filled sparkles — same Lucide `Sparkles` with fill + zero stroke.
  // Icon convention: outlined = light theme, filled = dark theme.
  sparklesFilled: (props?: { className?: string }) => <Sparkles size={13} fill="currentColor" stroke="none" strokeWidth={0} {...props} />,
  // Lucide `Star` (outline + filled via fill prop).
  star: (props?: { className?: string }) => <Star size={13} strokeWidth={2} {...props} />,
  starFilled: (props?: { className?: string }) => <Star size={13} fill="currentColor" stroke="none" strokeWidth={0} {...props} />,
  help:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M6 6a2 2 0 0 1 3.5 1.3c0 1.2-1.5 1.5-1.5 2.2"/><circle cx="8" cy="12" r=".5" fill="currentColor"/></svg>,
  crown:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12l1-7 3.5 3L8 4l1.5 4L13 5l1 7H2z"/><line x1="2" y1="13" x2="14" y2="13"/></svg>,
  floppy:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="1"/><rect x="5" y="2" width="6" height="4" rx="0.5"/><rect x="4.5" y="9" width="7" height="5" rx="0.5"/></svg>,
  eye:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>,
  chat:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5l-3 3V4z"/></svg>,
  plug:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v4M6 2v4M5 6h6M6 6v3.5a2.5 2.5 0 0 0 5 0V6"/><path d="M8.5 12v2M6 13h5"/></svg>,
  expand:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 5 1 1 5 1"/><polyline points="11 1 15 1 15 5"/><polyline points="15 11 15 15 11 15"/><polyline points="5 15 1 15 1 11"/></svg>,
  // Lucide `Crop` (was a hand-rescaled 16×16 copy; now native lucide).
  // Used by the "adjust thumbnail" action in the character editor.
  crop: (props?: { className?: string }) => <Crop size={13} strokeWidth={2} {...props} />,
  sortAlpha:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2v8.5"/><path d="m1.2 8.8 1.8 1.8 1.8-1.8"/><path d="M7 4h6"/><path d="M7 8h4"/><path d="M7 12h2"/></svg>,
  sortRecent:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4 8 8 10.8 9.6"/></svg>,
  filter:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h12l-4.5 5v6.5l-3-1.5V8L2 3z"/></svg>,
  phone:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="1" width="8" height="14" rx="1.5"/><line x1="7" y1="13" x2="9" y2="13"/></svg>,
  widthNarrow:()=><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><line x1="2" y1="3" x2="10" y2="3"/><line x1="2" y1="6.5" x2="8.5" y2="6.5"/><line x1="2" y1="10" x2="10" y2="10"/><line x1="2" y1="13.5" x2="7" y2="13.5"/></svg>,
  widthMedium:()=><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><line x1="2" y1="3" x2="12.5" y2="3"/><line x1="2" y1="6.5" x2="11" y2="6.5"/><line x1="2" y1="10" x2="12.5" y2="10"/><line x1="2" y1="13.5" x2="9.5" y2="13.5"/></svg>,
  widthWide:()=><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><line x1="1" y1="3" x2="14.5" y2="3"/><line x1="1" y1="6.5" x2="13" y2="6.5"/><line x1="1" y1="10" x2="14.5" y2="10"/><line x1="1" y1="13.5" x2="11.5" y2="13.5"/></svg>,
  target:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3.5"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="1" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="15" y2="8"/></svg>,
  paperclip:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 7.5l-6 6a3.5 3.5 0 1 1-5-5l6-6a2 2 0 1 1 3 3l-6 6a.75.75 0 1 1-1-1l6-6"/></svg>,
  // Lucide `FileText`, native 24×24, stroke 2 for toolbar legibility at 13px.
  // Used by the mobile prompt-preset quick-switcher in InputArea.
  fileText: (props?: { className?: string }) => <FileText size={13} strokeWidth={2} {...props} />,
  // Lucide `Flame`, native 24×24, stroke 2 for picker legibility at 13px.
  flame: (props?: { className?: string }) => <Flame size={13} strokeWidth={2} {...props} />,
  // Filled flame — same Lucide `Flame` with fill + zero stroke.
  // Icon convention: outlined = light theme, filled = dark theme.
  flameFilled: (props?: { className?: string }) => <Flame size={13} fill="currentColor" stroke="none" strokeWidth={0} {...props} />,
  // Lucide `Images` (gallery stack). Used by the TopBar "Media" button (R5/D1).
  images: (props?: { className?: string }) => <Images size={13} strokeWidth={2} {...props} />,
  // Lucide `Send` (paper-plane). Used by the Media send-to-chat action (R5/D1).
  // NOTE: this is lowercase `send`; the PascalCase `Icons.Send` proxy mapping
  // still routes to `terminal` for backward compat. Use `Icons.send` for the
  // paper-plane glyph.
  send: (props?: { className?: string }) => <Send size={13} strokeWidth={2} {...props} />,
  // Up arrow inside a circle — used by the UpdateBadge (TopBar) to signal that
  // a newer GitHub release is available. Stroke-only so it inherits the
  // accent color in every theme.
  arrowUpCircle:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="11" x2="8" y2="5"/><polyline points="5.5 7.5 8 5 10.5 7.5"/></svg>,
  // Clipboard with list lines — the Scene Tracker section icon (INS-2).
  clipboard:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="1.5" width="6" height="2.5" rx="0.5"/><path d="M10.5 2.5h2v12h-9v-12h2"/><path d="M5.5 8h5M5.5 11h3"/></svg>,
  // Checkmark in a circle — the Objective Tracker section icon (INS-2).
  checkCircle:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="5 8 7 10 11 6"/></svg>,
  // Dice / Fate Die (DICE-F6) — D20 hexagon outline with an inner triangle facet.
  dice:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.33 L13.67 4.67 L13.67 11.33 L8 14.67 L2.33 11.33 L2.33 4.67 Z"/><path d="M8 5 L11 10 L5 10 Z" strokeOpacity="0.45"/></svg>,
  // Plus inside a rectangular frame — the "custom injection" slot-category
  // icon (APC-3a). Distinguishes user-added prompt blocks from built-ins.
  plusInFrame:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5"/><line x1="8" y1="5.5" x2="8" y2="10.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/></svg>,
  // User bust inside a ring — the "persona" slot-category icon (APC-3a).
  // Distinct from the plain `user` glyph (character category): the ring marks
  // the user-persona context, not the character.
  circleUser:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="6.3" r="1.9"/><path d="M4.3 12.6c.6-1.7 2-2.7 3.7-2.7s3.1 1 3.7 2.7"/></svg>,
  // Book + anchor composite glyph — the "lorebook anchor" slot-category icon
  // (APC-3a): a bound lorebook (book) pinned at a canvas position (anchor).
  // Single SVG (book left, anchor right) rather than two overlaid glyphs so it
  // stays crisp at 13px without absolute-positioned badges.
  loreAnchor:()=><svg width="14" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h4a1 1 0 0 1 1 1v9a1 1 0 0 0-1-1H2.5A.5.5 0 0 1 2 10.5V3.5A.5.5 0 0 1 2.5 3z"/><path d="M7 4v9"/><circle cx="11.5" cy="4.5" r="1.2"/><line x1="11.5" y1="5.7" x2="11.5" y2="13"/><path d="M9 10.2a2.5 2.5 0 0 0 5 0"/><line x1="10" y1="7.8" x2="13" y2="7.8"/></svg>,
};

// Icon props actually used at call sites: `className` (any icon) and `direction`
// (Caret only). A plain functional type (not React.FC) keeps it overlap-
// compatible with the `Ic` values (`() => JSX.Element`, no args) for the proxy
// cast below, while still accepting the Caret adapter that reads `direction`.
type IconComponent = (props?: { direction?: string; className?: string }) => React.ReactElement;

// Backward-compat proxy: Icons.XXX → Ic.xxx
// Handles PascalCase→camelCase, Trash→del, Send→terminal, Caret prop adapter
export const Icons: Record<string, IconComponent> = new Proxy(Ic as unknown as Record<string, IconComponent>, {
  get(target, prop: string) {
    // Special key mappings
    if (prop === 'Trash') return target.del;
    if (prop === 'Send') return target.terminal;
    // Caret adapter: prod calls <Icons.Caret direction="d" />
    // maket Ic.caret expects a plain string: Ic.caret('d')
    if (prop === 'Caret') {
      return (props: { direction?: string }) => Ic.caret(props.direction ?? 'r');
    }
    // Direct match first
    if (target[prop]) return target[prop];
    // PascalCase → camelCase fallback
    const lower = prop.charAt(0).toLowerCase() + prop.slice(1);
    if (target[lower]) return target[lower];
    return undefined;
  }
}) as Record<string, IconComponent>;
