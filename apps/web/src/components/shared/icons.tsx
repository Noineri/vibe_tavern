import React from 'react';

/**
 * A library of SVG icons extracted from the Chat.html prototype.
 * All icons inherit currentColor and can be sized via parent font-size or CSS.
 */

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

export const Icons = {
  Sun: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
      <circle cx="8" cy="8" r="3.2"/><line x1="8" y1="1" x2="8" y2="2.8"/><line x1="8" y1="13.2" x2="8" y2="15"/><line x1="1" y1="8" x2="2.8" y2="8"/><line x1="13.2" y1="8" x2="15" y2="8"/><line x1="3.2" y1="3.2" x2="4.3" y2="4.3"/><line x1="11.7" y1="11.7" x2="12.8" y2="12.8"/><line x1="11.7" y1="3.2" x2="12.8" y2="4.3"/><line x1="3.2" y1="11.7" x2="4.3" y2="12.8"/>
    </svg>
  ),

  Moon: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" {...props}>
      <path d="M13 10.5A6.5 6.5 0 0 1 5.5 3a6.5 6.5 0 1 0 7.5 7.5z"/>
    </svg>
  ),

  Copy: (props: IconProps) => (
    <svg width={props.size ?? "11"} height={props.size ?? "11"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6.5A1.5 1.5 0 0 0 3 11h2"/>
    </svg>
  ),

  Edit: (props: IconProps) => (
    <svg width={props.size ?? "11"} height={props.size ?? "11"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M11.5 2.5l2 2L5 13l-2.5.5L3 11z"/>
    </svg>
  ),

  Branch: (props: IconProps) => (
    <svg width={props.size ?? "11"} height={props.size ?? "11"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M4 6v4"/><path d="M12 6v2.5A1.5 1.5 0 0 1 10.5 10H4"/>
    </svg>
  ),

  Regen: (props: IconProps) => (
    <svg width={props.size ?? "11"} height={props.size ?? "11"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M13.5 8A5.5 5.5 0 1 1 10 3H13.5"/><polyline points="10,3 13.5,3 13.5,6.5"/>
    </svg>
  ),

  Caret: (props: IconProps & { direction?: 'l' | 'r' | 'u' | 'd' }) => {
    const rotation = {
      l: 'rotate(180deg)',
      r: 'rotate(0deg)',
      u: 'rotate(270deg)',
      d: 'rotate(90deg)'
    }[props.direction ?? 'r'];

    return (
      <svg width={props.size ?? "9"} height={props.size ?? "9"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" style={{ transform: rotation, ...props.style }} {...props}>
        <polyline points="6 3 11 8 6 13"/>
      </svg>
    );
  },

  Settings: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M11.54 4.46l1.41-1.41M3.05 12.95l1.41-1.41"/>
    </svg>
  ),

  Send: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M14 2 2.5 7.1c-.7.3-.7 1.3 0 1.6L7 10.3l1.6 4.5c.3.7 1.3.7 1.6 0L14 2Z"/>
      <path d="M7 10.3 14 2"/>
    </svg>
  ),

  Menu: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="10" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/>
    </svg>
  ),

  Plus: (props: IconProps) => (
    <svg width={props.size ?? "12"} height={props.size ?? "12"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/>
    </svg>
  ),

  Tool: (props: IconProps) => (
    <svg width={props.size ?? "10"} height={props.size ?? "10"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="8" r="2.5"/><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.76 3.76l1.06 1.06M11.18 11.18l1.06 1.06M11.18 3.76l1.06 1.06M3.76 11.18l1.06 1.06"/>
    </svg>
  ),

  Trash: (props: IconProps) => (
    <svg width={props.size ?? "11"} height={props.size ?? "11"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <polyline points="2 4 14 4"/><path d="M5 4V2.5h6V4"/><rect x="3" y="4" width="10" height="9.5" rx="1"/><line x1="6.5" y1="7" x2="6.5" y2="10.5"/><line x1="9.5" y1="7" x2="9.5" y2="10.5"/>
    </svg>
  ),

  Close: (props: IconProps) => (
    <svg width={props.size ?? "12"} height={props.size ?? "12"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/>
    </svg>
  ),

  Wrench: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M10 2a4 4 0 0 0-3.9 4.8L2 11a1.5 1.5 0 0 0 0 2.1l.9.9A1.5 1.5 0 0 0 5 14l4.2-4.1A4 4 1 0 10 10 2z"/>
    </svg>
  ),

  Book: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M3 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3"/><path d="M3 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1"/><line x1="8" y1="2" x2="8" y2="14"/>
    </svg>
  ),

  User: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <circle cx="8" cy="5.5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/>
    </svg>
  ),

  Trace: (props: IconProps) => (
    <svg width={props.size ?? "13"} height={props.size ?? "13"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <polyline points="2,12 5,8 8,10 11,5 14,7"/><circle cx="14" cy="7" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  ),
};
