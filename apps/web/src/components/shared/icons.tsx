// Извлечено из rp_platform_plan/Maket.html (Ic object).
// Не править вручную — обновлять из макета.

import type { FC } from "react";

export const SunIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <circle cx="8" cy="8" r="3.2" />
    <line x1="8" y1="1" x2="8" y2="2.8" />
    <line x1="8" y1="13.2" x2="8" y2="15" />
    <line x1="1" y1="8" x2="2.8" y2="8" />
    <line x1="13.2" y1="8" x2="15" y2="8" />
    <line x1="3.2" y1="3.2" x2="4.3" y2="4.3" />
    <line x1="11.7" y1="11.7" x2="12.8" y2="12.8" />
    <line x1="11.7" y1="3.2" x2="12.8" y2="4.3" />
    <line x1="3.2" y1="11.7" x2="4.3" y2="12.8" />
  </svg>
);

export const MoonIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M13 10.5A6.5 6.5 0 0 1 5.5 3a6.5 6.5 0 1 0 7.5 7.5z" />
  </svg>
);

export const CopyIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="5" y="5" width="9" height="9" rx="1.5" />
    <path d="M11 5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6.5A1.5 1.5 0 0 0 3 11h2" />
  </svg>
);

export const EditIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M11.5 2.5l2 2L5 13l-2.5.5L3 11z" />
  </svg>
);

export const BranchIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="4" cy="4" r="2" />
    <circle cx="12" cy="4" r="2" />
    <circle cx="4" cy="12" r="2" />
    <path d="M4 6v4" />
    <path d="M12 6v2.5A1.5 1.5 0 0 1 10.5 10H4" />
  </svg>
);

export const RegenIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M13.5 8A5.5 5.5 0 1 1 10 3H13.5" />
    <polyline points="10,3 13.5,3 13.5,6.5" />
  </svg>
);

export const CaretIcon: FC<{ direction?: "l" | "r" | "u" | "d" }> = ({ direction }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    style={{
      transform:
        direction === "l"
          ? "rotate(180deg)"
          : direction === "d"
            ? "rotate(90deg)"
            : direction === "u"
              ? "rotate(270deg)"
              : undefined,
    }}
  >
    <polyline points="6 3 11 8 6 13" />
  </svg>
);

export const SettingsIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M11.54 4.46l1.41-1.41M3.05 12.95l1.41-1.41" />
  </svg>
);

export const MenuIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="10" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
  </svg>
);

export const PlusIcon: FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
    <line x1="8" y1="2" x2="8" y2="14" />
    <line x1="2" y1="8" x2="14" y2="8" />
  </svg>
);

export const ToolIcon: FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.76 3.76l1.06 1.06M11.18 11.18l1.06 1.06M11.18 3.76l1.06 1.06M3.76 11.18l1.06 1.06" />
  </svg>
);

export const DeleteIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="2 4 14 4" />
    <path d="M5 4V2.5h6V4" />
    <rect x="3" y="4" width="10" height="9.5" rx="1" />
    <line x1="6.5" y1="7" x2="6.5" y2="10.5" />
    <line x1="9.5" y1="7" x2="9.5" y2="10.5" />
  </svg>
);

export const CloseIcon: FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
    <line x1="3" y1="3" x2="13" y2="13" />
    <line x1="13" y1="3" x2="3" y2="13" />
  </svg>
);

export const WrenchIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M10 2a4 4 0 0 0-3.9 4.8L2 11a1.5 1.5 0 0 0 0 2.1l.9.9A1.5 1.5 0 0 0 5 14l4.2-4.1A4 4 0 1 0 10 2z" />
  </svg>
);

export const KeyIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="6" cy="7" r="3.5" />
    <line x1="8.5" y1="9.5" x2="14" y2="15" />
    <line x1="11" y1="12" x2="13" y2="14" />
  </svg>
);

export const SlidersIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1="2" y1="8" x2="14" y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
    <circle cx="5" cy="4" r="1.8" fill="var(--bg)" strokeWidth="1.5" />
    <circle cx="10" cy="8" r="1.8" fill="var(--bg)" strokeWidth="1.5" />
    <circle cx="6" cy="12" r="1.8" fill="var(--bg)" strokeWidth="1.5" />
  </svg>
);

export const CheckIcon: FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="2 8 6 12 14 4" />
  </svg>
);

export const BookIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3" />
    <path d="M3 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1" />
    <line x1="8" y1="2" x2="8" y2="14" />
  </svg>
);

export const UserIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="5.5" r="3" />
    <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" />
  </svg>
);

export const TraceIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="2,12 5,8 8,10 11,5 14,7" />
    <circle cx="14" cy="7" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const TerminalIcon: FC = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polyline points="3,4 7,8 3,12" />
    <line x1="8" y1="12" x2="14" y2="12" />
  </svg>
);

export const SendIcon: FC = TerminalIcon;

export const SearchIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="7" cy="7" r="4.5" />
    <line x1="10.5" y1="10.5" x2="14" y2="14" />
  </svg>
);

export const ImportIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M8 1.5v8" />
    <polyline points="5,6.5 8,9.5 11,6.5" />
    <path d="M2.5 11v2A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
);

export const EllipsisIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" stroke="none">
    <circle cx="3" cy="8" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="13" cy="8" r="1.4" />
  </svg>
);

export const DownloadIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M8 2v8" />
    <polyline points="5,7 8,10 11,7" />
    <line x1="2.5" y1="13.5" x2="13.5" y2="13.5" />
  </svg>
);

export const StackIcon: FC = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <polygon points="8,2 14,5 8,8 2,5" />
    <polyline points="2,8 8,11 14,8" />
    <polyline points="2,11 8,14 14,11" />
  </svg>
);

export const Icons = {
  Sun: SunIcon,
  Moon: MoonIcon,
  Copy: CopyIcon,
  Edit: EditIcon,
  Branch: BranchIcon,
  Regen: RegenIcon,
  Caret: CaretIcon,
  Settings: SettingsIcon,
  Menu: MenuIcon,
  Plus: PlusIcon,
  Tool: ToolIcon,
  Trash: DeleteIcon,
  Close: CloseIcon,
  Wrench: WrenchIcon,
  Key: KeyIcon,
  Sliders: SlidersIcon,
  Check: CheckIcon,
  Book: BookIcon,
  User: UserIcon,
  Trace: TraceIcon,
  Terminal: TerminalIcon,
  Send: SendIcon,
  Search: SearchIcon,
  Import: ImportIcon,
  Ellipsis: EllipsisIcon,
  Download: DownloadIcon,
  Stack: StackIcon,
} as const;
