import React from 'react';

export const Ic = {
  sun:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="3.2"/><line x1="8" y1="1" x2="8" y2="2.8"/><line x1="8" y1="13.2" x2="8" y2="15"/><line x1="1" y1="8" x2="2.8" y2="8"/><line x1="13.2" y1="8" x2="15" y2="8"/><line x1="3.2" y1="3.2" x2="4.3" y2="4.3"/><line x1="11.7" y1="11.7" x2="12.8" y2="12.8"/><line x1="11.7" y1="3.2" x2="12.8" y2="4.3"/><line x1="3.2" y1="11.7" x2="4.3" y2="12.8"/></svg>,
  moon:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 10.5A6.5 6.5 0 0 1 5.5 3a6.5 6.5 0 1 0 7.5 7.5z"/></svg>,
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
  alert:()=><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2L1 14h14L8 2z"/><line x1="8" y1="6" x2="8" y2="10"/><circle cx="8" cy="12.5" r="0.5" fill="currentColor" stroke="none"/></svg>,
  ellipsis:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>,
  download:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M8 2v9M4 7l4 4 4-4M2 14h12"/></svg>,
  brain:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>,
  star:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l2 4.1 4.5.65-3.25 3.17.77 4.48L8 11.78 3.98 13.9l.77-4.48L1.5 6.25 6 5.6 8 1.5z"/></svg>,
  starFilled:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l2 4.1 4.5.65-3.25 3.17.77 4.48L8 11.78 3.98 13.9l.77-4.48L1.5 6.25 6 5.6 8 1.5z"/></svg>,
  help:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M6 6a2 2 0 0 1 3.5 1.3c0 1.2-1.5 1.5-1.5 2.2"/><circle cx="8" cy="12" r=".5" fill="currentColor"/></svg>,
  crown:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12l1-7 3.5 3L8 4l1.5 4L13 5l1 7H2z"/><line x1="2" y1="13" x2="14" y2="13"/></svg>,
  floppy:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="1"/><rect x="5" y="2" width="6" height="4" rx="0.5"/><rect x="4.5" y="9" width="7" height="5" rx="0.5"/></svg>,
  eye:()=><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>,
  chat:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5l-3 3V4z"/></svg>,
  plug:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2v4M6 2v4M5 6h6M6 6v3.5a2.5 2.5 0 0 0 5 0V6"/><path d="M8.5 12v2M6 13h5"/></svg>,
  expand:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 5 1 1 5 1"/><polyline points="11 1 15 1 15 5"/><polyline points="15 11 15 15 11 15"/><polyline points="5 15 1 15 1 11"/></svg>,
  phone:()=><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="1" width="8" height="14" rx="1.5"/><line x1="7" y1="13" x2="9" y2="13"/></svg>,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = React.FC<any>;

// Backward-compat proxy: Icons.XXX → Ic.xxx
// Handles PascalCase→camelCase, Trash→del, Send→terminal, Caret prop adapter
export const Icons: Record<string, IconComponent> = new Proxy(Ic as Record<string, IconComponent>, {
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
