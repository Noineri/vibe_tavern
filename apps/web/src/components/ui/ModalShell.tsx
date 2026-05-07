import React from 'react';

interface ModalShellProps {
  children: React.ReactNode;
  onClose: () => void;
  width?: string;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
}

export function ModalShell({ children, onClose, width, title, subtitle, footer }: ModalShellProps) {
  return (
    <div className="fixed inset-0 bg-black/55 z-[500] flex items-center justify-center backdrop-blur-[2px]" onClick={onClose}>
      <div className="bg-surface border border-border2 rounded-xl w-[500px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-60px)] flex flex-col shadow-[0_24px_60px_rgba(0,0,0,.5)] overflow-hidden" style={width ? { width } : undefined} onClick={e => e.stopPropagation()}>
        {(title || subtitle) && (
          <div className="pt-[18px] px-5 shrink-0">
            {title && <div className="font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1 mb-0.5">{title}</div>}
            {subtitle && <div className="text-[calc(var(--ui-fs)-2px)] text-t3 mb-3.5">{subtitle}</div>}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="py-3.5 px-5 border-t border-border flex items-center gap-2.5 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}
